import { describe, it, expect, vi } from 'vitest';
import { createCoinbaseBusinessSubscription, signCdpJwt } from '../src/subscription.js';

/**
 * Tests for the programmatic webhook-subscription helper. Two surfaces:
 *
 *   1. `signCdpJwt` — builds a 3-segment ES256-signed JWT. We assert the
 *      header/payload shape and let Web Crypto verify the signature using
 *      the matching public key derived at test time. If the signature
 *      verifies, the JWT was produced correctly.
 *
 *   2. `createCoinbaseBusinessSubscription({...}).subscribe(...)` — POSTs to
 *      the CDP subscriptions endpoint with a Bearer JWT and returns the
 *      signing secret from the response. Network is stubbed via `fetcher`
 *      injection.
 *
 * Key-generation note: the test generates a fresh EC P-256 keypair, exports
 * the private key as PKCS8 PEM, hands it to `signCdpJwt`, then verifies the
 * resulting JWT with the matching public key. This is a self-contained
 * round-trip; no real CDP key is needed.
 */

async function generateTestKey(): Promise<{
	privateKeyPem: string;
	publicKey: CryptoKey;
}> {
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign',
		'verify',
	]);
	const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
	return { privateKeyPem: pkcs8ToPem(new Uint8Array(pkcs8)), publicKey: pair.publicKey };
}

function pkcs8ToPem(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	const base64 = btoa(binary);
	const wrapped = base64.match(/.{1,64}/g)?.join('\n') ?? base64;
	return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
}

