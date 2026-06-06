/**
 * Possible values for `PaymentResult.status`.
 *
 * - `success` — terminal positive state for the original payment.
 * - `pending` — payment is in flight (async confirmations, awaiting clearing, etc.).
 * - `failed` — terminal negative state (declined card, expired auth, hard fail).
 * - `refunded` — money returned to the buyer after a successful payment.
 *   Refunds can be partial — consumers reading `amount` should treat it as
 *   the amount refunded, not the original payment total.
 * - `disputed` — buyer initiated a chargeback / dispute. The funds may still
 *   be in your account at this moment; the provider is signaling the case
 *   exists so you can respond.
 * - `partial` — buyer paid less than the invoiced amount (most common with
 *   crypto invoices where the network sent under the requested value). The
 *   `amount` reflects what was actually received.
 */
export type PaymentStatus = 'success' | 'pending' | 'failed' | 'refunded' | 'disputed' | 'partial';

export interface PaymentResult {
	status: PaymentStatus;
	paymentId: string;
	provider: string;
	amount: number;
	currency: string;
	metadata: Record<string, unknown>;
	timestamp: number;
	raw?: unknown;
}

/**
 * Possible values for `SubscriptionEvent.type`.
 *
 * - `subscription.created` — the buyer's first signup. Carries the first
 *   payment amount; subsequent renewals come as their own events.
 * - `subscription.renewed` — a non-initial billing cycle was paid. Use this
 *   to count successful months, extend buyer access, etc.
 * - `subscription.payment_failed` — a billing cycle failed to charge. The
 *   provider's own dunning will retry on its schedule; this event is
 *   informational, not a request for action.
 * - `subscription.canceled` — the subscription is over (buyer canceled, the
 *   provider canceled after exhausted retries, or the merchant canceled).
 *   Terminal.
 * - `subscription.updated` — anything else: status change (active → paused,
 *   trialing → active), card update, plan change. Inspect `status` to see
 *   the new state.
 */
export type SubscriptionEventType =
	| 'subscription.created'
	| 'subscription.renewed'
	| 'subscription.payment_failed'
	| 'subscription.canceled'
	| 'subscription.updated';

/**
 * Normalized state of a subscription across providers. We keep this small
 * and neutral. Provider-specific reason codes (Stripe's `past_due` cause,
 * PayPal's billing-agreement state, etc.) go into `metadata` untouched.
 */
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'paused' | 'unknown';

export interface SubscriptionEvent {
	type: SubscriptionEventType;
	subscriptionId: string;
	provider: string;
	/** The merchant-facing product reference. `null` when the provider doesn't return it on the event. */
	productId: string | null;
	/** Provider-scoped customer identifier or buyer email. `null` when not present on the event. */
	customerRef: string | null;
	status: SubscriptionStatus;
	/** Unix seconds. `null` if the event doesn't tell us when the next cycle is (e.g., a cancellation). */
	currentPeriodEnd: number | null;
	/** Amount for this event (initial signup amount, this cycle's amount, etc.). */
	amount: number;
	currency: string;
	metadata: Record<string, unknown>;
	timestamp: number;
	raw?: unknown;
}

/**
 * The unified shape returned by every provider's `verify()`. Discriminated
 * by `kind` so consumers can branch:
 *
 * ```ts
 * const event = await verify(rawBody, headers);
 * if (event.kind === 'payment') {
 *   // event is PaymentResult-shaped
 * } else {
 *   // event is SubscriptionEvent-shaped
 * }
 * ```
 *
 * The `kind: 'payment'` variant is structurally identical to the old
 * `PaymentResult` return shape with an added `kind` discriminator, so
 * existing consumers keep type-checking. See `asPayment` / `asSubscription`
 * narrowing helpers in the package root.
 */
export type WebhookEvent =
	| ({ kind: 'payment' } & PaymentResult)
	| ({ kind: 'subscription' } & SubscriptionEvent);

export interface InitiateOptions {
	productId: string;
	amount: number;
	currency: string;
	metadata?: Record<string, unknown>;
	providerId?: string;
}

export interface PaymentProvider {
	id: string;
	name: string;
	icon?: string;

	initiate(
		options: InitiateOptions,
		callbacks: {
			onSuccess: (result: PaymentResult) => void;
			onPending?: (result: PaymentResult) => void;
			onError: (error: Error) => void;
		},
	): void | Promise<void>;
}
