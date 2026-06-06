import {
	minorToMajorUnits,
	type PaymentResult,
	type WebhookEvent,
} from '@aquarian-metals/coin-moebius-core';
import Stripe from 'stripe';

export interface StripeVerifierConfig {
	/** Stripe webhook signing secret (the `whsec_…` value from your dashboard). */
	endpointSecret: string;
	/**
	 * Your Stripe secret key (`sk_live_…` / `sk_test_…`). Optional — webhook
	 * signature verification works without it, but providing it lets the same
	 * `Stripe` instance be reused for refunds, retrievals, etc., and avoids
	 * relying on the SDK accepting placeholder keys.
	 */
	secretKey?: string;
	/**
	 * Pin the Stripe API version. Defaults to the version this package was
	 * tested against (an internal `DEFAULT_API_VERSION` constant in this file).
	 *
	 * **Version bumping policy:** we update the default on a deliberate
	 * quarterly cadence. We don't auto-bump via Renovate or dependabot —
	 * Stripe API version changes can have subtle behavior differences
	 * (especially around `payment_intent` status semantics), so each bump
	 * gets a manual review against the Stripe upgrade guide before shipping.
	 * If you've upgraded the `stripe` SDK in your own project and need a
	 * different version, pass it here to override.
	 */
	apiVersion?: string;
}

/**
 * The Stripe API version this package is tested against. Bumped on a
 * deliberate cadence after reviewing Stripe's upgrade guide. See
 * {@link StripeVerifierConfig.apiVersion} for the override option.
 *
 * The literal is a plain string (not pinned to `Stripe.LatestApiVersion`)
 * because Stripe's stable npm SDK pins that type to its own release-time
 * literal, which lags Stripe's actual latest API version. The SDK runtime
 * accepts any version string and Stripe maintains backward compatibility,
 * so we pin to the actually-current dashboard-displayed version.
 */
const DEFAULT_API_VERSION = '2026-04-22.dahlia';

