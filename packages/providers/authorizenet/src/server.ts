/**
 * Authorize.Net server-side webhook verifier. Implements Authorize.Net's
 * HMAC-SHA512 signature scheme:
 *
 *   X-ANET-Signature: sha512=<hex>
 *
 *   v1 = HMAC-SHA512(rawBody, signatureKey)   // hex-encoded, case-insensitive
 *
 * The signature key is configured in the Merchant Interface under
 * Account → Settings → Security Settings → General Security Settings →
 * API Credentials and Keys. **It is a separate value from the Transaction
 * Key** used for the Accept Hosted token endpoint.
 *
 * Authorize.Net uses the same signature scheme in sandbox and production,
 * so the verifier has no mode flag — only the signature key matters.
 *
 * **Replay protection:** Authorize.Net does not include a signed timestamp
 * in the webhook delivery. A captured valid payload can be replayed
 * indefinitely. Callers MUST deduplicate by event id (the Cloud worker
 * does this via the `(provider, provider_event_id)` unique constraint).
 *
 * Event mapping. `null` results mean the event was signed-verified but
 * does not correspond to a payment-status change consumers should record.
 *
 *   net.authorize.payment.authorization.created   → pending
 *   net.authorize.payment.authcapture.created     → success
 *   net.authorize.payment.capture.created         → success
 *   net.authorize.payment.priorAuthCapture.created → success
 *   net.authorize.payment.refund.created          → refunded
 *   net.authorize.payment.void.created            → failed
 *   net.authorize.payment.fraud.held              → pending
 *   net.authorize.payment.fraud.approved          → success
 *   net.authorize.payment.fraud.declined          → failed
 *   anything else                                  → null
 */

import type { PaymentResult, WebhookEvent } from '@aquarian-metals/coin-moebius-core';

export interface AuthorizenetVerifierConfig {
	/**
	 * Authorize.Net Signature Key (hex string). Distinct from the
	 * Transaction Key — see the Merchant Interface, Account → Settings →
	 * Security Settings → General Security Settings → API Credentials and Keys.
	 */
	signatureKey: string;
}

export interface WebhookVerifier {
	verify(
		rawBody: unknown,
		headers: Record<string, string | undefined>,
	): Promise<WebhookEvent | null>;
}

export function createAuthorizenetVerifier(config: AuthorizenetVerifierConfig): WebhookVerifier {
	return {
		async verify(rawBody, headers): Promise<WebhookEvent | null> {
			if (!config.signatureKey) {
				throw new Error('coin-moebius/authorizenet: signatureKey missing on verifier config');
			}

			const signatureHeader = headerValue(headers, 'x-anet-signature');
			if (!signatureHeader) {
				throw new Error('coin-moebius/authorizenet: missing x-anet-signature header');
			}

			const providedHex = parseSignatureHeader(signatureHeader);
			const bodyBytes = bodyToBytes(rawBody);
			const expectedHex = await computeAuthorizenetSignature(bodyBytes, config.signatureKey);

			if (!timingSafeStringEqual(expectedHex, providedHex)) {
				throw new Error('coin-moebius/authorizenet: invalid signature');
			}

			const bodyString = new TextDecoder().decode(bodyBytes);
			let parsed: AuthorizenetWebhookPayload;
			try {
				parsed = JSON.parse(bodyString) as AuthorizenetWebhookPayload;
			} catch {
				throw new Error('coin-moebius/authorizenet: body is not valid JSON');
			}
			return toPaymentResult(parsed);
		},
	};
}

/**
 * Strip the `sha512=` prefix if present and lowercase the hex.
 * Authorize.Net's docs show the prefix on the header value; we accept the
 * bare hex too in case a future scheme drops it. Comparison is
 * case-insensitive (we lowercase both sides).
 */
function parseSignatureHeader(header: string): string {
	const trimmed = header.trim();
	const noPrefix = trimmed.toLowerCase().startsWith('sha512=')
		? trimmed.slice('sha512='.length)
		: trimmed;
	return noPrefix.toLowerCase();
}

/**
 * Hex-encoded HMAC-SHA512 of the raw body bytes with the Signature Key.
 * Exported so callers can verify with the same routine without re-importing
 * the verifier internals.
 */
export async function computeAuthorizenetSignature(
	rawBody: Uint8Array,
	signatureKey: string,
): Promise<string> {
	const keyBytes = new TextEncoder().encode(signatureKey);
	const key = await crypto.subtle.importKey(
		'raw',
		keyBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-512' },
		false,
		['sign'],
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, rawBody);
	return toHex(new Uint8Array(sigBuf));
}

