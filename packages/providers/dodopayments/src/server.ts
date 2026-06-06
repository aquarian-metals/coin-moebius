/**
 * Dodo Payments server-side webhook verifier. Dodo signs webhooks with the
 * [Standard Webhooks](https://www.standardwebhooks.com/) scheme (the same
 * scheme Svix popularized), so verification is:
 *
 *   1. Read the `webhook-id`, `webhook-timestamp`, and `webhook-signature`
 *      headers.
 *   2. Reject the delivery if `webhook-timestamp` is outside the tolerance
 *      window (replay protection — Standard Webhooks bakes a signed timestamp
 *      into every delivery, so unlike NOWPayments we don't need the caller to
 *      dedupe by id to be replay-safe; we still recommend it for idempotency).
 *   3. Build the signed content as `${webhook-id}.${webhook-timestamp}.${rawBody}`.
 *   4. HMAC-SHA256 it with the webhook secret. The `whsec_`-prefixed secret is
 *      base64 AFTER the prefix; decode it to raw key bytes first.
 *   5. base64-encode the digest and compare (constant time) against each
 *      space-delimited `v1,<sig>` token in the `webhook-signature` header. The
 *      header carries multiple signatures during key rotation; a match on any
 *      one passes.
 *
 * **Raw body is required.** Standard Webhooks signs the exact bytes Dodo sent.
 * Re-serializing a parsed object would change key order / whitespace and break
 * the signature, so this verifier only accepts the raw request body as a
 * string or byte buffer and throws (fails closed) on a pre-parsed object — the
 * same contract the Stripe verifier enforces.
 *
 * The verifier maps Dodo's event stream onto the SDK's canonical
 * `WebhookEvent` union. One-time payments, refunds, and disputes become
 * `kind: 'payment'`; subscription lifecycle events become `kind: 'subscription'`.
 * Event types the SDK doesn't model (payouts, license keys, informational
 * dispute follow-ups) resolve to `null` so consumers can skip them without
 * polluting their transaction store.
 */

import type {
	PaymentResult,
	SubscriptionEvent,
	SubscriptionStatus,
	WebhookEvent,
} from '@aquarian-metals/coin-moebius-core';

/** Default replay-tolerance window: reject deliveries whose signed timestamp is more than this many seconds from now. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

/** Server-side config. `webhookSecret` is the `whsec_…` value from Dodo's dashboard webhook settings. */
export interface DodoPaymentsVerifierConfig {
	webhookSecret: string;
	/**
	 * Replay-tolerance window in seconds. Deliveries whose `webhook-timestamp`
	 * is further than this from the current time are rejected. Defaults to
	 * {@link DEFAULT_WEBHOOK_TOLERANCE_SECONDS} (5 minutes), matching the
	 * Standard Webhooks reference implementations.
	 */
	toleranceSeconds?: number;
}

/**
 * The shape of a Dodo Payments webhook envelope. Mirrors the documented
 * payload. Fields we don't read are still allowed via the index signature so
 * future additions don't break verification.
 */
export interface DodoWebhookPayload {
	business_id: string;
	/** Event identifier, e.g. `payment.succeeded`, `subscription.active`. */
	type: string;
	/** ISO 8601 dispatch time. */
	timestamp: string;
	data: DodoEventData;
	[key: string]: unknown;
}

