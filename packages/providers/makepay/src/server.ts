/**
 * MakePay server-side webhook verifier.
 *
 * MakePay signs each webhook with a Stripe-style scheme. The
 * `X-MakePay-Signature` header carries `t=<unixSeconds>,v1=<hexSignature>`,
 * where the signature is the hex HMAC-SHA256 of the exact string
 * `` `${t}.${rawBody}` `` keyed by the merchant's webhook secret (the
 * `whsec_…` value). Verification:
 *
 *   1. Parse `t` and `v1` from the header.
 *   2. Reject if `t` is missing/old (default tolerance 300s — replay window).
 *   3. Recompute HMAC-SHA256 over `` `${t}.${rawBody}` `` and compare to `v1`
 *      in constant time.
 *   4. Parse the now-trusted JSON body and normalize it.
 *
 * The raw body MUST be the exact bytes MakePay signed — pass the request's
 * raw text, not a re-serialized object. A parsed object can't be re-stringified
 * to the identical bytes, so this verifier requires a string body.
 *
 * **Replay protection:** the signed `t` gives a bounded replay window, but a
 * payload captured inside that window can still be re-sent (MakePay also
 * retries failed deliveries up to ten times). Callers MUST deduplicate — by the
 * `x-makepay-delivery-id` header (surfaced as `metadata.deliveryId`) for
 * exactly-once handling, or by the payment id (`paymentLink.uid`) for
 * once-per-payment handling.
 *
 * @remarks
 * The signature scheme and both payload shapes are taken from MakePay's
 * official API documentation (makecrypto.io/documentation/api/webhooks). The
 * canonical payment state is `session.status` (`complete` = paid); the payment
 * link's own `status` (`active`/`paused`/`archived`) is its catalog lifecycle,
 * not the payment state. {@link mapMakepaySessionStatus} maps `success` ONLY on
 * the documented `complete` value, so any other/unknown state stays in-flight
 * (`pending`) and can never trigger a false "paid".
 */

import type {
	PaymentResult,
	SubscriptionEvent,
	SubscriptionStatus,
	SubscriptionEventType,
	WebhookEvent,
} from '@aquarian-metals/coin-moebius-core';

/** Server-side config. `webhookSecret` is the signing secret from MakeCrypto. */
export interface MakepayVerifierConfig {
	webhookSecret: string;
	/** Replay window in seconds for the signed timestamp. Defaults to 300. */
	toleranceSeconds?: number;
}

