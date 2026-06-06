/**
 * Coinbase Business server-side webhook verifier. Implements the Hook0 v1
 * signature scheme (Coinbase routes Business Checkout webhooks through Hook0;
 * see <https://documentation.hook0.com/tutorials/webhook-authentication>):
 *
 *   X-Hook0-Signature: t=<unix-seconds>,h=<space-separated-header-names>,v1=<hex-sha256>
 *
 *   signed = `${t}.${h}.${headerValues.join('.')}.${rawBody}`
 *   v1     = HMAC-SHA256(signed, webhookSecret)   // hex-encoded
 *
 * Where `headerValues` are the inbound request's values for the headers
 * listed (in order) in the `h=` field. The `h=` field is space-separated and
 * header names are matched case-insensitively. If `h=` is absent (Hook0 v0
 * legacy mode), the signed content is `${t}.${rawBody}`.
 *
 * A replay-window guard (default 300 seconds) rejects messages where
 * `now - t > maxAgeSeconds`. Tests pass `Number.POSITIVE_INFINITY` to bypass
 * wall-clock drift on captured fixtures.
 *
 * The verifier returns a `PaymentResult` for the three Checkout API event
 * types and resolves to `null` for any other signed event so consumers can
 * skip non-payment deliveries without polluting their transaction store:
 *
 *   checkout.payment.success → success
 *   checkout.payment.failed  → failed
 *   checkout.payment.expired → failed   (treated as terminal negative)
 *
 * Coinbase Business does not emit an in-flight `pending` event; absence-of-
 * event is the "awaiting payment" signal between checkout creation and the
 * first webhook landing.
 */

import type { PaymentResult, WebhookEvent } from '@aquarian-metals/coin-moebius-core';

export interface CoinbaseBusinessVerifierConfig {
	/**
	 * Webhook signing secret returned by Coinbase at subscription creation
	 * time. Coinbase does not expose this secret in a dashboard after
	 * creation — capture it on the subscription response and persist it.
	 */
	webhookSecret: string;
	/**
	 * Maximum age, in seconds, that a webhook's `t=` timestamp can be before
	 * the verifier rejects it. Defaults to 300 (matches Hook0's default
	 * replay window). Set to `Number.POSITIVE_INFINITY` in tests against
	 * fixed-time fixtures.
	 */
	maxAgeSeconds?: number;
	/**
	 * Clock override. Returns the current time in seconds. Defaults to
	 * `Math.floor(Date.now() / 1000)`. Useful for deterministic tests.
	 */
	now?: () => number;
}

export interface WebhookVerifier {
	verify(
		rawBody: unknown,
		headers: Record<string, string | undefined>,
	): Promise<WebhookEvent | null>;
}

/**
 * Parsed components of the `X-Hook0-Signature` header. Exposed for callers
 * that want to validate the header shape without running the full HMAC step.
 */
export interface ParsedHook0Signature {
	timestamp: number;
	headerNames: string[];
	signature: string;
}

const DEFAULT_MAX_AGE_SECONDS = 300;

export function createCoinbaseBusinessVerifier(
	config: CoinbaseBusinessVerifierConfig,
): WebhookVerifier {
	const maxAge = config.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
	const now = config.now ?? (() => Math.floor(Date.now() / 1000));

	return {
		async verify(rawBody, headers): Promise<WebhookEvent | null> {
			if (!config.webhookSecret) {
				throw new Error('coin-moebius/coinbase-business: webhookSecret missing on verifier config');
			}

			const signatureHeader = headerValue(headers, 'x-hook0-signature');
			if (!signatureHeader) {
				throw new Error('coin-moebius/coinbase-business: missing x-hook0-signature header');
			}

			const parsed = parseHook0Signature(signatureHeader);

			// Replay-window guard. Distinct from signature failure so callers
			// can log the two cases separately if they want.
			const age = Math.abs(now() - parsed.timestamp);
			if (age > maxAge) {
				throw new Error(
					`coin-moebius/coinbase-business: webhook timestamp outside replay window (age ${age}s, max ${maxAge}s)`,
				);
			}

			const bodyString = normalizeBody(rawBody);
			const expected = await computeCoinbaseBusinessSignature(
				parsed.timestamp,
				parsed.headerNames,
				parsed.headerNames.map((name) => headerValue(headers, name) ?? ''),
				bodyString,
				config.webhookSecret,
			);

			if (!timingSafeStringEqual(expected, parsed.signature)) {
				throw new Error('coin-moebius/coinbase-business: invalid signature');
			}

			return toPaymentResult(bodyString);
		},
	};
}

/**
 * Parse a raw `X-Hook0-Signature` header value into its `t`, `h`, `v1`
 * components. Throws if any required field is missing or malformed.
 *
 * Exported so callers with non-standard rawBody pipelines can validate the
 * header shape without going through the full verifier.
 */
