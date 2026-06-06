import { describe, it, expect } from 'vitest';
import { asPayment } from '@aquarian-metals/coin-moebius-core';
import {
	createCoinbaseBusinessVerifier,
	computeCoinbaseBusinessSignature,
	parseHook0Signature,
} from '../src/server.js';

/**
 * Unit tests for the Coinbase Business webhook verifier.
 *
 * Three things get coverage here:
 *
 *   1. Round-trip: payload → our signature → our verifier. Catches any
 *      internal inconsistency in our implementation.
 *
 *   2. Hook0-reference compliance: we build the signed string by hand
 *      exactly as documentation.hook0.com publishes (Node.js reference)
 *      and feed our verifier a signature computed from that string. If our
 *      verifier accepts it, our spec interpretation matches Hook0's
 *      reference. This is the substitute for a captured-from-Coinbase
 *      sandbox fixture until a CDP account is provisioned for the spike.
 *
 *   3. Negatives: tampered body, wrong key, missing header, expired window.
 */

const WEBHOOK_SECRET = 'whsec_test_unit_tests_only';
// Fixed Unix timestamp (seconds) so the replay-window check is deterministic
// across test runs. Roughly Nov 2023.
const FIXED_NOW_SECONDS = 1700000000;

interface SamplePayload {
	body: string;
	timestamp: number;
	headerNames: string[];
	headerValues: string[];
}

function sample(eventType = 'checkout.payment.success'): SamplePayload {
	const body = JSON.stringify({
		event: {
			type: eventType,
			data: {
				id: 'checkout_abc123',
				checkout_id: 'checkout_abc123',
				pricing: { local: { amount: '9.99', currency: 'USD' } },
				metadata: { orderRef: 'order_001' },
			},
		},
	});
	return {
		body,
		timestamp: FIXED_NOW_SECONDS,
		headerNames: ['content-type', 'x-hook0-event-id'],
		headerValues: ['application/json', 'evt_abc123'],
	};
}

async function signedHeaders(
	s: SamplePayload,
	secret = WEBHOOK_SECRET,
): Promise<Record<string, string>> {
	const sig = await computeCoinbaseBusinessSignature(
		s.timestamp,
		s.headerNames,
		s.headerValues,
		s.body,
		secret,
	);
	const sigHeader = `t=${s.timestamp},h=${s.headerNames.join(' ')},v1=${sig}`;
	const out: Record<string, string> = { 'x-hook0-signature': sigHeader };
	for (let i = 0; i < s.headerNames.length; i++) {
		out[s.headerNames[i]] = s.headerValues[i];
	}
	return out;
}

describe('parseHook0Signature', () => {
	it('extracts t, h, v1 from a well-formed header', () => {
		const parsed = parseHook0Signature('t=1700000000,h=content-type x-event,v1=deadbeef');
		expect(parsed.timestamp).toBe(1700000000);
		expect(parsed.headerNames).toEqual(['content-type', 'x-event']);
		expect(parsed.signature).toBe('deadbeef');
	});

	it('handles the v0 legacy form where h is absent', () => {
		const parsed = parseHook0Signature('t=1700000000,v1=deadbeef');
		expect(parsed.timestamp).toBe(1700000000);
		expect(parsed.headerNames).toEqual([]);
		expect(parsed.signature).toBe('deadbeef');
	});

	it('throws when t is missing', () => {
		expect(() => parseHook0Signature('h=x,v1=deadbeef')).toThrow(/invalid `t`/);
	});

	it('throws when v1 is missing', () => {
		expect(() => parseHook0Signature('t=1700000000,h=x')).toThrow(/missing `v1`/);
	});
});

