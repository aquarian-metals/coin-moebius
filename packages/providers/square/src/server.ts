/**
 * Square server-side webhook verifier. Implements Square's HMAC-SHA256
 * signature scheme as documented at
 * <https://developer.squareup.com/docs/webhooks/step3validate>:
 *
 *   X-Square-HmacSha256-Signature: <base64(HMAC-SHA256(notificationUrl + rawBody, signatureKey))>
 *
 * The signature is computed over the **concatenation of the notification
 * URL and the raw body**, with no separator. The `notificationUrl` must
 * exactly match the URL the merchant configured on their webhook
 * subscription in Square's Developer Console. The verifier accepts it as
 * a required config field because workers running behind a reverse proxy
 * or Cloudflare typically can't recover the original public URL from the
 * inbound request.
 *
 * The signature key is **subscription-specific**, generated in Square's
 * Developer Console alongside the subscription. It is not the same as the
 * application's access token. Rotate by recreating the subscription.
 *
 * Status mapping. `null` results mean the event was signature-verified but
 * does not map to a payment-status change consumers should record.
 *
 *   payment.created                              → pending
 *   payment.updated  (status COMPLETED)          → success
 *   payment.updated  (status APPROVED)           → pending (auth-only)
 *   payment.updated  (status FAILED  or CANCELED) → failed
 *   refund.created                               → pending
 *   refund.updated   (status COMPLETED)          → refunded
 *   refund.updated   (status FAILED)             → failed
 *   dispute.created                              → disputed
 *   dispute.state.updated                        → disputed
 *   anything else                                → null
 *
 * **Known gap:** Square's signature scheme has no timestamp component, so
 * the verifier cannot enforce a replay window. Merchants who care about
 * replay protection should deduplicate at the application layer using the
 * webhook's `event_id` field. Documented in the README.
 */

import {
	minorToMajorUnits,
	type PaymentResult,
	type WebhookEvent,
} from '@aquarian-metals/coin-moebius-core';

export interface SquareVerifierConfig {
	/**
	 * The subscription's signature key from Square's Developer Console
	 * (Webhooks → your subscription → Signature key).
	 */
	signatureKey: string;
	/**
	 * The exact notification URL configured on the Square webhook
	 * subscription. Must match byte-for-byte (including scheme, host, port,
	 * path, and any trailing slash) — Square HMACs over `notificationUrl +
	 * rawBody`, so a mismatch produces silent signature failure.
	 */
	notificationUrl: string;
}

export interface WebhookVerifier {
	verify(
		rawBody: unknown,
		headers: Record<string, string | undefined>,
	): Promise<WebhookEvent | null>;
}

export function createSquareVerifier(config: SquareVerifierConfig): WebhookVerifier {
	return {
		async verify(rawBody, headers): Promise<WebhookEvent | null> {
			if (!config.signatureKey) {
				throw new Error('coin-moebius/square: signatureKey missing on verifier config');
			}
			if (!config.notificationUrl) {
				throw new Error('coin-moebius/square: notificationUrl missing on verifier config');
			}

			const signatureHeader = headerValue(headers, 'x-square-hmacsha256-signature');
			if (!signatureHeader) {
				throw new Error('coin-moebius/square: missing x-square-hmacsha256-signature header');
			}

			const bodyBytes = bodyToBytes(rawBody);
			const expected = await computeSquareSignature(
				config.notificationUrl,
				bodyBytes,
				config.signatureKey,
			);

			if (!timingSafeStringEqual(expected, signatureHeader.trim())) {
				throw new Error('coin-moebius/square: invalid signature');
			}

			const bodyString = new TextDecoder().decode(bodyBytes);
			let parsed: SquareWebhookEvent;
			try {
				parsed = JSON.parse(bodyString) as SquareWebhookEvent;
			} catch {
				throw new Error('coin-moebius/square: body is not valid JSON');
			}

			return toPaymentResult(parsed);
		},
	};
}