export function parseHook0Signature(header: string): ParsedHook0Signature {
	const parts: Record<string, string> = {};
	for (const piece of header.split(',')) {
		const eq = piece.indexOf('=');
		if (eq === -1) continue;
		const key = piece.slice(0, eq).trim();
		const value = piece.slice(eq + 1).trim();
		if (key) parts[key] = value;
	}

	const t = Number.parseInt(parts.t ?? '', 10);
	if (!Number.isFinite(t) || t <= 0) {
		throw new Error('coin-moebius/coinbase-business: signature header missing or invalid `t`');
	}
	const signature = parts.v1;
	if (!signature) {
		throw new Error('coin-moebius/coinbase-business: signature header missing `v1`');
	}
	// `h` is optional. Hook0 v0 deliveries omit it; the signed payload then
	// is just `${t}.${rawBody}`. We handle both shapes via an empty list.
	const headerNames = parts.h ? parts.h.split(/\s+/).filter(Boolean) : [];

	return { timestamp: t, headerNames, signature };
}

/**
 * Compute the canonical Hook0 v1 signature. Hex-encoded HMAC-SHA256 over
 * `${t}.${h}.${headerValues.join('.')}.${rawBody}`, or `${t}.${rawBody}` when
 * `headerNames` is empty (v0 legacy form).
 *
 * Exported so callers can verify with the same routine without re-importing
 * internals.
 */
export async function computeCoinbaseBusinessSignature(
	timestamp: number,
	headerNames: readonly string[],
	headerValues: readonly string[],
	rawBody: string,
	webhookSecret: string,
): Promise<string> {
	if (headerNames.length !== headerValues.length) {
		throw new Error('coin-moebius/coinbase-business: headerNames / headerValues length mismatch');
	}
	const signed =
		headerNames.length === 0
			? `${timestamp}.${rawBody}`
			: `${timestamp}.${headerNames.join(' ')}.${headerValues.join('.')}.${rawBody}`;
	const message = new TextEncoder().encode(signed);
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
 * Coinbase Business Checkout API webhook payload shape (fields we read). The
 * full payload is preserved on `PaymentResult.raw` for callers that need
 * the rest.
 */
interface CoinbaseBusinessWebhookPayload {
	event?: { type?: string; data?: CoinbaseBusinessCheckoutData };
	type?: string; // some Hook0 deliveries flatten the envelope
	data?: CoinbaseBusinessCheckoutData;
	[key: string]: unknown;
}

interface CoinbaseBusinessCheckoutData {
	id?: string;
	checkout_id?: string;
	amount?: number | string;
	pricing?: { local?: { amount?: number | string; currency?: string } };
	local_price?: { amount?: number | string; currency?: string };
	currency?: string;
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

function toPaymentResult(bodyString: string): WebhookEvent | null {
	let parsed: CoinbaseBusinessWebhookPayload;
	try {
		parsed = JSON.parse(bodyString) as CoinbaseBusinessWebhookPayload;
	} catch {
		throw new Error('coin-moebius/coinbase-business: body is not valid JSON');
	}

	const eventType = parsed.event?.type ?? parsed.type ?? '';
	const data: CoinbaseBusinessCheckoutData = parsed.event?.data ?? parsed.data ?? {};

	const status = mapEventType(eventType);
	if (status === null) return null;

	const { amount, currency } = readAmountAndCurrency(data);

	return {
		kind: 'payment',
		status,
		paymentId: String(data.checkout_id ?? data.id ?? ''),
		provider: 'coinbase-business',
		amount,
		currency,
		metadata: {
			...(data.metadata ?? {}),
			coinbaseEventType: eventType,
		},
		timestamp: Date.now(),
		raw: parsed,
	};
}

/**
 * Map Coinbase Business event types to the SDK's `PaymentStatus` union.
 * Unknown events return `null` so consumers can skip non-payment deliveries.
 *
 *   checkout.payment.success → success
 *   checkout.payment.failed  → failed
 *   checkout.payment.expired → failed (terminal negative, treated like fail)
 */
function mapEventType(eventType: string): PaymentResult['status'] | null {
	switch (eventType) {
		case 'checkout.payment.success':
			return 'success';
		case 'checkout.payment.failed':
		case 'checkout.payment.expired':
			return 'failed';
		default:
			return null;
	}
}

function readAmountAndCurrency(data: CoinbaseBusinessCheckoutData): {
	amount: number;
	currency: string;
} {
	// Coinbase Business returns the local-currency price under a few shapes
	// depending on the API revision. Probe each and fall back to zero/USD
	// so the verifier never throws on an otherwise-valid signed event.
	const local = data.pricing?.local ?? data.local_price;
	const rawAmount = local?.amount ?? data.amount;
	const amount = typeof rawAmount === 'string' ? Number.parseFloat(rawAmount) : (rawAmount ?? 0);
	const currency = (local?.currency ?? data.currency ?? 'USD').toUpperCase();
	return { amount: Number.isFinite(amount) ? amount : 0, currency };
}

function normalizeBody(rawBody: unknown): string {
	if (typeof rawBody === 'string') return rawBody;
	if (rawBody instanceof Uint8Array) return new TextDecoder().decode(rawBody);
	if (rawBody && typeof rawBody === 'object') return JSON.stringify(rawBody);
	throw new Error('coin-moebius/coinbase-business: unsupported body type');
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
