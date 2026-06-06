/**
 * PayPal server-side webhook verifiers.
 *
 * Two implementations of the same `WebhookVerifier` contract — pick one:
 *
 *   `createPaypalVerifier({ clientId, clientSecret, webhookId, mode })`
 *     POSTs the incoming transmission fields to PayPal's
 *     `/v1/notifications/verify-webhook-signature` endpoint. PayPal does the
 *     crypto; we do one OAuth call (cached for the returned `expires_in`)
 *     plus one verify call per webhook. Default choice for most callers.
 *
 *   `createPaypalManualVerifier({ webhookId, mode, certCache?, fetcher? })`
 *     Verifies the signature locally. Faster on hot paths (no per-webhook
 *     OAuth or verify round-trip after the first cert fetch). Safe by default:
 *     rejects any `paypal-cert-url` whose origin is not the mode-appropriate
 *     PayPal host before any fetch happens, so a forged header cannot trick
 *     the verifier into trusting a third-party cert. HTTPS to the pinned
 *     host is the trust anchor; chain validation is delegated to TLS itself.
 *
 * Both verifiers return a `PaymentResult` for recognized events or `null`
 * for signed-but-non-payment events. Status mapping:
 *
 *   CHECKOUT.ORDER.APPROVED          → pending
 *   PAYMENT.CAPTURE.COMPLETED        → success
 *   PAYMENT.CAPTURE.DENIED           → failed
 *   PAYMENT.CAPTURE.DECLINED         → failed
 *   PAYMENT.CAPTURE.REFUNDED         → refunded
 *   PAYMENT.CAPTURE.REVERSED         → refunded
 *   CUSTOMER.DISPUTE.CREATED         → disputed
 *   CUSTOMER.DISPUTE.RESOLVED        → null (no status change; outcome
 *                                            shows on the original capture)
 *   anything else                    → null (signature still validated)
 */

import type { PaymentResult, WebhookEvent } from '@aquarian-metals/coin-moebius-core';

// --- shared contracts ------------------------------------------------------

export type PaypalMode = 'live' | 'sandbox';

export interface WebhookVerifier {
	verify(
		rawBody: unknown,
		headers: Record<string, string | undefined>,
	): Promise<WebhookEvent | null>;
}

/** Pluggable OAuth-token cache for the REST-endpoint verifier. */
export interface OAuthTokenCache {
	get(key: string): Promise<CachedOAuthToken | null> | CachedOAuthToken | null;
	set(key: string, value: CachedOAuthToken): Promise<void> | void;
}

export interface CachedOAuthToken {
	accessToken: string;
	expiresAt: number; // ms epoch
}

/** Pluggable cert cache for the manual verifier (cache by cert URL). */
export interface CertCache {
	get(url: string): Promise<string | null> | string | null;
	set(url: string, pem: string): Promise<void> | void;
}

// --- mode-bound endpoints --------------------------------------------------

const API_BASE = {
	live: 'https://api-m.paypal.com',
	sandbox: 'https://api-m.sandbox.paypal.com',
} as const;

const TRUSTED_CERT_PREFIXES = {
	live: 'https://api.paypal.com/v1/notifications/certs/',
	sandbox: 'https://api.sandbox.paypal.com/v1/notifications/certs/',
} as const;

// --- REST-endpoint verifier ------------------------------------------------

export interface PaypalVerifierConfig {
	clientId: string;
	clientSecret: string;
	webhookId: string;
	mode?: PaypalMode;
	/** Defaults to in-memory `Map` per verifier instance. */
	tokenCache?: OAuthTokenCache;
	/** Defaults to global `fetch`. Useful for tests. */
	fetcher?: typeof fetch;
}

