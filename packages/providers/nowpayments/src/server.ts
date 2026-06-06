/**
 * NOWPayments server-side IPN verifier. Implements the signature scheme
 * documented at <https://nowpayments.zendesk.com/hc/en-us/articles/21395546303389>:
 *
 *   1. Parse the JSON body.
 *   2. RECURSIVELY sort every object's keys alphabetically (including nested
 *      objects). The recursion matters — top-level-only sort produces a
 *      different hash and the webhook will be rejected.
 *   3. JSON.stringify the sorted result.
 *   4. HMAC-SHA512 with the IPN secret as the key.
 *   5. Hex-encode the digest.
 *   6. Compare to the `x-nowpayments-sig` header in constant time.
 *
 * The verifier returns a `PaymentResult` mapping NOWPayments' statuses onto
 * the SDK's canonical `success | pending | failed` triad. Status mapping:
 *
 *   waiting / confirming / confirmed / sending / partially_paid → pending
 *   finished                                                    → success
 *   failed / refunded / expired                                  → failed
 *
 * `partially_paid` deserves a note: NOWPayments holds the funds and the
 * merchant can either refund or accept. v1 maps it to `pending` so the
 * dashboard surfaces it as in-flight; future versions could expose a
 * dedicated state.
 *
 * **Replay protection:** NOWPayments does not include a signed timestamp in
 * the IPN delivery. A captured valid payload can be replayed indefinitely.
 * Callers MUST deduplicate by `payment_id` (the Cloud worker does this via
 * the `(provider, provider_event_id)` unique constraint).
 */

import type { PaymentResult, WebhookEvent } from '@aquarian-metals/coin-moebius-core';

/** Server-side config. `ipnSecret` is the IPN key from NOWPayments' Settings → IPN. */
export interface NowPaymentsVerifierConfig {
	ipnSecret: string;
}

/** Single-provider verifier matching the `Verifier` shape from `@aquarian-metals/coin-moebius-server`. */
export interface WebhookVerifier {
	verify(rawBody: unknown, headers: Record<string, string | undefined>): Promise<WebhookEvent>;
}

/**
 * The shape of a NOWPayments IPN payload. Mirrors the response from
 * `GET /v1/payment/{payment_id}`. Fields we don't read are still allowed via
 * the index signature so future additions don't break verification.
 */
export interface NowPaymentsIpnPayload {
	payment_id: number;
	payment_status: string;
	pay_address?: string;
	price_amount: number;
	price_currency: string;
	pay_amount?: number;
	pay_currency?: string;
	order_id: string;
	order_description?: string;
	purchase_id?: number;
	created_at?: string;
	updated_at?: string;
	outcome_amount?: number;
	outcome_currency?: string;
	actually_paid?: number;
	network?: string;
	[key: string]: unknown;
}

export function createNowPaymentsVerifier(config: NowPaymentsVerifierConfig): WebhookVerifier {
	return {
		async verify(rawBody, headers): Promise<WebhookEvent> {
			if (!config.ipnSecret) {
				throw new Error('coin-moebius/nowpayments: ipnSecret missing on verifier config');
			}

			const sig = headerValue(headers, 'x-nowpayments-sig');
			if (!sig) {
				throw new Error('coin-moebius/nowpayments: missing x-nowpayments-sig header');
			}

			// The hot-path Worker hands us the parsed body (or the raw text).
			// Accept both shapes so we don't double-parse.
			let payload: NowPaymentsIpnPayload;
			if (typeof rawBody === 'string') {
				try {
					payload = JSON.parse(rawBody) as NowPaymentsIpnPayload;
				} catch {
					throw new Error('coin-moebius/nowpayments: body is not valid JSON');
				}
			} else if (rawBody && typeof rawBody === 'object') {
				payload = rawBody as NowPaymentsIpnPayload;
			} else {
				throw new Error('coin-moebius/nowpayments: unsupported body type');
			}

			const expected = await computeNowPaymentsSignature(payload, config.ipnSecret);
			if (!timingSafeStringEqual(expected, sig)) {
				throw new Error('coin-moebius/nowpayments: invalid signature');
			}

			return toWebhookEvent(payload);
		},
	};
}

/**
 * Hex HMAC-SHA512 of `JSON.stringify(sortObjectRecursive(payload))` with the
 * IPN secret. Exported so consumers with non-standard rawBody pipelines can
 * verify with the same routine without re-importing internals.
 */
export async function computeNowPaymentsSignature(
	payload: unknown,
	ipnSecret: string,
): Promise<string> {
	const sorted = sortObjectRecursive(payload);
	const message = new TextEncoder().encode(JSON.stringify(sorted));
	const keyBytes = new TextEncoder().encode(ipnSecret);
	const key = await crypto.subtle.importKey(
		'raw',
		keyBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-512' },
		false,
		['sign'],
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, message);
	return toHex(new Uint8Array(sigBuf));
}

/**
 * Recursive alphabetical sort by key. Arrays preserve their order; only
 *
 * objects get re-keyed. Mirrors the reference implementation in
 * NOWPayments' own examples and the official Node SDK.
 */
function sortObjectRecursive(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sortObjectRecursive(item));
	}
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			out[key] = sortObjectRecursive((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	return value;
}

/**
 * Map NOWPayments `payment_status` → SDK `PaymentResult.status`.
 *
 *   - `finished` → `success` — the canonical happy path.
 *   - `partially_paid` → `partial` — buyer sent less than invoiced (common
 *     with crypto when network fees ate into the amount). The SDK's `amount`
 *     reflects what was actually received (`actually_paid`) so the consumer
 *     can decide whether to ship.
 *   - `refunded` → `refunded` — money returned to the buyer. Surface A
 *     (post-payment events).
 *   - `failed` / `expired` → `failed` — terminal negative.
 *   - Everything else (`waiting`, `confirming`, `confirmed`, `sending`) is
 *     in-flight; mapped to `pending`.
 */
function toWebhookEvent(payload: NowPaymentsIpnPayload): WebhookEvent {
	const status = payload.payment_status;
	const mapped: PaymentResult['status'] = mapPaymentStatus(status);
	// For partial payments, prefer `actually_paid` (what we received on chain)
	// over `price_amount` (what we asked for). Consumers compare the two via
	// metadata to detect underpayments.
	const amount =
		mapped === 'partial' && typeof payload.actually_paid === 'number'
			? payload.actually_paid
			: payload.price_amount;
	return {
		kind: 'payment',
		status: mapped,
		paymentId: String(payload.payment_id ?? payload.order_id),
		provider: 'nowpayments',
		amount,
		currency: payload.price_currency.toUpperCase(),
		metadata: {
			orderId: payload.order_id,
			payCurrency: payload.pay_currency,
			actuallyPaid: payload.actually_paid,
			invoicedAmount: payload.price_amount,
			network: payload.network,
			nowpaymentsStatus: status,
		},
		timestamp: Date.now(),
		raw: payload,
	};
}

function mapPaymentStatus(status: string): PaymentResult['status'] {
	switch (status) {
		case 'finished':
			return 'success';
		case 'partially_paid':
			return 'partial';
		case 'refunded':
			return 'refunded';
		case 'failed':
		case 'expired':
			return 'failed';
		default:
			return 'pending';
	}
}

function headerValue(
	headers: Record<string, string | undefined>,
	name: string,
): string | undefined {
	// Hono normalises header names lowercase but be defensive about any caller
	// that hands us a mixed-case map.
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