// --- event → PaymentResult -------------------------------------------------

interface AuthorizenetPayloadInner {
	id?: string;
	authAmount?: number | string;
	settleAmount?: number | string;
	avsResponse?: string;
	responseCode?: string | number;
	[key: string]: unknown;
}

interface AuthorizenetWebhookPayload {
	notificationId?: string;
	eventType?: string;
	eventDate?: string;
	webhookId?: string;
	payload?: AuthorizenetPayloadInner;
	[key: string]: unknown;
}

function toPaymentResult(envelope: AuthorizenetWebhookPayload): WebhookEvent | null {
	const eventType = envelope.eventType ?? '';

	// Subscription events take precedence over the one-time payment
	// mapping. Authorize.Net's ARB events have a distinct subjects, no
	// overlap with payment event names.
	const subscriptionEvent = toSubscriptionEvent(envelope, eventType);
	if (subscriptionEvent) return subscriptionEvent;

	const status = mapEventType(eventType);
	if (status === null) return null;

	const payload = envelope.payload ?? {};
	const amount = readAmount(payload);
	return {
		kind: 'payment',
		status,
		paymentId: typeof payload.id === 'string' ? payload.id : '',
		provider: 'authorizenet',
		amount,
		// Authorize.Net's webhook payloads do not carry currency on the
		// envelope; merchants configure a single account currency upstream.
		// USD is the dominant case; consumers needing a different account
		// currency can override via metadata or by inspecting `raw`.
		currency: 'USD',
		metadata: {
			authorizenetEventType: eventType,
			authorizenetNotificationId: envelope.notificationId,
			responseCode: payload.responseCode,
			avsResponse: payload.avsResponse,
		},
		timestamp: Date.now(),
		raw: envelope,
	};
}

/**
 * Authorize.Net ARB (Automated Recurring Billing) payload shape.
 * Subscription events nest the relevant fields under `payload`. The
 * concrete shape varies by event type; we read the union of fields the
 * mapping cares about.
 */
interface AuthorizenetArbPayload {
	id?: string; // subscription id
	name?: string;
	amount?: number | string;
	subscriptionId?: string | number;
	customerProfileId?: string | number;
	customerPaymentProfileId?: string | number;
	[key: string]: unknown;
}

/**
 * Map Authorize.Net ARB event types onto the SDK's normalized
 * `SubscriptionEvent`. Returns `null` for any other event so the caller
 * falls through to the payment path.
 *
 *   net.authorize.customer.subscription.created      → subscription.created
 *   net.authorize.payment.authcapture.created
 *     when subscriptionId is set                     → subscription.renewed
 *   net.authorize.customer.subscription.failed       → subscription.payment_failed
 *   net.authorize.customer.subscription.updated      → subscription.updated
 *   net.authorize.customer.subscription.suspended    → subscription.updated (paused)
 *   net.authorize.customer.subscription.cancelled    → subscription.canceled
 *   net.authorize.customer.subscription.expired      → subscription.canceled
 *   net.authorize.customer.subscription.expiring     → subscription.updated
 *   net.authorize.customer.subscription.terminated   → subscription.canceled
 *
 * The renewal path piggybacks on the regular `authcapture.created`
 * payment event: ARB cycles fire as auth-captures with a `subscriptionId`
 * field on the payload. We discriminate by that field so one-time
 * captures fall through to the payment path normally.
 */