export function createPaypalVerifier(config: PaypalVerifierConfig): WebhookVerifier {
	const mode: PaypalMode = config.mode ?? 'live';
	const apiBase = API_BASE[mode];
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const cache: OAuthTokenCache = config.tokenCache ?? memoryTokenCache();

	return {
		async verify(rawBody, headers): Promise<WebhookEvent | null> {
			requireString(config.clientId, 'clientId');
			requireString(config.clientSecret, 'clientSecret');
			requireString(config.webhookId, 'webhookId');

			const transmissionFields = extractTransmissionHeaders(headers);
			const bodyString = normalizeBody(rawBody);
			const webhookEvent = parseJson(bodyString, 'webhook event body');

			const token = await getAccessToken({
				cacheKey: config.clientId,
				cache,
				clientId: config.clientId,
				clientSecret: config.clientSecret,
				apiBase,
				fetcher,
			});

			const verifyResponse = await fetcher(`${apiBase}/v1/notifications/verify-webhook-signature`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					auth_algo: transmissionFields.authAlgo,
					cert_url: transmissionFields.certUrl,
					transmission_id: transmissionFields.transmissionId,
					transmission_sig: transmissionFields.transmissionSig,
					transmission_time: transmissionFields.transmissionTime,
					webhook_id: config.webhookId,
					webhook_event: webhookEvent,
				}),
			});

			if (!verifyResponse.ok) {
				const text = await verifyResponse.text();
				throw new Error(
					`coin-moebius/paypal: verify-webhook-signature failed (${verifyResponse.status}): ${text}`,
				);
			}
			const verifyPayload = (await verifyResponse.json()) as { verification_status?: string };
			if (verifyPayload.verification_status !== 'SUCCESS') {
				throw new Error('coin-moebius/paypal: invalid signature');
			}

			return toPaymentResult(webhookEvent);
		},
	};
}