/**
 * Base64-encoded HMAC-SHA256 of `notificationUrl + rawBody`, keyed by the
 * subscription's signature key. Exported so callers with non-standard
 * rawBody pipelines can verify with the same routine without going through
 * the full registry path.
 */
export async function computeSquareSignature(
	notificationUrl: string,
	rawBody: Uint8Array,
	signatureKey: string,
): Promise<string> {
	const urlBytes = new TextEncoder().encode(notificationUrl);
	const message = new Uint8Array(urlBytes.length + rawBody.length);
	message.set(urlBytes, 0);
	message.set(rawBody, urlBytes.length);

	const keyBytes = new TextEncoder().encode(signatureKey);
	const key = await crypto.subtle.importKey(
		'raw',
		keyBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, message);
	return toBase64(new Uint8Array(sigBuf));
}

// --- event → PaymentResult -------------------------------------------------

interface SquareMoney {
	amount?: number;
	currency?: string;
}

interface SquarePaymentObject {
	id?: string;
	status?: string; // APPROVED, COMPLETED, FAILED, CANCELED
	amount_money?: SquareMoney;
	order_id?: string;
	[key: string]: unknown;
}

interface SquareRefundObject {
	id?: string;
	status?: string; // PENDING, COMPLETED, REJECTED, FAILED
	amount_money?: SquareMoney;
	payment_id?: string;
	[key: string]: unknown;
}

interface SquareDisputeObject {
	id?: string;
	state?: string;
	amount_money?: SquareMoney;
	disputed_payment?: { payment_id?: string };
	[key: string]: unknown;
}

interface SquareDataObject {
	id?: string;
	type?: string;
	object?: {
		payment?: SquarePaymentObject;
		refund?: SquareRefundObject;
		dispute?: SquareDisputeObject;
	};
}

interface SquareWebhookEvent {
	merchant_id?: string;
	type?: string;
	event_id?: string;
	created_at?: string;
	data?: SquareDataObject;
	[key: string]: unknown;
}

function toPaymentResult(event: SquareWebhookEvent): WebhookEvent | null {
	const eventType = event.type ?? '';

	// Subscription lifecycle events take precedence over the one-time
	// payment mapping. Square emits separate top-level event types for
	// subscriptions (no overlap with payment events), so the dispatch is
	// straightforward.
	const subscriptionEvent = toSubscriptionEvent(event, eventType);
	if (subscriptionEvent) return subscriptionEvent;

	const data = event.data?.object ?? {};
	const payment = data.payment;
	const refund = data.refund;
	const dispute = data.dispute;

	const status = mapEvent(eventType, payment, refund);
	if (status === null) return null;

	const { paymentId, amount, currency } = readDetails(eventType, payment, refund, dispute);

	return {
		kind: 'payment',
		status,
		paymentId,
		provider: 'square',
		amount,
		currency,
		metadata: {
			squareEventType: eventType,
			squareEventId: event.event_id,
			squarePaymentStatus: payment?.status,
			squareRefundStatus: refund?.status,
			squareDisputeState: dispute?.state,
		},
		timestamp: Date.now(),
		raw: event,
	};
}

/**
 * Square subscription event shape. Square sends events with the
 * subscription nested under `data.object.subscription`.
 */
interface SquareSubscriptionObject {
	id?: string;
	status?: string; // ACTIVE, CANCELED, DEACTIVATED, PAUSED, PENDING
	plan_id?: string;
	plan_variation_id?: string;
	customer_id?: string;
	location_id?: string;
	charged_through_date?: string; // YYYY-MM-DD
	source?: { name?: string };
	[key: string]: unknown;
}

interface SquareInvoiceObject {
	id?: string;
	subscription_id?: string;
	status?: string;
	payment_requests?: { computed_amount_money?: SquareMoney }[];
	[key: string]: unknown;
}