describe('computeCoinbaseBusinessSignature', () => {
	it('produces a 64-char hex SHA-256 digest', async () => {
		const s = sample();
		const sig = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		expect(sig).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic for the same inputs', async () => {
		const s = sample();
		const a = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		const b = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		expect(a).toBe(b);
	});

	it('changes when the body changes', async () => {
		const s = sample();
		const a = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		const b = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body + ' ',
			WEBHOOK_SECRET,
		);
		expect(a).not.toBe(b);
	});

	it('changes when the timestamp changes', async () => {
		const s = sample();
		const a = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		const b = await computeCoinbaseBusinessSignature(
			s.timestamp + 1,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		expect(a).not.toBe(b);
	});

	it('rejects mismatched headerNames / headerValues lengths', async () => {
		await expect(
			computeCoinbaseBusinessSignature(
				FIXED_NOW_SECONDS,
				['a', 'b'],
				['only-one-value'],
				'{}',
				WEBHOOK_SECRET,
			),
		).rejects.toThrow(/length mismatch/);
	});

	it('matches the Hook0 v1 reference: `${t}.${h}.${headerValues.join(".")}.${body}`', async () => {
		// Independently build the canonical string exactly the way Hook0's
		// public Node.js reference (documentation.hook0.com) describes, then
		// HMAC it via Web Crypto. If our `compute…Signature` agrees with this
		// hand-built value, our spec interpretation matches the reference.
		const s = sample();
		const canonical = `${s.timestamp}.${s.headerNames.join(' ')}.${s.headerValues.join('.')}.${s.body}`;
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(WEBHOOK_SECRET) as BufferSource,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
		const expected = Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		const actual = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		expect(actual).toBe(expected);
	});

	it('matches the Hook0 v0 legacy form (no h field) when headerNames is empty', async () => {
		// v0 reference: `${t}.${body}`. Some Hook0 producers still emit
		// signatures in this shape for backwards-compat; our verifier handles
		// both branches via the same compute function.
		const s = sample();
		const canonical = `${s.timestamp}.${s.body}`;
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(WEBHOOK_SECRET) as BufferSource,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical));
		const expected = Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');

		const actual = await computeCoinbaseBusinessSignature(
			s.timestamp,
			[],
			[],
			s.body,
			WEBHOOK_SECRET,
		);
		expect(actual).toBe(expected);
	});
});