async function getAccessToken(input: {
	cacheKey: string;
	cache: OAuthTokenCache;
	clientId: string;
	clientSecret: string;
	apiBase: string;
	fetcher: typeof fetch;
}): Promise<string> {
	const cached = await input.cache.get(input.cacheKey);
	// Refresh when within 60s of expiry to avoid a near-miss race.
	if (cached && cached.expiresAt - Date.now() > 60_000) {
		return cached.accessToken;
	}

	const basic = base64(`${input.clientId}:${input.clientSecret}`);
	const response = await input.fetcher(`${input.apiBase}/v1/oauth2/token`, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${basic}`,
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
		},
		body: 'grant_type=client_credentials',
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`coin-moebius/paypal: oauth token request failed (${response.status}): ${text}`,
		);
	}
	const payload = (await response.json()) as { access_token?: string; expires_in?: number };
	if (!payload.access_token || typeof payload.expires_in !== 'number') {
		throw new Error('coin-moebius/paypal: oauth response missing access_token or expires_in');
	}
	const expiresAt = Date.now() + payload.expires_in * 1000;
	await input.cache.set(input.cacheKey, { accessToken: payload.access_token, expiresAt });
	return payload.access_token;
}

function memoryTokenCache(): OAuthTokenCache {
	const store = new Map<string, CachedOAuthToken>();
	return {
		get: (key) => store.get(key) ?? null,
		set: (key, value) => {
			store.set(key, value);
		},
	};
}

// --- manual verifier -------------------------------------------------------

export interface PaypalManualVerifierConfig {
	webhookId: string;
	mode?: PaypalMode;
	/** Defaults to in-memory `Map` keyed by cert URL. */
	certCache?: CertCache;
	/** Defaults to global `fetch`. Useful for tests. */
	fetcher?: typeof fetch;
}

export function createPaypalManualVerifier(config: PaypalManualVerifierConfig): WebhookVerifier {
	const mode: PaypalMode = config.mode ?? 'live';
	const trustedPrefix = TRUSTED_CERT_PREFIXES[mode];
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const cache: CertCache = config.certCache ?? memoryCertCache();

	return {
		async verify(rawBody, headers): Promise<WebhookEvent | null> {
			requireString(config.webhookId, 'webhookId');

			const transmissionFields = extractTransmissionHeaders(headers);

			// SAFE-BY-DEFAULT GUARD: refuse to fetch any cert URL that is not
			// on the mode-appropriate PayPal host. HTTPS to a pinned host is
			// the trust anchor; TLS handles cert chain validation for us.
			if (!transmissionFields.certUrl.startsWith(trustedPrefix)) {
				throw new Error(
					`coin-moebius/paypal: refusing untrusted paypal-cert-url (must start with ${trustedPrefix})`,
				);
			}

			const bodyBytes = bodyToBytes(rawBody);
			const bodyString = new TextDecoder().decode(bodyBytes);
			const webhookEvent = parseJson(bodyString, 'webhook event body');

			const crc = crc32(bodyBytes).toString(10);
			const signedString = `${transmissionFields.transmissionId}|${transmissionFields.transmissionTime}|${config.webhookId}|${crc}`;

			const pem = await fetchCertPem(transmissionFields.certUrl, cache, fetcher);
			const publicKey = await importRsaPublicKeyFromCert(pem);
			const signatureBytes = base64Decode(transmissionFields.transmissionSig);

			const verified = await crypto.subtle.verify(
				{ name: 'RSASSA-PKCS1-v1_5' },
				publicKey,
				signatureBytes,
				new TextEncoder().encode(signedString),
			);
			if (!verified) {
				throw new Error('coin-moebius/paypal: invalid signature');
			}

			return toPaymentResult(webhookEvent);
		},
	};
}

async function fetchCertPem(url: string, cache: CertCache, fetcher: typeof fetch): Promise<string> {
	const cached = await cache.get(url);
	if (cached) return cached;

	const response = await fetcher(url, { method: 'GET' });
	if (!response.ok) {
		throw new Error(`coin-moebius/paypal: cert fetch failed (${response.status}) for ${url}`);
	}
	const pem = await response.text();
	await cache.set(url, pem);
	return pem;
}

function memoryCertCache(): CertCache {
	const store = new Map<string, string>();
	return {
		get: (url) => store.get(url) ?? null,
		set: (url, pem) => {
			store.set(url, pem);
		},
	};
}

/**
 * Extract the SubjectPublicKeyInfo from an X.509 certificate (PEM) and import
 * it as an RSA public key for SHA-256 verification.
 *
 * Web Crypto's `importKey('spki', ...)` accepts SubjectPublicKeyInfo bytes,
 * not full X.509 certificates. We walk the cert's ASN.1 structure to extract
 * the SPKI bytes, then hand them to Web Crypto. The walk is minimal: enter
 * the outer Certificate SEQUENCE, enter the tbsCertificate SEQUENCE, skip
 * the explicit-version, serial, signature, issuer, validity, subject fields,
 * then read the SubjectPublicKeyInfo SEQUENCE as a complete TLV slice.
 */
async function importRsaPublicKeyFromCert(pem: string): Promise<CryptoKey> {
	const der = pemBlockToBytes(pem, 'CERTIFICATE');
	const spki = extractSpkiFromX509(der);
	return crypto.subtle.importKey(
		'spki',
		spki as BufferSource,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	);
}

function extractSpkiFromX509(der: Uint8Array): Uint8Array {
	// Outer: SEQUENCE (Certificate) — tag 0x30
	const certSeq = readTlv(der, 0);
	if (certSeq.tag !== 0x30) {
		throw new Error('coin-moebius/paypal: unexpected outer ASN.1 tag (expected SEQUENCE)');
	}
	// Inside Certificate: tbsCertificate SEQUENCE — tag 0x30
	const tbs = readTlv(certSeq.value, 0);
	if (tbs.tag !== 0x30) {
		throw new Error('coin-moebius/paypal: unexpected tbsCertificate tag (expected SEQUENCE)');
	}
	let offset = 0;
	const body = tbs.value;

	// Optional [0] EXPLICIT Version. Tag 0xA0 if present; skip when seen.
	if (body[offset] === 0xa0) {
		const version = readTlv(body, offset);
		offset = version.end;
	}
	// CertificateSerialNumber — INTEGER (0x02)
	offset = readTlv(body, offset).end;
	// signature AlgorithmIdentifier — SEQUENCE (0x30)
	offset = readTlv(body, offset).end;
	// issuer Name — SEQUENCE (0x30)
	offset = readTlv(body, offset).end;
	// validity — SEQUENCE (0x30)
	offset = readTlv(body, offset).end;
	// subject Name — SEQUENCE (0x30)
	offset = readTlv(body, offset).end;

	// Next field is the SubjectPublicKeyInfo SEQUENCE. We need the entire
	// TLV (tag + length + value) as a slice, because Web Crypto's `spki`
	// format expects the full ASN.1 SubjectPublicKeyInfo structure.
	const spkiTlv = readTlv(body, offset);
	if (spkiTlv.tag !== 0x30) {
		throw new Error(
			'coin-moebius/paypal: expected SubjectPublicKeyInfo SEQUENCE at the post-subject position',
		);
	}
	return body.subarray(offset, spkiTlv.end);
}

interface Tlv {
	tag: number;
	length: number;
	value: Uint8Array;
	end: number;
}

function readTlv(bytes: Uint8Array, start: number): Tlv {
	if (start >= bytes.length) {
		throw new Error('coin-moebius/paypal: truncated ASN.1 input');
	}
	const tag = bytes[start];
	let cursor = start + 1;
	const lengthByte = bytes[cursor++];
	let length: number;
	if (lengthByte < 0x80) {
		length = lengthByte;
	} else {
		const numLengthBytes = lengthByte & 0x7f;
		if (numLengthBytes === 0 || numLengthBytes > 4) {
			// Forbid indefinite-length (numLengthBytes === 0) and anything
			// over 32-bit since we're dealing with kB-scale certs.
			throw new Error('coin-moebius/paypal: unsupported ASN.1 length encoding');
		}
		length = 0;
		for (let i = 0; i < numLengthBytes; i++) {
			length = (length << 8) | bytes[cursor++];
		}
	}
	const valueStart = cursor;
	const end = valueStart + length;
	if (end > bytes.length) {
		throw new Error('coin-moebius/paypal: ASN.1 length exceeds input');
	}
	return { tag, length, value: bytes.subarray(valueStart, end), end };
}

// --- header + body helpers (shared between verifiers) ----------------------

interface TransmissionHeaders {
	transmissionId: string;
	transmissionTime: string;
	certUrl: string;
	transmissionSig: string;
	authAlgo: string;
}

function extractTransmissionHeaders(
	headers: Record<string, string | undefined>,
): TransmissionHeaders {
	const transmissionId = headerValue(headers, 'paypal-transmission-id');
	const transmissionTime = headerValue(headers, 'paypal-transmission-time');
	const certUrl = headerValue(headers, 'paypal-cert-url');
	const transmissionSig = headerValue(headers, 'paypal-transmission-sig');
	// `paypal-auth-algo` is required for the REST verifier; the manual
	// verifier assumes SHA256withRSA (PayPal's documented default) and
	// ignores it, but we still surface it for forwarding.
	const authAlgo = headerValue(headers, 'paypal-auth-algo') ?? 'SHA256withRSA';

	if (!transmissionId || !transmissionTime || !certUrl || !transmissionSig) {
		throw new Error('coin-moebius/paypal: missing one or more required paypal-* headers');
	}
	return { transmissionId, transmissionTime, certUrl, transmissionSig, authAlgo };
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

function normalizeBody(rawBody: unknown): string {
	if (typeof rawBody === 'string') return rawBody;
	if (rawBody instanceof Uint8Array) return new TextDecoder().decode(rawBody);
	if (rawBody && typeof rawBody === 'object') return JSON.stringify(rawBody);
	throw new Error('coin-moebius/paypal: unsupported body type');
}

function bodyToBytes(rawBody: unknown): Uint8Array {
	if (rawBody instanceof Uint8Array) return rawBody;
	if (typeof rawBody === 'string') return new TextEncoder().encode(rawBody);
	if (rawBody && typeof rawBody === 'object') {
		return new TextEncoder().encode(JSON.stringify(rawBody));
	}
	throw new Error('coin-moebius/paypal: unsupported body type');
}

function parseJson(s: string, label: string): Record<string, unknown> {
	try {
		return JSON.parse(s) as Record<string, unknown>;
	} catch {
		throw new Error(`coin-moebius/paypal: ${label} is not valid JSON`);
	}
}

function requireString(value: unknown, fieldName: string): void {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`coin-moebius/paypal: ${fieldName} missing on verifier config`);
	}
}

// --- event → PaymentResult -------------------------------------------------

interface PaypalAmount {
	value?: string;
	currency_code?: string;
}

interface PaypalDisputeAmount {
	value?: string;
	currency_code?: string;
}

interface PaypalRelatedIds {
	order_id?: string;
}

interface PaypalSupplementaryData {
	related_ids?: PaypalRelatedIds;
}

interface PaypalResource {
	id?: string;
	amount?: PaypalAmount;
	dispute_amount?: PaypalDisputeAmount;
	purchase_units?: { amount?: PaypalAmount }[];
	supplementary_data?: PaypalSupplementaryData;
	[key: string]: unknown;
}

interface PaypalWebhookEvent {
	event_type?: string;
	resource_type?: string;
	resource?: PaypalResource;
	[key: string]: unknown;
}

function toPaymentResult(event: Record<string, unknown>): WebhookEvent | null {
	const typed = event as PaypalWebhookEvent;
	const eventType = typed.event_type ?? '';

	// Subscription lifecycle events take precedence over the one-time event
	// mapping. The order events (PAYMENT.SALE.COMPLETED in particular) can
	// fire for both legacy one-time payments AND for subscription cycles —
	// the subscription path narrows by inspecting the resource shape.
	const subscriptionEvent = toSubscriptionEvent(event, eventType);
	if (subscriptionEvent) return subscriptionEvent;

	const status = mapEventType(eventType);
	if (status === null) return null;

	const resource = typed.resource ?? {};
	const { amount, currency } = readAmountAndCurrency(resource, eventType);
	const paymentId = readPaymentId(resource);

	return {
		kind: 'payment',
		status,
		paymentId,
		provider: 'paypal',
		amount,
		currency,
		metadata: {
			paypalEventType: eventType,
			paypalResourceId: typeof resource.id === 'string' ? resource.id : undefined,
		},
		timestamp: Date.now(),
		raw: event,
	};
}

/**
 * Subscription event resource shape PayPal sends for billing events. Fields
 * we read; the rest of the payload comes through on `raw`.
 */
interface PaypalSubscriptionResource {
	id?: string;
	status?: string;
	plan_id?: string;
	custom_id?: string;
	subscriber?: { payer_id?: string; email_address?: string };
	billing_info?: {
		next_billing_time?: string;
		last_payment?: { amount?: PaypalAmount };
	};
	[key: string]: unknown;
}

/**
 * PayPal subscription-event mapper. Recognizes five event types covering
 * the subscription lifecycle and emits the SDK's normalized
 * `SubscriptionEvent`. Returns `null` for any other event so the caller
 * falls through to the payment-event path.
 *
 *   BILLING.SUBSCRIPTION.ACTIVATED       → subscription.created
 *   PAYMENT.SALE.COMPLETED (sub-linked)  → subscription.renewed
 *   BILLING.SUBSCRIPTION.PAYMENT.FAILED  → subscription.payment_failed
 *   BILLING.SUBSCRIPTION.UPDATED         → subscription.updated
 *   BILLING.SUBSCRIPTION.CANCELLED       → subscription.canceled
 *
 * `PAYMENT.SALE.COMPLETED` is the only fork: PayPal uses it for legacy
 * one-time payments AND for subscription cycle charges. We discriminate
 * by checking whether the resource's `billing_agreement_id` is set, which
 * it is on subscription-linked sales.
 */
function toSubscriptionEvent(
	event: Record<string, unknown>,
	eventType: string,
): WebhookEvent | null {
	const typed = event as PaypalWebhookEvent;
	const resource = (typed.resource ?? {}) as PaypalSubscriptionResource & {
		billing_agreement_id?: string;
	};

	const isSaleForSubscription =
		eventType === 'PAYMENT.SALE.COMPLETED' && typeof resource.billing_agreement_id === 'string';

	let subscriptionType:
		| 'subscription.created'
		| 'subscription.renewed'
		| 'subscription.payment_failed'
		| 'subscription.canceled'
		| 'subscription.updated'
		| null = null;

	switch (eventType) {
		case 'BILLING.SUBSCRIPTION.ACTIVATED':
			subscriptionType = 'subscription.created';
			break;
		case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
			subscriptionType = 'subscription.payment_failed';
			break;
		case 'BILLING.SUBSCRIPTION.UPDATED':
		case 'BILLING.SUBSCRIPTION.SUSPENDED':
		case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
		case 'BILLING.SUBSCRIPTION.EXPIRED':
			subscriptionType = 'subscription.updated';
			break;
		case 'BILLING.SUBSCRIPTION.CANCELLED':
			subscriptionType = 'subscription.canceled';
			break;
		default:
			if (isSaleForSubscription) {
				subscriptionType = 'subscription.renewed';
			} else {
				return null;
			}
	}

	const subscriptionId = isSaleForSubscription
		? (resource.billing_agreement_id ?? '')
		: (resource.id ?? '');
	if (!subscriptionId) return null;

	const status = mapSubscriptionStatus(eventType, resource.status);
	const { amount, currency } = readSubscriptionAmount(resource, isSaleForSubscription);
	const nextBilling = resource.billing_info?.next_billing_time;
	const currentPeriodEnd =
		typeof nextBilling === 'string' ? Math.floor(new Date(nextBilling).getTime() / 1000) : null;

	return {
		kind: 'subscription',
		type: subscriptionType,
		subscriptionId,
		provider: 'paypal',
		productId: typeof resource.plan_id === 'string' ? resource.plan_id : null,
		customerRef:
			typeof resource.subscriber?.payer_id === 'string' ? resource.subscriber.payer_id : null,
		status,
		currentPeriodEnd: Number.isFinite(currentPeriodEnd!) ? currentPeriodEnd : null,
		amount,
		currency,
		metadata: {
			paypalEventType: eventType,
			...(typeof resource.custom_id === 'string' ? { customerRef: resource.custom_id } : {}),
		},
		timestamp: Date.now(),
		raw: event,
	};
}

/**
 * Map PayPal's subscription status field onto our neutral enum. PayPal
 * statuses: `APPROVAL_PENDING`, `APPROVED`, `ACTIVE`, `SUSPENDED`,
 * `CANCELLED`, `EXPIRED`. The event type itself sometimes carries more
 * intent than the status field (e.g. CANCELLED sub still shows `ACTIVE`
 * status briefly), so we let the event type win where they disagree.
 */
function mapSubscriptionStatus(
	eventType: string,
	rawStatus: string | undefined,
): 'active' | 'past_due' | 'canceled' | 'paused' | 'unknown' {
	if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED') return 'canceled';
	if (eventType === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') return 'past_due';
	if (eventType === 'BILLING.SUBSCRIPTION.SUSPENDED') return 'paused';
	switch (rawStatus) {
		case 'ACTIVE':
		case 'APPROVED':
			return 'active';
		case 'SUSPENDED':
			return 'paused';
		case 'CANCELLED':
		case 'EXPIRED':
			return 'canceled';
		default:
			return 'unknown';
	}
}

function readSubscriptionAmount(
	resource: PaypalSubscriptionResource & { amount?: PaypalAmount },
	isSaleForSubscription: boolean,
): { amount: number; currency: string } {
	const amountField = isSaleForSubscription
		? resource.amount
		: resource.billing_info?.last_payment?.amount;
	const value = amountField?.value;
	const amount = typeof value === 'string' ? Number.parseFloat(value) : 0;
	const currency = (amountField?.currency_code ?? 'USD').toUpperCase();
	return { amount: Number.isFinite(amount) ? amount : 0, currency };
}

function mapEventType(eventType: string): PaymentResult['status'] | null {
	switch (eventType) {
		case 'CHECKOUT.ORDER.APPROVED':
			return 'pending';
		case 'PAYMENT.CAPTURE.COMPLETED':
			return 'success';
		case 'PAYMENT.CAPTURE.DENIED':
		case 'PAYMENT.CAPTURE.DECLINED':
			return 'failed';
		case 'PAYMENT.CAPTURE.REFUNDED':
		case 'PAYMENT.CAPTURE.REVERSED':
			return 'refunded';
		case 'CUSTOMER.DISPUTE.CREATED':
			return 'disputed';
		// CUSTOMER.DISPUTE.RESOLVED intentionally returns null: the resolution
		// outcome is reflected on the original capture event's downstream
		// state, not as a separate status change.
		default:
			return null;
	}
}

function readAmountAndCurrency(
	resource: PaypalResource,
	eventType: string,
): { amount: number; currency: string } {
	// Disputes use `dispute_amount`; captures use `amount`; orders nest amount
	// inside the first `purchase_units` entry. Probe each, default safely.
	let amountField: PaypalAmount | undefined;
	if (eventType === 'CUSTOMER.DISPUTE.CREATED') {
		amountField = resource.dispute_amount;
	} else if (resource.amount) {
		amountField = resource.amount;
	} else if (resource.purchase_units?.[0]?.amount) {
		amountField = resource.purchase_units[0].amount;
	}
	const value = amountField?.value;
	const amount = typeof value === 'string' ? Number.parseFloat(value) : 0;
	const currency = (amountField?.currency_code ?? 'USD').toUpperCase();
	return { amount: Number.isFinite(amount) ? amount : 0, currency };
}

function readPaymentId(resource: PaypalResource): string {
	// Prefer the underlying order id when a capture/refund event references
	// one — gives consumers a stable id across the full payment lifecycle.
	// Fall back to the resource id (the capture or order id itself).
	const orderId = resource.supplementary_data?.related_ids?.order_id;
	if (typeof orderId === 'string' && orderId.length > 0) return orderId;
	if (typeof resource.id === 'string') return resource.id;
	return '';
}

// --- crypto + encoding helpers --------------------------------------------

function pemBlockToBytes(pem: string, label: string): Uint8Array {
	const begin = `-----BEGIN ${label}-----`;
	const end = `-----END ${label}-----`;
	const beginIdx = pem.indexOf(begin);
	const endIdx = pem.indexOf(end);
	if (beginIdx === -1 || endIdx === -1) {
		throw new Error(`coin-moebius/paypal: PEM missing ${label} block`);
	}
	const body = pem.slice(beginIdx + begin.length, endIdx).replace(/\s+/g, '');
	return base64Decode(body);
}

function base64(input: string): string {
	let binary = '';
	const bytes = new TextEncoder().encode(input);
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function base64Decode(input: string): Uint8Array {
	const binary = atob(input);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

// --- CRC32 -----------------------------------------------------------------

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[i] = c >>> 0;
	}
	return table;
}

/**
 * IEEE 802.3 CRC-32 of the byte array. Returns an unsigned 32-bit integer.
 * PayPal's manual webhook verification scheme requires this as a decimal
 * string component of the signed payload.
 */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Return the PayPal-hosted page a buyer manages their subscriptions on.
 * PayPal does not offer a per-subscription "Customer Portal" session like
 * Stripe; the buyer signs into their PayPal account and sees every
 * automatic-payment they have, across all merchants, at the same URL. We
 * just return that URL.
 *
 * The `mode` argument toggles between live and sandbox hosts so
 * sandbox-mode test buyers don't get redirected to the live PayPal
 * account UI (where their sandbox credentials wouldn't work).
 */
export function getPaypalPortalUrl(opts: { mode?: PaypalMode } = {}): string {
	const mode = opts.mode ?? 'live';
	return mode === 'sandbox'
		? 'https://www.sandbox.paypal.com/myaccount/autopay/'
		: 'https://www.paypal.com/myaccount/autopay/';
}