/** The `t`/`v1` pair parsed out of an `X-MakePay-Signature` header. */
export interface MakepaySignatureParts {
	/** Unix seconds the delivery was signed at. */
	t: number;
	/** Hex HMAC-SHA256 signature. */
	v1: string;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Build a verifier matching the registry's `Verifier` shape from
 * `@aquarian-metals/coin-moebius-server`. Returns a `WebhookEvent` for a
 * recognized delivery, throwing on a bad/missing signature.
 */
export function createMakepayVerifier(
	config: MakepayVerifierConfig,
): (rawBody: unknown, headers?: unknown) => Promise<WebhookEvent | null> {
	const tolerance = config.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

	return async function verifyMakepayWebhook(
		rawBody: unknown,
		headers?: unknown,
	): Promise<WebhookEvent | null> {
		if (!config.webhookSecret) {
			throw new Error('coin-moebius/makepay: webhookSecret missing on verifier config');
		}

		const headerRecord = (headers ?? {}) as Record<string, string | undefined>;
		const sigHeader = headerValue(headerRecord, 'x-makepay-signature');
		if (!sigHeader) {
			throw new Error('coin-moebius/makepay: missing x-makepay-signature header');
		}

		// MakePay signs the exact raw bytes. We can only verify a string body —
		// a parsed object can't be re-serialized to the identical bytes.
		if (typeof rawBody !== 'string') {
			throw new Error(
				'coin-moebius/makepay: raw request body (string) is required to verify the signature',
			);
		}

		const parts = parseMakepaySignatureHeader(sigHeader);
		if (!parts) {
			throw new Error('coin-moebius/makepay: malformed x-makepay-signature header');
		}

		if (tolerance > 0) {
			const nowSeconds = Math.floor(Date.now() / 1000);
			if (Math.abs(nowSeconds - parts.t) > tolerance) {
				throw new Error('coin-moebius/makepay: webhook timestamp outside tolerance');
			}
		}

		const expected = await computeMakepaySignature(parts.t, rawBody, config.webhookSecret);
		if (!timingSafeStringEqual(expected, parts.v1.toLowerCase())) {
			throw new Error('coin-moebius/makepay: invalid signature');
		}

		let payload: MakepayWebhookPayload;
		try {
			payload = JSON.parse(rawBody) as MakepayWebhookPayload;
		} catch {
			throw new Error('coin-moebius/makepay: body is not valid JSON');
		}

		// The delivery id (header preferred, body as fallback) is the
		// exactly-once dedupe key; thread it into the normalized event.
		const deliveryId =
			headerValue(headerRecord, 'x-makepay-delivery-id') ??
			(typeof payload.deliveryId === 'string' ? payload.deliveryId : undefined);

		return toWebhookEvent(payload, deliveryId);
	};
}

/**
 * Parse an `X-MakePay-Signature` header (`t=...,v1=...`) into its parts.
 * Returns `null` when `t` isn't a positive integer or `v1` isn't hex.
 */
export function parseMakepaySignatureHeader(header: string): MakepaySignatureParts | null {
	const fields: Record<string, string> = {};
	for (const part of header.split(',')) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		fields[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	const t = Number(fields.t);
	const v1 = fields.v1 ?? '';
	if (!Number.isInteger(t) || t <= 0) return null;
	if (!/^[0-9a-fA-F]+$/.test(v1)) return null;
	return { t, v1 };
}

/**
 * Hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` keyed by the webhook
 * secret. Exported so callers with non-standard rawBody pipelines can verify
 * with the same routine without re-importing internals.
 */
export async function computeMakepaySignature(
	timestamp: number | string,
	rawBody: string,
	webhookSecret: string,
): Promise<string> {
	const message = new TextEncoder().encode(`${timestamp}.${rawBody}`);
	const keyBytes = new TextEncoder().encode(webhookSecret);
	const key = await crypto.subtle.importKey(
		'raw',
		keyBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, message);
	return toHex(new Uint8Array(sigBuf));
}

/**
 * Shape of a MakePay webhook payload (payment and subscription deliveries
 * share the envelope). Only the fields this verifier reads are named; the
 * index signatures keep unknown fields available on `raw`. Mirrors the two
 * documented payloads at makecrypto.io/documentation/api/webhooks.
 */
export interface MakepayWebhookPayload {
	/** Unique per-delivery id; also sent as the `x-makepay-delivery-id` header. */
	deliveryId?: string;
	/** e.g. `makepay.payment.status_changed` / `makepay.subscription.status_changed`. */
	type?: string;
	createdAt?: string;
	event?: { type?: string; trigger?: string; [key: string]: unknown };
	paymentLink?: {
		id?: string;
		uid?: string;
		/** Catalog lifecycle of the LINK (`active`/`paused`/`archived`) — not the payment state. */
		status?: string;
		publicUrl?: string;
		amount?: number | string;
		currency?: string;
		asset?: string;
		label?: string;
		/** The merchant-set `orderId` echoed back — our correlation id. */
		merchantOrderId?: string;
		clientEmail?: string;
		clientId?: string | null;
		[key: string]: unknown;
	};
	/** Present on payment deliveries. `session.status` is the canonical payment state. */
	session?: {
		id?: string;
		status?: string;
		previousStatus?: string;
		invoiceAsset?: string;
		invoiceAmount?: number | string;
		[key: string]: unknown;
	};
	/** Present on subscription deliveries. */
	subscription?: {
		id?: string;
		uid?: string;
		status?: string;
		previousStatus?: string;
		customerEmail?: string;
		label?: string;
		amountUsd?: number | string;
		cadence?: string;
		billingIntervalUnit?: string;
		billingIntervalCount?: number;
		metadata?: Record<string, unknown>;
		[key: string]: unknown;
	};
	/** The billing cycle a subscription delivery refers to. */
	cycle?: {
		dueAt?: string;
		amountUsd?: number | string;
		paymentLinkUid?: string;
		status?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** Route a verified payload to the payment or subscription normalizer. */
function toWebhookEvent(payload: MakepayWebhookPayload, deliveryId?: string): WebhookEvent {
	const topType = typeof payload.type === 'string' ? payload.type : '';
	const eventType = typeof payload.event?.type === 'string' ? payload.event.type : undefined;
	const isSubscription =
		topType.startsWith('makepay.subscription') ||
		eventType === 'subscription_status_changed' ||
		payload.subscription !== undefined;
	return isSubscription
		? toSubscriptionEvent(payload, deliveryId)
		: toPaymentEvent(payload, deliveryId);
}

/**
 * Normalize a payment delivery into a `kind: 'payment'` event. The payment id
 * is `paymentLink.uid`; the merchant correlation id rides in
 * `metadata.merchantOrderId` (and `raw.paymentLink.merchantOrderId`). Status
 * comes from {@link mapMakepaySessionStatus} (success only on `session.status`
 * === `complete`).
 */
function toPaymentEvent(payload: MakepayWebhookPayload, deliveryId?: string): WebhookEvent {
	const pl = payload.paymentLink ?? {};
	const session = payload.session ?? {};
	const eventType = typeof payload.event?.type === 'string' ? payload.event.type : undefined;
	const sessionStatus = typeof session.status === 'string' ? session.status : undefined;
	return {
		kind: 'payment',
		status: mapMakepaySessionStatus(sessionStatus, eventType),
		paymentId: stringField(pl.uid) ?? stringField(pl.id) ?? stringField(session.id) ?? '',
		provider: 'makepay',
		amount: numberField(pl.amount ?? session.invoiceAmount),
		currency: (stringField(pl.currency) ?? stringField(session.invoiceAsset) ?? '').toUpperCase(),
		metadata: {
			merchantOrderId: stringField(pl.merchantOrderId),
			uid: stringField(pl.uid),
			customerEmail: stringField(pl.clientEmail),
			deliveryId,
			makepayType: stringField(payload.type),
			eventType,
			eventTrigger: stringField(payload.event?.trigger),
			sessionStatus,
			previousSessionStatus: stringField(session.previousStatus),
			asset: stringField(pl.asset),
		},
		timestamp: Date.now(),
		raw: payload,
	};
}

/**
 * Normalize a subscription delivery into a `kind: 'subscription'` event.
 *
 * MakePay models subscription lifecycle as `subscription_status_changed`
 * transitions across `active`/`paused`/`overdue`/`cancelled`. The first signup
 * and each paid renewal are reported through that cycle's PAYMENT
 * `status_changed` delivery (see `cycle.paymentLinkUid`), so this event maps to
 * `subscription.updated` for active/paused transitions, `payment_failed` for
 * `overdue`, and `canceled` for `cancelled`.
 */
function toSubscriptionEvent(payload: MakepayWebhookPayload, deliveryId?: string): WebhookEvent {
	const sub = payload.subscription ?? {};
	const cycle = payload.cycle ?? {};
	const status = typeof sub.status === 'string' ? sub.status : undefined;
	const event: SubscriptionEvent = {
		type: mapSubscriptionEventType(status),
		subscriptionId: stringField(sub.uid) ?? stringField(sub.id) ?? '',
		provider: 'makepay',
		productId: null,
		customerRef: stringField(sub.customerEmail) ?? null,
		status: mapSubscriptionStatus(status),
		currentPeriodEnd: isoToUnixSeconds(cycle.dueAt),
		amount: numberField(sub.amountUsd ?? cycle.amountUsd),
		// Subscription amounts are quoted in USD (`amountUsd`); the buyer settles
		// the equivalent crypto on MakePay's hosted page.
		currency: 'USD',
		metadata: {
			subscriptionStatus: status,
			previousStatus: stringField(sub.previousStatus),
			cadence: stringField(sub.cadence),
			billingIntervalUnit: stringField(sub.billingIntervalUnit),
			billingIntervalCount:
				typeof sub.billingIntervalCount === 'number' ? sub.billingIntervalCount : undefined,
			cyclePaymentLinkUid: stringField(cycle.paymentLinkUid),
			deliveryId,
			makepayType: stringField(payload.type),
			...(sub.metadata ?? {}),
		},
		timestamp: Date.now(),
		raw: payload,
	};
	return { kind: 'subscription', ...event };
}

/**
 * Map MakePay's payment `session.status` onto the SDK's `PaymentStatus`.
 *
 * SAFETY INVARIANT: `success` is returned ONLY for the documented `complete`
 * session status. Everything else maps to `pending` or `failed` (neither
 * triggers delivery), so an unconfirmed string can never cause a false "paid".
 * Documented terminal non-payment outcomes (`payment_request_expired`,
 * `quote_expired`, `payment_cancelled_by_payer`) arrive as their own
 * `event.type` and map to `failed`.
 */
export function mapMakepaySessionStatus(
	sessionStatus: string | undefined,
	eventType?: string,
): PaymentResult['status'] {
	if (sessionStatus?.toLowerCase() === 'complete') return 'success';
	switch (eventType) {
		case 'payment_request_expired':
		case 'quote_expired':
		case 'payment_cancelled_by_payer':
			return 'failed';
	}
	switch (sessionStatus?.toLowerCase()) {
		case 'expired':
		case 'cancelled':
		case 'canceled':
		case 'failed':
			return 'failed';
		case 'underpaid':
		case 'partial':
			return 'partial';
		default:
			// pending / unknown → in-flight. Safe default (never false-success).
			return 'pending';
	}
}

/** Map a MakePay subscription status onto the SDK's neutral `SubscriptionStatus`. */
function mapSubscriptionStatus(status: string | undefined): SubscriptionStatus {
	switch (status?.toLowerCase()) {
		case 'active':
			return 'active';
		case 'paused':
			return 'paused';
		case 'overdue':
			return 'past_due';
		case 'cancelled':
		case 'canceled':
			return 'canceled';
		default:
			return 'unknown';
	}
}

/** Choose the `SubscriptionEventType` for a status transition (see {@link toSubscriptionEvent}). */
function mapSubscriptionEventType(status: string | undefined): SubscriptionEventType {
	switch (status?.toLowerCase()) {
		case 'cancelled':
		case 'canceled':
			return 'subscription.canceled';
		case 'overdue':
			return 'subscription.payment_failed';
		default:
			return 'subscription.updated';
	}
}

function isoToUnixSeconds(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function stringField(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return 0;
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