export function createStripeVerifier(config: StripeVerifierConfig) {
	// Webhooks.constructEvent only uses the endpointSecret — the API key on the
	// instance is never consulted for that call. We accept a placeholder when no
	// real key is supplied so callers using this purely for verification don't
	// have to thread their secret key through.
	// Cast to the SDK's narrowly-typed apiVersion literal. The public
	// StripeVerifierConfig.apiVersion is `string` because Stripe's actual
	// latest API version usually leads the SDK's typed literal by a few
	// weeks — we don't want users to be unable to set the dahlia version
	// just because the installed stripe package was released the month
	// before. Stripe's runtime accepts any valid version string.
	type StripeConstructorApiVersion = NonNullable<
		NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']
	>;
	const stripe = new Stripe(config.secretKey ?? 'sk_unused_for_webhook_verification_only', {
		apiVersion: (config.apiVersion ?? DEFAULT_API_VERSION) as StripeConstructorApiVersion,
	});

	return async function verifyStripeWebhook(
		rawBody: unknown,
		headers: unknown,
	): Promise<WebhookEvent | null> {
		const headerRecord = (headers ?? {}) as Record<string, string | undefined>;
		const signature = headerRecord['stripe-signature'] ?? headerRecord['Stripe-Signature'];

		if (!signature) {
			throw new Error('coin-moebius/stripe: missing stripe-signature header');
		}

		let event: Stripe.Event;
		try {
			event = await stripe.webhooks.constructEventAsync(
				rawBody as string | Buffer,
				signature,
				config.endpointSecret,
			);
		} catch (err) {
			throw new Error(
				`coin-moebius/stripe: invalid signature – ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Three event families this verifier surfaces:
		//
		//   1. `checkout.session.completed` — the canonical Checkout-mode
		//      success/pending. The result's `paymentId` is set to the
		//      PaymentIntent id (NOT the Session id) so subsequent
		//      `charge.refunded` and `charge.dispute.created` events can be
		//      linked back to the same logical transaction by id.
		//
		//   2. `charge.refunded` — full or partial refund of a previous
		//      payment. Status = 'refunded'; `amount` is the refunded amount
		//      (not the original payment total) so consumers can detect
		//      partial refunds. `paymentId` mirrors (1) for matching.
		//
		//   3. `charge.dispute.created` — chargeback opened. Status =
		//      'disputed'; `paymentId` again mirrors (1) for matching.
		//
		// Any other signed event resolves to `null` so consumers can skip
		// non-payment events without polluting their transaction store.

		if (event.type === 'checkout.session.completed') {
			const session = event.data.object;
			// Subscription-mode checkouts arrive here too, but the first-payment
			// signal is canonicalized through `customer.subscription.created`
			// and `invoice.payment_succeeded`. Skip subscription-mode sessions
			// to avoid double-counting and let the subscription handlers below
			// emit the normalized signup event.
			if (session.mode === 'subscription') return null;
			const status: PaymentResult['status'] =
				session.payment_status === 'paid' || session.status === 'complete' ? 'success' : 'pending';
			const paymentIntentId = readStringField(session, 'payment_intent');
			return {
				kind: 'payment',
				status,
				// Prefer the PaymentIntent id for cross-event linking. Sessions
				// without a payment_intent (e.g., setup-mode) fall back to the
				// session id; v1 doesn't use setup-mode but the fallback keeps
				// the contract total.
				paymentId: paymentIntentId ?? session.id,
				provider: 'stripe',
				amount: minorToMajorUnits(session.amount_total ?? 0, session.currency ?? 'usd'),
				currency: (session.currency ?? 'usd').toUpperCase(),
				metadata: {
					...(session.metadata ?? {}),
					email: session.customer_details?.email ?? session.customer_email,
				},
				timestamp: Date.now(),
				raw: event,
			};
		}

		if (event.type === 'charge.refunded') {
			const charge = event.data.object;
			const paymentIntentId =
				typeof charge.payment_intent === 'string'
					? charge.payment_intent
					: charge.payment_intent?.id;
			if (!paymentIntentId) return null;
			// Refund amount: prefer `amount_refunded` (cumulative refunded
			// across all refunds on this charge) so a follow-up partial refund
			// reports the running total, not just the most recent slice.
			const refundedAmount = charge.amount_refunded ?? charge.amount ?? 0;
			return {
				kind: 'payment',
				status: 'refunded',
				paymentId: paymentIntentId,
				provider: 'stripe',
				amount: minorToMajorUnits(refundedAmount, charge.currency ?? 'usd'),
				currency: (charge.currency ?? 'usd').toUpperCase(),
				metadata: {
					originalChargeId: charge.id,
					originalAmount: minorToMajorUnits(charge.amount ?? 0, charge.currency ?? 'usd'),
				},
				timestamp: Date.now(),
				raw: event,
			};
		}

		if (event.type === 'charge.dispute.created') {
			const dispute = event.data.object;
			const paymentIntentId =
				typeof dispute.payment_intent === 'string'
					? dispute.payment_intent
					: dispute.payment_intent?.id;
			if (!paymentIntentId) return null;
			return {
				kind: 'payment',
				status: 'disputed',
				paymentId: paymentIntentId,
				provider: 'stripe',
				// The disputed amount may differ from the original payment if
				// the buyer disputes only part of it. Default to the dispute's
				// reported amount, fall back to the original charge amount.
				amount: minorToMajorUnits(dispute.amount ?? 0, dispute.currency ?? 'usd'),
				currency: (dispute.currency ?? 'usd').toUpperCase(),
				metadata: {
					disputeId: dispute.id,
					reason: dispute.reason,
					originalChargeId:
						typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id,
				},
				timestamp: Date.now(),
				raw: event,
			};
		}

		// Subscription event family. Stripe emits these for products in
		// `mode: 'subscription'`. We normalize the five most useful events
		// onto the cross-provider `SubscriptionEvent` shape and ignore the
		// rest (e.g., `invoice.created`, `invoice.finalized` — informational
		// only and would just noise up the merchant's webhook stream).
		//
		//   - `customer.subscription.created` → `subscription.created`
		//     (signup; carries the first billing amount). Status is mapped
		//     from Stripe's `subscription.status` (`active`/`trialing` →
		//     `active`, etc.).
		//
		//   - `invoice.payment_succeeded` → `subscription.renewed` for cycles
		//     other than the first (`billing_reason === 'subscription_cycle'`).
		//     The first cycle invoice (`subscription_create`) is intentionally
		//     ignored here so the signup is reported exactly once via
		//     `customer.subscription.created`.
		//
		//   - `invoice.payment_failed` → `subscription.payment_failed`. The
		//     provider's dunning will retry on its configured schedule; this
		//     event is informational.
		//
		//   - `customer.subscription.updated` → `subscription.updated`.
		//     Inspect `status` for the new normalized state.
		//
		//   - `customer.subscription.deleted` → `subscription.canceled`.
		//     Terminal.

		if (event.type === 'customer.subscription.created') {
			return toSubscriptionEvent(event, 'subscription.created');
		}

		if (event.type === 'customer.subscription.updated') {
			return toSubscriptionEvent(event, 'subscription.updated');
		}

		if (event.type === 'customer.subscription.deleted') {
			return toSubscriptionEvent(event, 'subscription.canceled');
		}

		if (event.type === 'invoice.payment_succeeded') {
			const invoice = event.data.object;
			if (readStringField(invoice, 'subscription')) {
				// Subscription invoice. Skip the first cycle — `subscription.created`
				// already reported the signup. Only emit `subscription.renewed` for
				// follow-on cycles.
				if (invoice.billing_reason !== 'subscription_cycle') return null;
				return toSubscriptionEventFromInvoice(event, 'subscription.renewed');
			}
			// One-off / manual invoice not tied to a subscription (e.g. an
			// out-of-band charge billed to a customer). Surface the paid signal as
			// a normalized payment so consumers can react instead of dropping it.
			return toPaymentFromInvoice(event);
		}

		if (event.type === 'invoice.payment_failed') {
			return toSubscriptionEventFromInvoice(event, 'subscription.payment_failed');
		}

		return null;
	};
}

/**
 * Map Stripe's `Subscription.status` onto our neutral `SubscriptionStatus`
 * union. Stripe-specific reasons (`incomplete_expired`, `unpaid`) flatten
 * to `past_due` or `canceled` rather than leaking back into our surface.
 */
function mapSubscriptionStatus(
	status: Stripe.Subscription.Status,
): 'active' | 'past_due' | 'canceled' | 'paused' | 'unknown' {
	switch (status) {
		case 'active':
		case 'trialing':
			return 'active';
		case 'past_due':
		case 'unpaid':
			return 'past_due';
		case 'canceled':
		case 'incomplete_expired':
			return 'canceled';
		case 'paused':
			return 'paused';
		default:
			return 'unknown';
	}
}

function toSubscriptionEvent(
	event: Stripe.Event & { type: `customer.subscription.${string}` },
	type: 'subscription.created' | 'subscription.updated' | 'subscription.canceled',
): WebhookEvent {
	const sub = event.data.object;
	const item = sub.items.data[0];
	const price = item?.price;
	const productId =
		readStringField(price, 'product') ??
		(typeof sub.metadata?.productId === 'string' ? sub.metadata.productId : null);
	const customerRef = typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null);
	const unitAmount = price?.unit_amount ?? 0;
	const currency = (price?.currency ?? 'usd').toUpperCase();
	return {
		kind: 'subscription',
		type,
		subscriptionId: sub.id,
		provider: 'stripe',
		productId,
		customerRef,
		status: mapSubscriptionStatus(sub.status),
		currentPeriodEnd: readSubscriptionCurrentPeriodEnd(sub),
		amount: minorToMajorUnits(unitAmount, currency),
		currency,
		metadata: {
			stripeStatus: sub.status,
			cancelAtPeriodEnd: sub.cancel_at_period_end,
			priceId: readStringField(price, 'id') ?? null,
			...(sub.metadata ?? {}),
		},
		timestamp: Date.now(),
		raw: event,
	};
}

function toSubscriptionEventFromInvoice(
	event: Stripe.Event & { type: 'invoice.payment_succeeded' | 'invoice.payment_failed' },
	type: 'subscription.renewed' | 'subscription.payment_failed',
): WebhookEvent | null {
	const invoice = event.data.object;
	const subscriptionId = readStringField(invoice, 'subscription');
	if (!subscriptionId) return null;
	const customerRef =
		typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer?.id ?? null);
	// Older Stripe SDK types put `price` on InvoiceLineItem; newer ones expose
	// it only through `pricing.price_details.product`. Read either via the
	// type-erasing `readStringField` walker so we stay compatible across SDK
	// versions without coupling to a specific revision.
	const line = invoice.lines?.data?.[0] as unknown as Record<string, unknown> | undefined;
	const productId =
		readStringField(line?.price, 'product') ??
		readStringField(
			(line as { pricing?: { price_details?: unknown } } | undefined)?.pricing?.price_details,
			'product',
		) ??
		null;
	const currency = (invoice.currency ?? 'usd').toUpperCase();
	const status: 'active' | 'past_due' = type === 'subscription.renewed' ? 'active' : 'past_due';
	return {
		kind: 'subscription',
		type,
		subscriptionId,
		provider: 'stripe',
		productId,
		customerRef,
		status,
		currentPeriodEnd: invoice.period_end ?? null,
		amount: minorToMajorUnits(
			invoice.amount_paid ?? invoice.amount_due ?? 0,
			invoice.currency ?? 'usd',
		),
		currency,
		metadata: {
			invoiceId: invoice.id,
			billingReason: invoice.billing_reason,
			priceId: readInvoicePriceId(line),
			...(invoice.metadata ?? {}),
		},
		timestamp: Date.now(),
		raw: event,
	};
}

/**
 * Normalize a paid one-off / manual invoice (no subscription) into a payment
 * event. Carries the invoice id, billing reason, price id, and the invoice's
 * own metadata so consumers can route it (e.g. an app billing an out-of-band
 * charge and tagging it in invoice metadata).
 */
function toPaymentFromInvoice(
	event: Stripe.Event & { type: 'invoice.payment_succeeded' },
): WebhookEvent {
	const invoice = event.data.object;
	const line = invoice.lines?.data?.[0] as unknown as Record<string, unknown> | undefined;
	return {
		kind: 'payment',
		status: 'success',
		// Standalone invoices have no reliable PaymentIntent across versions;
		// the invoice id is the stable cross-event handle.
		paymentId: invoice.id ?? '',
		provider: 'stripe',
		amount: minorToMajorUnits(
			invoice.amount_paid ?? invoice.amount_due ?? 0,
			invoice.currency ?? 'usd',
		),
		currency: (invoice.currency ?? 'usd').toUpperCase(),
		metadata: {
			invoiceId: invoice.id,
			billingReason: invoice.billing_reason,
			priceId: readInvoicePriceId(line),
			...(invoice.metadata ?? {}),
		},
		timestamp: Date.now(),
		raw: event,
	};
}

/**
 * Pull the price id off an invoice line item. Older Stripe types expose
 * `line.price.id`; newer ones move it to `line.pricing.price_details.price`.
 */
function readInvoicePriceId(line: Record<string, unknown> | undefined): string | null {
	return (
		readStringField(line?.price, 'id') ??
		readStringField(
			(line as { pricing?: { price_details?: unknown } } | undefined)?.pricing?.price_details,
			'price',
		) ??
		null
	);
}

/**
 * Read `current_period_end` from a Stripe subscription. The field's typed
 * position has shifted across the SDK's history (top-level pre-2024, then
 * inside `items.data[0]` for some intermediate versions, then back to
 * top-level on the current API version we pin). Read both shapes so the
 * verifier survives Stripe SDK version drift without leaking that drift
 * back to consumers.
 */
function readSubscriptionCurrentPeriodEnd(sub: Stripe.Subscription): number | null {
	const topLevel = (sub as unknown as { current_period_end?: number }).current_period_end;
	if (typeof topLevel === 'number') return topLevel;
	const fromItem = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
	if (fromItem && typeof fromItem.current_period_end === 'number')
		return fromItem.current_period_end;
	return null;
}

/**
 * Read a string field from a typed Stripe event-object property where the
 * value may also be an expanded sub-object (Stripe expands fields when an
 * API caller requests it). We only need the id; this normalizes the union.
 *
 * Accepts `unknown` so callers can pass typed Stripe objects (like
 * `Stripe.Checkout.Session`) without casting through `Record<string, unknown>`
 * — Stripe 22's resource types are class-shaped and aren't assignable to a
 * plain record. We do the runtime narrowing here.
 */
function readStringField(obj: unknown, key: string): string | undefined {
	if (typeof obj !== 'object' || obj === null) return undefined;
	const value = (obj as Record<string, unknown>)[key];
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && 'id' in value && typeof value.id === 'string') {
		return value.id;
	}
	return undefined;
}

/**
 * Create a Stripe-hosted Customer Portal session and return its URL. The
 * buyer manages their subscription (cancel, change card, view receipts)
 * inside Stripe's UI; we never see card details, and we never need to host
 * a portal page ourselves.
 *
 * The merchant must have the Customer Portal configured once in their
 * Stripe dashboard. Stripe's API throws a clear error when it isn't.
 *
 * Pass the buyer's `customerId` (Stripe's `cus_…` id; carry it forward from
 * the `customerRef` on a previous subscription event) and a `returnUrl`
 * the buyer lands on after closing the portal.
 */
export async function getStripePortalUrl(opts: {
	secretKey: string;
	customerId: string;
	returnUrl: string;
	apiVersion?: string;
}): Promise<string> {
	type StripeConstructorApiVersion = NonNullable<
		NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion']
	>;
	const stripe = new Stripe(opts.secretKey, {
		apiVersion: (opts.apiVersion ?? DEFAULT_API_VERSION) as StripeConstructorApiVersion,
	});
	const session = await stripe.billingPortal.sessions.create({
		customer: opts.customerId,
		return_url: opts.returnUrl,
	});
	return session.url;
}