/**
 * Map Square subscription event types onto our normalized
 * `SubscriptionEvent`. Returns `null` for any other event so the caller
 * falls through to the payment-event path.
 *
 *   subscription.created                            → subscription.created
 *   invoice.payment_made (subscription-linked)      → subscription.renewed
 *   invoice.scheduled_charge_failed                 → subscription.payment_failed
 *   subscription.updated                            → subscription.updated
 *   subscription.canceled                           → subscription.canceled
 */
function toSubscriptionEvent(event: SquareWebhookEvent, eventType: string): WebhookEvent | null {
	const innerObject = (event.data?.object ?? {}) as {
		subscription?: SquareSubscriptionObject;
		invoice?: SquareInvoiceObject;
	};

	let subscriptionType:
		| 'subscription.created'
		| 'subscription.renewed'
		| 'subscription.payment_failed'
		| 'subscription.canceled'
		| 'subscription.updated'
		| null = null;

	switch (eventType) {
		case 'subscription.created':
			subscriptionType = 'subscription.created';
			break;
		case 'subscription.updated':
			subscriptionType = 'subscription.updated';
			break;
		case 'subscription.canceled':
		case 'subscription.deactivated':
			subscriptionType = 'subscription.canceled';
			break;
		case 'invoice.payment_made':
			if (innerObject.invoice?.subscription_id) subscriptionType = 'subscription.renewed';
			break;
		case 'invoice.scheduled_charge_failed':
			if (innerObject.invoice?.subscription_id) subscriptionType = 'subscription.payment_failed';
			break;
		default:
			return null;
	}
	if (subscriptionType === null) return null;

	const subscription = innerObject.subscription;
	const invoice = innerObject.invoice;
	const subscriptionId = subscription?.id ?? invoice?.subscription_id ?? '';
	if (!subscriptionId) return null;

	const status = mapSquareSubscriptionStatus(eventType, subscription?.status);
	const { amount, currency } = readSquareSubscriptionAmount(invoice);
	const charged = subscription?.charged_through_date;
	// Square's `charged_through_date` is a calendar date (`YYYY-MM-DD`).
	// Treat it as midnight UTC of the day AFTER, since that's when the
	// next renewal becomes due.
	const currentPeriodEnd = parseChargedThroughDate(charged);

	return {
		kind: 'subscription',
		type: subscriptionType,
		subscriptionId,
		provider: 'square',
		productId:
			typeof subscription?.plan_variation_id === 'string'
				? subscription.plan_variation_id
				: typeof subscription?.plan_id === 'string'
					? subscription.plan_id
					: null,
		customerRef: typeof subscription?.customer_id === 'string' ? subscription.customer_id : null,
		status,
		currentPeriodEnd,
		amount,
		currency,
		metadata: {
			squareEventType: eventType,
			squareEventId: event.event_id,
		},
		timestamp: Date.now(),
		raw: event,
	};
}

function mapSquareSubscriptionStatus(
	eventType: string,
	rawStatus: string | undefined,
): 'active' | 'past_due' | 'canceled' | 'paused' | 'unknown' {
	if (eventType === 'subscription.canceled' || eventType === 'subscription.deactivated') {
		return 'canceled';
	}
	if (eventType === 'invoice.scheduled_charge_failed') return 'past_due';
	switch (rawStatus) {
		case 'ACTIVE':
			return 'active';
		case 'PAUSED':
			return 'paused';
		case 'CANCELED':
		case 'DEACTIVATED':
			return 'canceled';
		default:
			return 'unknown';
	}
}

function readSquareSubscriptionAmount(invoice: SquareInvoiceObject | undefined): {
	amount: number;
	currency: string;
} {
	const money = invoice?.payment_requests?.[0]?.computed_amount_money;
	const cents = money?.amount;
	const currency = (money?.currency ?? 'USD').toUpperCase();
	const amount = typeof cents === 'number' ? minorToMajorUnits(cents, currency) : 0;
	return { amount, currency };
}