function toSubscriptionEvent(
	envelope: AuthorizenetWebhookPayload,
	eventType: string,
): WebhookEvent | null {
	const payload = (envelope.payload ?? {}) as AuthorizenetArbPayload;
	const linkedSubscriptionId = payload.subscriptionId;
	const isCaptureForSubscription =
		eventType === 'net.authorize.payment.authcapture.created' &&
		(typeof linkedSubscriptionId === 'string' || typeof linkedSubscriptionId === 'number');

	let subscriptionType:
		| 'subscription.created'
		| 'subscription.renewed'
		| 'subscription.payment_failed'
		| 'subscription.canceled'
		| 'subscription.updated'
		| null = null;

	switch (eventType) {
		case 'net.authorize.customer.subscription.created':
			subscriptionType = 'subscription.created';
			break;
		case 'net.authorize.customer.subscription.failed':
			subscriptionType = 'subscription.payment_failed';
			break;
		case 'net.authorize.customer.subscription.updated':
		case 'net.authorize.customer.subscription.suspended':
		case 'net.authorize.customer.subscription.expiring':
			subscriptionType = 'subscription.updated';
			break;
		case 'net.authorize.customer.subscription.cancelled':
		case 'net.authorize.customer.subscription.expired':
		case 'net.authorize.customer.subscription.terminated':
			subscriptionType = 'subscription.canceled';
			break;
		default:
			if (isCaptureForSubscription) {
				subscriptionType = 'subscription.renewed';
			} else {
				return null;
			}
	}

	const subscriptionId = isCaptureForSubscription
		? String(linkedSubscriptionId ?? '')
		: typeof payload.id === 'string'
			? payload.id
			: String(payload.subscriptionId ?? '');
	if (!subscriptionId) return null;

	const status = mapAuthorizenetSubscriptionStatus(eventType);
	const amount = readAmount(payload);

	return {
		kind: 'subscription',
		type: subscriptionType,
		subscriptionId,
		provider: 'authorizenet',
		// ARB doesn't expose a per-subscription "product id" — the closest
		// is the subscription `name`. We surface that as productId so the
		// merchant can correlate, knowing it's a human-typed label not a
		// catalog reference.
		productId: typeof payload.name === 'string' ? payload.name : null,
		customerRef:
			typeof payload.customerProfileId === 'string' || typeof payload.customerProfileId === 'number'
				? String(payload.customerProfileId)
				: null,
		// ARB events don't carry the next-billing date in the webhook payload.
		// Merchants who need it call the ARB get-subscription API directly.
		currentPeriodEnd: null,
		status,
		amount,
		currency: 'USD',
		metadata: {
			authorizenetEventType: eventType,
			authorizenetNotificationId: envelope.notificationId,
		},
		timestamp: Date.now(),
		raw: envelope,
	};
}

function mapAuthorizenetSubscriptionStatus(
	eventType: string,
): 'active' | 'past_due' | 'canceled' | 'paused' | 'unknown' {
	switch (eventType) {
		case 'net.authorize.customer.subscription.created':
		case 'net.authorize.payment.authcapture.created':
			return 'active';
		case 'net.authorize.customer.subscription.failed':
			return 'past_due';
		case 'net.authorize.customer.subscription.suspended':
			return 'paused';
		case 'net.authorize.customer.subscription.cancelled':
		case 'net.authorize.customer.subscription.expired':
		case 'net.authorize.customer.subscription.terminated':
			return 'canceled';
		default:
			return 'unknown';
	}
}

function mapEventType(eventType: string): PaymentResult['status'] | null {
	switch (eventType) {
		case 'net.authorize.payment.authorization.created':
		case 'net.authorize.payment.fraud.held':
			return 'pending';
		case 'net.authorize.payment.authcapture.created':
		case 'net.authorize.payment.capture.created':
		case 'net.authorize.payment.priorAuthCapture.created':
		case 'net.authorize.payment.fraud.approved':
			return 'success';
		case 'net.authorize.payment.refund.created':
			return 'refunded';
		case 'net.authorize.payment.void.created':
		case 'net.authorize.payment.fraud.declined':
			return 'failed';
		default:
			return null;
	}
}

function readAmount(payload: AuthorizenetPayloadInner): number {
	// Payment events use `authAmount` / `settleAmount`; ARB subscription
	// events use a plain `amount` field. Prefer settle when present (refund
	// and capture events use it), fall back to authAmount, then to the
	// generic `amount` field for ARB.
	const raw =
		payload.settleAmount ??
		payload.authAmount ??
		(payload as AuthorizenetPayloadInner & { amount?: number | string }).amount;
	if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
	if (typeof raw === 'string') {
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

// --- helpers ---------------------------------------------------------------

function bodyToBytes(rawBody: unknown): Uint8Array {
	if (rawBody instanceof Uint8Array) return rawBody;
	if (typeof rawBody === 'string') return new TextEncoder().encode(rawBody);
	if (rawBody && typeof rawBody === 'object') {
		return new TextEncoder().encode(JSON.stringify(rawBody));
	}
	throw new Error('coin-moebius/authorizenet: unsupported body type');
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

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

/**
 * Authorize.Net does not provide a buyer-facing customer portal for
 * ARB subscriptions. Buyers do not manage their own subscriptions on the
 * Authorize.Net side; the merchant cancels or pauses from the
 * Merchant Interface, and the buyer contacts the merchant directly.
 *
 * This helper returns the URL of the Merchant Interface so the merchant
 * can drill into a specific subscription for support. Sandbox mode
 * points at the test merchant interface.
 */
export function getAuthorizenetPortalUrl(opts: { mode?: 'live' | 'sandbox' } = {}): string {
	return opts.mode === 'sandbox'
		? 'https://sandbox.authorize.net/'
		: 'https://account.authorize.net/';
}
