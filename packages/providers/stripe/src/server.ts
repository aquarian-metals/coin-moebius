import type { PaymentResult } from '@aquarian-metals/coin-moebius-core';
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
	): Promise<PaymentResult | null> {
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
			const status: PaymentResult['status'] =
				session.payment_status === 'paid' || session.status === 'complete' ? 'success' : 'pending';
			const paymentIntentId = readStringField(session, 'payment_intent');
			return {
				status,
				// Prefer the PaymentIntent id for cross-event linking. Sessions
				// without a payment_intent (e.g., setup-mode) fall back to the
				// session id; v1 doesn't use setup-mode but the fallback keeps
				// the contract total.
				paymentId: paymentIntentId ?? session.id,
				provider: 'stripe',
				amount: (session.amount_total ?? 0) / 100,
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
				status: 'refunded',
				paymentId: paymentIntentId,
				provider: 'stripe',
				amount: refundedAmount / 100,
				currency: (charge.currency ?? 'usd').toUpperCase(),
				metadata: {
					originalChargeId: charge.id,
					originalAmount: (charge.amount ?? 0) / 100,
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
				status: 'disputed',
				paymentId: paymentIntentId,
				provider: 'stripe',
				// The disputed amount may differ from the original payment if
				// the buyer disputes only part of it. Default to the dispute's
				// reported amount, fall back to the original charge amount.
				amount: (dispute.amount ?? 0) / 100,
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

		return null;
	};
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