function parseChargedThroughDate(value: string | undefined): number | null {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function mapEvent(
	eventType: string,
	payment: SquarePaymentObject | undefined,
	refund: SquareRefundObject | undefined,
): PaymentResult['status'] | null {
	if (eventType === 'payment.created') return 'pending';

	if (eventType === 'payment.updated') {
		const innerStatus = payment?.status;
		if (innerStatus === 'COMPLETED') return 'success';
		if (innerStatus === 'APPROVED') return 'pending';
		if (innerStatus === 'FAILED' || innerStatus === 'CANCELED') return 'failed';
		// Unknown inner status — surface as pending so consumers don't miss
		// it; they can inspect `raw.data.object.payment.status` for detail.
		return 'pending';
	}

	if (eventType === 'refund.created') return 'pending';

	if (eventType === 'refund.updated') {
		const innerStatus = refund?.status;
		if (innerStatus === 'COMPLETED') return 'refunded';
		if (innerStatus === 'FAILED' || innerStatus === 'REJECTED') return 'failed';
		return 'pending';
	}

	if (eventType === 'dispute.created' || eventType === 'dispute.state.updated') {
		return 'disputed';
	}

	return null;
}

function readDetails(
	eventType: string,
	payment: SquarePaymentObject | undefined,
	refund: SquareRefundObject | undefined,
	dispute: SquareDisputeObject | undefined,
): { paymentId: string; amount: number; currency: string } {
	// Prefer the original payment id as the stable correlation key across
	// payment / refund / dispute events on the same purchase.
	const correlationPaymentId =
		payment?.id ?? refund?.payment_id ?? dispute?.disputed_payment?.payment_id ?? '';

	let money: SquareMoney | undefined;
	if (eventType.startsWith('payment.')) {
		money = payment?.amount_money;
	} else if (eventType.startsWith('refund.')) {
		money = refund?.amount_money;
	} else if (eventType.startsWith('dispute.')) {
		money = dispute?.amount_money;
	}

	// Square uses smallest-currency-unit integers (cents for USD, etc.).
	// Convert to a major-unit decimal here to match the rest of the SDK's
	// `amount` semantics (Stripe verifier does the same `/100`).
	const minorAmount = typeof money?.amount === 'number' ? money.amount : 0;
	const currency = (money?.currency ?? 'USD').toUpperCase();
	const amount = minorToMajorUnits(minorAmount, currency);

	return { paymentId: correlationPaymentId, amount, currency };
}

// --- helpers ---------------------------------------------------------------

function bodyToBytes(rawBody: unknown): Uint8Array {
	if (rawBody instanceof Uint8Array) return rawBody;
	if (typeof rawBody === 'string') return new TextEncoder().encode(rawBody);
	if (rawBody && typeof rawBody === 'object') {
		return new TextEncoder().encode(JSON.stringify(rawBody));
	}
	throw new Error('coin-moebius/square: unsupported body type');
}

function headerValue(
	headers: Record<string, string | undefined>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

function timingSafeStringEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/**
 * Square does not expose a buyer-facing customer portal in its
 * Subscriptions API. Buyers don't manage their own subscriptions on the
 * Square side; the merchant cancels from their Square dashboard, and the
 * buyer is notified by email. We surface the merchant-side dashboard URL
 * so the merchant can drill into a specific subscription for support.
 *
 * `mode` toggles between live and sandbox dashboards. Pass the
 * subscription id to deep-link directly into the row when available.
 */
export function getSquarePortalUrl(
	opts: {
		mode?: 'live' | 'sandbox';
		subscriptionId?: string;
	} = {},
): string {
	const base =
		opts.mode === 'sandbox'
			? 'https://app.squareupsandbox.com/dashboard/subscriptions'
			: 'https://squareup.com/dashboard/subscriptions';
	return opts.subscriptionId ? `${base}/${opts.subscriptionId}` : base;
}