describe('createCoinbaseBusinessVerifier', () => {
	function makeVerifier(overrides: { now?: number; maxAgeSeconds?: number } = {}) {
		return createCoinbaseBusinessVerifier({
			webhookSecret: WEBHOOK_SECRET,
			now: () => overrides.now ?? FIXED_NOW_SECONDS,
			maxAgeSeconds: overrides.maxAgeSeconds ?? Number.POSITIVE_INFINITY,
		});
	}

	it('maps checkout.payment.success to success and surfaces amount + paymentId', async () => {
		const verifier = makeVerifier();
		const s = sample('checkout.payment.success');
		const headers = await signedHeaders(s);

		const result = asPayment(await verifier.verify(s.body, headers));
		expect(result).not.toBeNull();
		expect(result?.status).toBe('success');
		expect(result?.provider).toBe('coinbase-business');
		expect(result?.paymentId).toBe('checkout_abc123');
		expect(result?.amount).toBe(9.99);
		expect(result?.currency).toBe('USD');
		expect((result?.metadata as { orderRef?: string }).orderRef).toBe('order_001');
		expect((result?.metadata as { coinbaseEventType?: string }).coinbaseEventType).toBe(
			'checkout.payment.success',
		);
	});

	it('maps checkout.payment.failed to failed', async () => {
		const verifier = makeVerifier();
		const s = sample('checkout.payment.failed');
		const headers = await signedHeaders(s);
		const result = asPayment(await verifier.verify(s.body, headers));
		expect(result?.status).toBe('failed');
	});

	it('maps checkout.payment.expired to failed (terminal negative)', async () => {
		const verifier = makeVerifier();
		const s = sample('checkout.payment.expired');
		const headers = await signedHeaders(s);
		const result = asPayment(await verifier.verify(s.body, headers));
		expect(result?.status).toBe('failed');
	});

	it('returns null for non-payment event types (still signature-verified)', async () => {
		const verifier = makeVerifier();
		const s = sample('checkout.created');
		const headers = await signedHeaders(s);
		const result = asPayment(await verifier.verify(s.body, headers));
		expect(result).toBeNull();
	});

	it('rejects a payload signed with the wrong secret', async () => {
		const verifier = makeVerifier();
		const s = sample();
		const headers = await signedHeaders(s, 'wrong_secret');
		await expect(verifier.verify(s.body, headers)).rejects.toThrow(/invalid signature/);
	});

	it('rejects a tampered body with a stale signature', async () => {
		const verifier = makeVerifier();
		const s = sample();
		const headers = await signedHeaders(s);
		const tampered = s.body.replace('9.99', '0.01');
		await expect(verifier.verify(tampered, headers)).rejects.toThrow(/invalid signature/);
	});

	it('rejects when the x-hook0-signature header is missing', async () => {
		const verifier = makeVerifier();
		await expect(verifier.verify(sample().body, {})).rejects.toThrow(/missing/);
	});

	it('rejects when the timestamp is outside the replay window', async () => {
		const verifier = makeVerifier({
			now: FIXED_NOW_SECONDS + 1000, // 1000s in the future
			maxAgeSeconds: 300,
		});
		const s = sample();
		const headers = await signedHeaders(s);
		await expect(verifier.verify(s.body, headers)).rejects.toThrow(/replay window/);
	});

	it('accepts both a raw JSON string body and a Uint8Array equivalently', async () => {
		const verifier = makeVerifier();
		const s = sample();
		const headers = await signedHeaders(s);
		const fromString = asPayment(await verifier.verify(s.body, headers));
		const fromBytes = asPayment(await verifier.verify(new TextEncoder().encode(s.body), headers));
		expect(fromString?.paymentId).toBe(fromBytes?.paymentId);
	});

	it('looks up h= header values case-insensitively', async () => {
		const verifier = makeVerifier();
		const s = sample();
		// Sign with lowercase names; deliver headers with mixed case.
		const sig = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			s.body,
			WEBHOOK_SECRET,
		);
		const headers: Record<string, string> = {
			'X-Hook0-Signature': `t=${s.timestamp},h=${s.headerNames.join(' ')},v1=${sig}`,
			'Content-Type': 'application/json',
			'X-Hook0-Event-Id': 'evt_abc123',
		};
		const result = asPayment(await verifier.verify(s.body, headers));
		expect(result?.status).toBe('success');
	});

	it('accepts an already-parsed object body (re-serialized internally)', async () => {
		const verifier = makeVerifier();
		const s = sample();
		// Sign the canonical JSON string, but call verify with the parsed
		// object — the verifier should JSON-stringify it back identically.
		const headers = await signedHeaders(s);
		const result = asPayment(await verifier.verify(JSON.parse(s.body) as object, headers));
		expect(result?.status).toBe('success');
	});

	it('rejects an unsupported body type (e.g., a number)', async () => {
		const verifier = makeVerifier();
		const s = sample();
		await expect(verifier.verify(42, await signedHeaders(s))).rejects.toThrow(
			/unsupported body type/,
		);
	});

	it('rejects a body that is not valid JSON', async () => {
		const verifier = makeVerifier();
		const s = sample();
		// Sign a bad payload string so the signature passes, then verify it
		// to exercise the JSON-parse error path.
		const bad = 'not-json-at-all';
		const sig = await computeCoinbaseBusinessSignature(
			s.timestamp,
			s.headerNames,
			s.headerValues,
			bad,
			WEBHOOK_SECRET,
		);
		const headers: Record<string, string> = {
			'x-hook0-signature': `t=${s.timestamp},h=${s.headerNames.join(' ')},v1=${sig}`,
		};
		for (let i = 0; i < s.headerNames.length; i++) {
			headers[s.headerNames[i]] = s.headerValues[i];
		}
		await expect(verifier.verify(bad, headers)).rejects.toThrow(/not valid JSON/);
	});

	it('rejects when webhookSecret is empty on the config', async () => {
		const v = createCoinbaseBusinessVerifier({
			webhookSecret: '',
			now: () => 1700000000,
			maxAgeSeconds: Number.POSITIVE_INFINITY,
		});
		await expect(v.verify(sample().body, {})).rejects.toThrow(/webhookSecret missing/);
	});

	it('reads the event_type from the flattened-envelope shape (top-level type field)', async () => {
		const verifier = makeVerifier();
		const flatBody = JSON.stringify({
			type: 'checkout.payment.success',
			data: {
				id: 'checkout_flat_envelope',
				checkout_id: 'checkout_flat_envelope',
				pricing: { local: { amount: '5.00', currency: 'USD' } },
			},
		});
		const sig = await computeCoinbaseBusinessSignature(
			1700000000,
			['content-type'],
			['application/json'],
			flatBody,
			WEBHOOK_SECRET,
		);
		const headers = {
			'x-hook0-signature': `t=1700000000,h=content-type,v1=${sig}`,
			'content-type': 'application/json',
		};
		const result = asPayment(await verifier.verify(flatBody, headers));
		expect(result?.status).toBe('success');
		expect(result?.paymentId).toBe('checkout_flat_envelope');
		expect(result?.amount).toBe(5);
	});
});
