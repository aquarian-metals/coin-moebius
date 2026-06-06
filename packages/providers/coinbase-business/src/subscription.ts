/**
 * Programmatic webhook-subscription helper for Coinbase Business. Calls the
 * CDP webhook subscriptions endpoint to register a callback URL, signing it
 * with a CDP-issued JWT. The response contains the webhook signing secret;
 * **this is the only time Coinbase exposes that secret**, so the caller must
 * persist it before returning to the user.
 *
 * Coinbase Business does not expose a dashboard form to paste a webhook URL.
 * Subscription creation is programmatic-only — callers who want to manage
 * webhook subscriptions in their own provisioning flow import this module.
 * Callers who only need to verify incoming webhooks can ignore it entirely.
 *
 * The JWT is signed with ES256 (ECDSA P-256 + SHA-256) via Web Crypto, which
 * is universally available on Workers, Bun, Node 18+, and modern browsers.
 * Coinbase's docs also list Ed25519/EdDSA as "recommended" but Web Crypto
 * support for Ed25519 is uneven across older runtimes; ES256 is the safe
 * cross-runtime choice and Coinbase accepts both.
 */

export type CoinbaseBusinessMode = 'live' | 'sandbox';

export interface CoinbaseBusinessSubscriptionConfig {
	/** CDP API key id (the `kid` field on the JWT). */
	cdpKeyId: string;
	/**
	 * CDP-issued EC P-256 private key in PEM form (PKCS8). Coinbase shows
	 * this once at key creation; persist it on the caller side.
	 */
	cdpPrivateKeyPem: string;
	/** Selects sandbox vs production CDP endpoints. */
	mode?: CoinbaseBusinessMode;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
}

export interface SubscribeOptions {
	/** Public HTTPS URL where Coinbase will deliver webhook events. */
	callbackUrl: string;
	/**
	 * Event types to subscribe to. Defaults to the three Checkout payment
	 * events the verifier maps. Pass an empty array to receive every
	 * event Coinbase emits (not recommended; the verifier returns `null`
	 * for non-payment events anyway, but bandwidth is bandwidth).
	 */
	eventTypes?: readonly string[];
}

export interface SubscribeResult {
	/** Coinbase subscription id; persist for future deletes/updates. */
	subscriptionId: string;
	/**
	 * The webhook signing secret. **Not retrievable later** — persist this
	 * now or you'll need to delete and recreate the subscription.
	 */
	signingSecret: string;
	/** Raw response payload for callers that need additional fields. */
	raw: unknown;
}

const SUBSCRIPTION_URL = 'https://api.cdp.coinbase.com/platform/v2/data/webhooks/subscriptions';
const JWT_LIFETIME_SECONDS = 120;
const DEFAULT_EVENT_TYPES = [
	'checkout.payment.success',
	'checkout.payment.failed',
	'checkout.payment.expired',
] as const;

export function createCoinbaseBusinessSubscription(config: CoinbaseBusinessSubscriptionConfig) {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);

	return {
		async subscribe(options: SubscribeOptions): Promise<SubscribeResult> {
			const eventTypes = options.eventTypes ?? DEFAULT_EVENT_TYPES;
			const jwt = await signCdpJwt({
				keyId: config.cdpKeyId,
				privateKeyPem: config.cdpPrivateKeyPem,
				method: 'POST',
				url: SUBSCRIPTION_URL,
			});

			const response = await fetcher(SUBSCRIPTION_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					callback_url: options.callbackUrl,
					event_types: eventTypes,
					environment: config.mode ?? 'live',
				}),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(
					`coin-moebius/coinbase-business: subscription create failed (${response.status}): ${body}`,
				);
			}

			const payload = (await response.json()) as Record<string, unknown>;
			const subscriptionId = readString(payload, 'id', 'subscription_id');
			const signingSecret = readString(payload, 'signing_secret', 'secret');
			if (!subscriptionId || !signingSecret) {
				throw new Error(
					'coin-moebius/coinbase-business: subscription response missing id or signing_secret',
				);
			}
			return { subscriptionId, signingSecret, raw: payload };
		},
	};
}

/**
 * Build and sign a CDP-flavored JWT. Exposed so callers integrating other
 * CDP endpoints (Advanced Trade, Onchain) can reuse the same routine.
 *
 * The JWT pattern is documented at
 * <https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication>:
 *
 *   header  = { alg: 'ES256', typ: 'JWT', kid: <keyId>, nonce: <random> }
 *   payload = { sub: <keyId>, iss: 'cdp', aud: ['cdp_service'],
 *               nbf: <now>, exp: <now + 120>, uri: '<METHOD> <host+path>' }
 */
export async function signCdpJwt(options: {
	keyId: string;
	privateKeyPem: string;
	method: string;
	url: string;
}): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const parsedUrl = new URL(options.url);
	const uriClaim = `${options.method.toUpperCase()} ${parsedUrl.host}${parsedUrl.pathname}`;

	const header = {
		alg: 'ES256',
		typ: 'JWT',
		kid: options.keyId,
		nonce: randomNonce(),
	};
	const payload = {
		sub: options.keyId,
		iss: 'cdp',
		aud: ['cdp_service'],
		nbf: now,
		exp: now + JWT_LIFETIME_SECONDS,
		uri: uriClaim,
	};

	const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
		JSON.stringify(payload),
	)}`;

	const privateKey = await importEcPrivateKey(options.privateKeyPem);
	const signatureBuf = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		privateKey,
		new TextEncoder().encode(signingInput),
	);
	// Web Crypto returns the IEEE P1363 raw r||s format, which is exactly
	// what JOSE wants for ES256 (no DER decoding needed).
	const signature = base64UrlEncodeBytes(new Uint8Array(signatureBuf));
	return `${signingInput}.${signature}`;
}

async function importEcPrivateKey(pem: string): Promise<CryptoKey> {
	const pkcs8 = pemToBytes(pem);
	return crypto.subtle.importKey(
		'pkcs8',
		pkcs8 as BufferSource,
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign'],
	);
}

function pemToBytes(pem: string): Uint8Array {
	const stripped = pem
		.replace(/-----BEGIN [^-]+-----/, '')
		.replace(/-----END [^-]+-----/, '')
		.replace(/\s+/g, '');
	if (!stripped) {
		throw new Error('coin-moebius/coinbase-business: empty PEM payload');
	}
	const binary = atob(stripped);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function base64UrlEncode(input: string): string {
	return base64UrlEncodeBytes(new TextEncoder().encode(input));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64UrlEncodeBytes(bytes);
}

function readString(obj: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === 'string' && value.length > 0) return value;
	}
	return undefined;
}