/** The inner `data` object. `payload_type` discriminates the resource. */
export interface DodoEventData {
	payload_type: string;
	payment_id?: string;
	subscription_id?: string;
	/** Smallest currency unit (e.g. cents) for payment payloads. */
	total_amount?: number;
	/** Smallest currency unit for refund payloads. */
	amount?: number;
	/** Smallest currency unit per cycle for subscription payloads. */
	recurring_pre_tax_amount?: number;
	currency?: string;
	status?: string;
	product_id?: string;
	customer?: { customer_id?: string; email?: string; name?: string };
	next_billing_date?: string;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

/** Options for {@link getDodoPortalUrl}. */
export interface DodoPortalOptions {
	/** Dodo API key (Bearer). */
	apiKey: string;
	/** API host, e.g. `https://test.dodopayments.com` or `https://live.dodopayments.com`. */
	apiBase: string;
	/** The Dodo customer handle (`cus_…`). */
	customerId: string;
	/** Where the portal's back button returns the buyer to. */
	returnUrl?: string;
}

/**
 * Create a Dodo-hosted Customer Portal session and return its URL. The buyer
 * manages their subscription (cancel, update card, view invoices) inside
 * Dodo's branded UI; the merchant never sees card details.
 *
 * Mirrors `getStripePortalUrl` from the Stripe provider so a consumer dogfooding
 * both rails calls the same shape. Hits
 * `POST /customers/{id}/customer-portal/session` and reads the `link` field.
 */
export async function getDodoPortalUrl(opts: DodoPortalOptions): Promise<string> {
	const base = opts.apiBase.replace(/\/$/, '');
	const url = new URL(`${base}/customers/${opts.customerId}/customer-portal/session`);
	if (opts.returnUrl) url.searchParams.set('return_url', opts.returnUrl);
	const response = await fetch(url, {
		method: 'POST',
		headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
	});
	if (!response.ok) {
		throw new Error(
			`coin-moebius/dodopayments: customer-portal session failed (${response.status})`,
		);
	}
	const payload = (await response.json()) as { link?: string };
	if (!payload.link) {
		throw new Error('coin-moebius/dodopayments: customer-portal response missing `link`');
	}
	return payload.link;
}

/**
 * Build a Standard Webhooks verifier for Dodo Payments. The returned function
 * matches the `Verifier` contract from `@aquarian-metals/coin-moebius-server`:
 * `(rawBody, headers) => Promise<WebhookEvent | null>`. Register it with a
 * verifier registry, or call it directly inside your webhook handler.
 */
export function createDodoPaymentsVerifier(config: DodoPaymentsVerifierConfig) {
	const tolerance = config.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;

	return async function verifyDodoWebhook(
		rawBody: unknown,
		headers?: unknown,
	): Promise<WebhookEvent | null> {
		if (!config.webhookSecret) {
			throw new Error('coin-moebius/dodopayments: webhookSecret missing on verifier config');
		}

		const headerRecord = (headers ?? {}) as Record<string, string | undefined>;
		const id = headerValue(headerRecord, 'webhook-id') ?? headerValue(headerRecord, 'svix-id');
		const timestamp =
			headerValue(headerRecord, 'webhook-timestamp') ?? headerValue(headerRecord, 'svix-timestamp');
		const signatureHeader =
			headerValue(headerRecord, 'webhook-signature') ?? headerValue(headerRecord, 'svix-signature');

		if (!id || !timestamp || !signatureHeader) {
			throw new Error(
				'coin-moebius/dodopayments: missing webhook-id / webhook-timestamp / webhook-signature header',
			);
		}

		assertTimestampFresh(timestamp, tolerance);

		// Standard Webhooks signs the exact bytes Dodo sent. We need the raw
		// body string verbatim — re-serializing a parsed object would change
		// the bytes and break the signature, so reject objects (fail closed).
		const rawString = toRawString(rawBody);

		const expected = await computeDodoSignature(id, timestamp, rawString, config.webhookSecret);
		if (!signatureHeaderMatches(signatureHeader, expected)) {
			throw new Error('coin-moebius/dodopayments: invalid signature');
		}

		let payload: DodoWebhookPayload;
		try {
			payload = JSON.parse(rawString) as DodoWebhookPayload;
		} catch {
			throw new Error('coin-moebius/dodopayments: body is not valid JSON');
		}

		return toWebhookEvent(payload);
	};
}

/**
 * Compute the Standard Webhooks signature for a delivery: base64 HMAC-SHA256
 * of `${id}.${timestamp}.${body}` keyed by the base64-decoded webhook secret.
 * Exported so callers with non-standard rawBody pipelines can verify with the
 * same routine without re-importing internals. Returns the bare base64 digest
 * (no `v1,` prefix).
 */
export async function computeDodoSignature(
	id: string,
	timestamp: string,
	body: string,
	webhookSecret: string,
): Promise<string> {
	const secretBytes = decodeSecret(webhookSecret);
	const message = new TextEncoder().encode(`${id}.${timestamp}.${body}`);
	const key = await crypto.subtle.importKey(
		'raw',
		secretBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, message);
	return bytesToBase64(new Uint8Array(sigBuf));
}

/**
 * The Standard Webhooks secret is `whsec_<base64>`. The `whsec_` prefix is a
 * human-readable label, not part of the key — strip it, then base64-decode the
 * remainder to the raw HMAC key bytes. Secrets without the prefix are decoded
 * as-is for tolerance.
 */
function decodeSecret(secret: string): Uint8Array {
	const b64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
	return base64ToBytes(b64);
}

/**
 * The `webhook-signature` header is a space-delimited list of `<version>,<sig>`
 * tokens (e.g. `v1,abc= v1,def=`) to support zero-downtime key rotation. We
 * compare our expected base64 digest against each `v1` token in constant time;
 * a match on any one passes.
 */
function signatureHeaderMatches(header: string, expected: string): boolean {
	for (const token of header.split(' ')) {
		const comma = token.indexOf(',');
		if (comma === -1) continue;
		const version = token.slice(0, comma);
		const sig = token.slice(comma + 1);
		if (version === 'v1' && timingSafeStringEqual(sig, expected)) return true;
	}
	return false;
}

function assertTimestampFresh(timestamp: string, toleranceSeconds: number): void {
	const ts = Number(timestamp);
	if (!Number.isFinite(ts)) {
		throw new Error('coin-moebius/dodopayments: webhook-timestamp is not a number');
	}
	const nowSeconds = Date.now() / 1000;
	if (Math.abs(nowSeconds - ts) > toleranceSeconds) {
		throw new Error('coin-moebius/dodopayments: webhook-timestamp outside tolerance (replay?)');
	}
}

function toRawString(rawBody: unknown): string {
	if (typeof rawBody === 'string') return rawBody;
	if (rawBody instanceof Uint8Array) return new TextDecoder().decode(rawBody);
	if (rawBody instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(rawBody));
	throw new Error(
		'coin-moebius/dodopayments: raw body must be the unparsed request string or bytes — ' +
			'Standard Webhooks signs the exact payload, so a pre-parsed object cannot be verified',
	);
}

/**
 * Map a Dodo webhook envelope onto the SDK's `WebhookEvent` union. Returns
 * `null` for event types the SDK doesn't model (payouts, license keys,
 * informational dispute follow-ups, failed refunds).
 */
function toWebhookEvent(payload: DodoWebhookPayload): WebhookEvent | null {
	const type = payload.type;

	if (type.startsWith('subscription.')) {
		return toSubscriptionEvent(payload);
	}

	const paymentStatus = mapPaymentEvent(type);
	if (!paymentStatus) return null;
	return toPaymentEvent(payload, paymentStatus);
}

/**
 * Map a Dodo payment/refund/dispute event type onto `PaymentResult.status`.
 * Returns `null` for events that don't represent a payment state change the
 * SDK surfaces (e.g. `refund.failed`, dispute lifecycle follow-ups, payouts).
 *
 *   - `payment.succeeded`            → success
 *   - `payment.processing`          → pending
 *   - `payment.failed` / `.cancelled` → failed
 *   - `refund.succeeded`            → refunded
 *   - `dispute.opened`              → disputed
 *
 * Dispute resolution events (`dispute.won`, `dispute.lost`, `dispute.accepted`,
 * etc.) are intentionally not mapped: the SDK's status enum can't represent
 * "won/lost", and re-emitting `disputed` would double-count. Consumers needing
 * the full dispute lifecycle can read `event.raw`.
 */
function mapPaymentEvent(type: string): PaymentResult['status'] | null {
	switch (type) {
		case 'payment.succeeded':
			return 'success';
		case 'payment.processing':
			return 'pending';
		case 'payment.failed':
		case 'payment.cancelled':
			return 'failed';
		case 'refund.succeeded':
			return 'refunded';
		case 'dispute.opened':
			return 'disputed';
		default:
			return null;
	}
}

function toPaymentEvent(
	payload: DodoWebhookPayload,
	status: PaymentResult['status'],
): WebhookEvent {
	const data = payload.data;
	// Refunds and disputes reference the original `payment_id`, so we key every
	// payment-family event on it for cross-event linking (refund/dispute back to
	// the original payment), mirroring the Stripe verifier's PaymentIntent link.
	const paymentId = data.payment_id ?? data.subscription_id ?? '';
	// Refund payloads carry the refunded `amount`; payment/dispute payloads carry
	// `total_amount`. Both are minor units.
	const minor = status === 'refunded' ? (data.amount ?? data.total_amount) : data.total_amount;
	return {
		kind: 'payment',
		status,
		paymentId,
		provider: 'dodopayments',
		amount: minorToMajor(minor),
		currency: (data.currency ?? 'USD').toUpperCase(),
		metadata: {
			...(data.metadata ?? {}),
			email: data.customer?.email,
			dodoEventType: payload.type,
			dodoStatus: data.status,
		},
		timestamp: Date.now(),
		raw: payload,
	};
}

/**
 * Map a Dodo `subscription.*` event onto the cross-provider `SubscriptionEvent`
 * shape.
 *
 *   - `subscription.active`       → subscription.created (initial activation)
 *   - `subscription.renewed`      → subscription.renewed
 *   - `subscription.failed`       → subscription.payment_failed (mandate/first charge failed)
 *   - `subscription.on_hold`      → subscription.updated (paused after dunning)
 *   - `subscription.cancelled`    → subscription.canceled
 *   - `subscription.expired`      → subscription.canceled (reached end of term)
 *   - `subscription.plan_changed` → subscription.updated
 *   - everything else (`subscription.updated`, future types) → subscription.updated
 */
function toSubscriptionEvent(payload: DodoWebhookPayload): WebhookEvent {
	const data = payload.data;
	const type = mapSubscriptionEventType(payload.type);
	const customerRef = data.customer?.customer_id ?? data.customer?.email ?? null;
	return {
		kind: 'subscription',
		type,
		subscriptionId: data.subscription_id ?? '',
		provider: 'dodopayments',
		productId: data.product_id ?? null,
		customerRef,
		status: mapSubscriptionStatus(data.status),
		currentPeriodEnd: parseIsoToUnixSeconds(data.next_billing_date),
		amount: minorToMajor(data.recurring_pre_tax_amount),
		currency: (data.currency ?? 'USD').toUpperCase(),
		metadata: {
			...(data.metadata ?? {}),
			email: data.customer?.email,
			dodoEventType: payload.type,
			dodoStatus: data.status,
		},
		timestamp: Date.now(),
		raw: payload,
	};
}

function mapSubscriptionEventType(type: string): SubscriptionEvent['type'] {
	switch (type) {
		case 'subscription.active':
			return 'subscription.created';
		case 'subscription.renewed':
			return 'subscription.renewed';
		case 'subscription.failed':
			return 'subscription.payment_failed';
		case 'subscription.cancelled':
		case 'subscription.expired':
			return 'subscription.canceled';
		default:
			// subscription.on_hold, subscription.plan_changed, subscription.updated, …
			return 'subscription.updated';
	}
}

/**
 * Map Dodo's subscription `status` onto our neutral `SubscriptionStatus`.
 * Provider-specific reasons stay in `metadata.dodoStatus` untouched.
 */
function mapSubscriptionStatus(status: string | undefined): SubscriptionStatus {
	switch (status) {
		case 'active':
			return 'active';
		case 'on_hold':
		case 'failed':
			return 'past_due';
		case 'paused':
			return 'paused';
		case 'cancelled':
		case 'expired':
			return 'canceled';
		default:
			return 'unknown';
	}
}

/**
 * Convert a minor-unit integer (cents) to a major-unit decimal. Mirrors the
 * Stripe verifier's unconditional `/100`: the SDK's other fiat provider takes
 * the same shortcut rather than carrying a per-currency exponent table, so we
 * stay consistent. Zero-decimal currencies (JPY, etc.) would need a divisor of
 * 1; revisit here and in the Stripe verifier together if that case ships.
 */
function minorToMajor(minor: number | undefined): number {
	return (minor ?? 0) / 100;
}

/** Parse an ISO 8601 timestamp to Unix seconds. Returns `null` when absent or unparseable. */
function parseIsoToUnixSeconds(iso: string | undefined): number | null {
	if (!iso) return null;
	const ms = Date.parse(iso);
	return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
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

function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}