function base64UrlToBytes(input: string): Uint8Array {
	const padded = input.replace(/-/g, '+').replace(/_/g, '/');
	const remainder = padded.length % 4;
	const final = remainder === 0 ? padded : padded + '='.repeat(4 - remainder);
	const binary = atob(final);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function base64UrlToJson<T>(input: string): T {
	const bytes = base64UrlToBytes(input);
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

interface JwtHeader {
	alg: string;
	typ: string;
	kid: string;
	nonce: string;
}

interface JwtPayload {
	sub: string;
	iss: string;
	aud: string[];
	nbf: number;
	exp: number;
	uri: string;
}

describe('signCdpJwt', () => {
	it('produces a three-segment JWT with the CDP claim shape', async () => {
		const { privateKeyPem } = await generateTestKey();
		const jwt = await signCdpJwt({
			keyId: 'organizations/abc/apiKeys/123',
			privateKeyPem,
			method: 'POST',
			url: 'https://api.cdp.coinbase.com/platform/v2/data/webhooks/subscriptions',
		});

		const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
		expect(headerSeg).toBeTruthy();
		expect(payloadSeg).toBeTruthy();
		expect(signatureSeg).toBeTruthy();

		const header = base64UrlToJson<JwtHeader>(headerSeg);
		expect(header.alg).toBe('ES256');
		expect(header.typ).toBe('JWT');
		expect(header.kid).toBe('organizations/abc/apiKeys/123');
		expect(header.nonce).toBeTypeOf('string');

		const payload = base64UrlToJson<JwtPayload>(payloadSeg);
		expect(payload.sub).toBe('organizations/abc/apiKeys/123');
		expect(payload.iss).toBe('cdp');
		expect(payload.aud).toEqual(['cdp_service']);
		expect(payload.exp - payload.nbf).toBe(120);
		expect(payload.uri).toBe('POST api.cdp.coinbase.com/platform/v2/data/webhooks/subscriptions');
	});

	it('round-trips: the signature verifies with the matching public key', async () => {
		const { privateKeyPem, publicKey } = await generateTestKey();
		const jwt = await signCdpJwt({
			keyId: 'k',
			privateKeyPem,
			method: 'POST',
			url: 'https://api.cdp.coinbase.com/platform/v2/data/webhooks/subscriptions',
		});

		const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
		const signingInput = `${headerSeg}.${payloadSeg}`;
		const signature = base64UrlToBytes(signatureSeg);

		const verified = await crypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			publicKey,
			signature,
			new TextEncoder().encode(signingInput),
		);
		expect(verified).toBe(true);
	});

	it('emits a fresh nonce on each call (basic replay resistance)', async () => {
		const { privateKeyPem } = await generateTestKey();
		const first = await signCdpJwt({
			keyId: 'k',
			privateKeyPem,
			method: 'POST',
			url: 'https://x/y',
		});
		const second = await signCdpJwt({
			keyId: 'k',
			privateKeyPem,
			method: 'POST',
			url: 'https://x/y',
		});
		const headerA = base64UrlToJson<JwtHeader>(first.split('.')[0]);
		const headerB = base64UrlToJson<JwtHeader>(second.split('.')[0]);
		expect(headerA.nonce).not.toBe(headerB.nonce);
	});
});

describe('createCoinbaseBusinessSubscription', () => {
	it('POSTs to the CDP subscriptions endpoint with a Bearer JWT and returns the signing secret', async () => {
		const { privateKeyPem } = await generateTestKey();
		let captured: { url: string; init?: RequestInit } = { url: '' };
		const fetchStub = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			// The subscription helper always passes a string URL, so narrowing
			// here keeps the assertion below away from `[object Request]`.
			captured = { url: typeof url === 'string' ? url : url instanceof URL ? url.href : '', init };
			return new Response(
				JSON.stringify({
					id: 'sub_abc123',
					signing_secret: 'whsec_real_secret_value',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});

		const sub = createCoinbaseBusinessSubscription({
			cdpKeyId: 'organizations/abc/apiKeys/123',
			cdpPrivateKeyPem: privateKeyPem,
			fetcher: fetchStub,
		});

		const result = await sub.subscribe({
			callbackUrl: 'https://example.com/webhook/coinbase-business',
		});

		expect(result.subscriptionId).toBe('sub_abc123');
		expect(result.signingSecret).toBe('whsec_real_secret_value');

		expect(captured.url).toBe(
			'https://api.cdp.coinbase.com/platform/v2/data/webhooks/subscriptions',
		);
		const authHeader = (captured.init?.headers as Record<string, string>)?.Authorization;
		expect(authHeader).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

		const bodyStr = typeof captured.init?.body === 'string' ? captured.init.body : '{}';
		const body = JSON.parse(bodyStr) as Record<string, unknown>;
		expect(body.callback_url).toBe('https://example.com/webhook/coinbase-business');
		expect(body.event_types).toEqual([
			'checkout.payment.success',
			'checkout.payment.failed',
			'checkout.payment.expired',
		]);
	});

	it('forwards a custom eventTypes list when provided', async () => {
		const { privateKeyPem } = await generateTestKey();
		let capturedBody: Record<string, unknown> = {};
		const fetchStub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			capturedBody = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
				string,
				unknown
			>;
			return new Response(JSON.stringify({ id: 'sub_x', signing_secret: 'whsec_x' }), {
				status: 200,
			});
		});

		const sub = createCoinbaseBusinessSubscription({
			cdpKeyId: 'k',
			cdpPrivateKeyPem: privateKeyPem,
			fetcher: fetchStub,
		});

		await sub.subscribe({
			callbackUrl: 'https://example.com/hook',
			eventTypes: ['checkout.payment.success'],
		});

		expect(capturedBody.event_types).toEqual(['checkout.payment.success']);
	});

	it('throws on non-2xx response and includes the body text', async () => {
		const { privateKeyPem } = await generateTestKey();
		const fetchStub = vi.fn(async () => new Response('forbidden', { status: 403 }));

		const sub = createCoinbaseBusinessSubscription({
			cdpKeyId: 'k',
			cdpPrivateKeyPem: privateKeyPem,
			fetcher: fetchStub,
		});

		await expect(sub.subscribe({ callbackUrl: 'https://x/y' })).rejects.toThrow(
			/subscription create failed \(403\): forbidden/,
		);
	});

	it('throws when the response is missing the signing secret', async () => {
		const { privateKeyPem } = await generateTestKey();
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ id: 'sub_x' }), { status: 200 }),
		);

		const sub = createCoinbaseBusinessSubscription({
			cdpKeyId: 'k',
			cdpPrivateKeyPem: privateKeyPem,
			fetcher: fetchStub,
		});

		await expect(sub.subscribe({ callbackUrl: 'https://x/y' })).rejects.toThrow(
			/missing id or signing_secret/,
		);
	});
});
