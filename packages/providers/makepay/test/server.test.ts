import { describe, it, expect } from 'vitest';
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';
import {
	createMakepayVerifier,
	computeMakepaySignature,
	parseMakepaySignatureHeader,
	mapMakepaySessionStatus,
} from '../src/server.js';

/**
 * Unit tests for the MakePay webhook verifier. The signature scheme
 * (HMAC-SHA256 over `${t}.${rawBody}`, header `t=,v1=`) and both payload shapes
 * are taken from MakePay's official API docs, so we sign the exact body bytes
 * of the documented payloads and round-trip them through the verifier.
 */

const WEBHOOK_SECRET = 'whsec_test_unit_only';

/** Build the signed `X-MakePay-Signature` header for a raw body + timestamp. */
async function signHeader(
	rawBody: string,
	secret = WEBHOOK_SECRET,
	t = Math.floor(Date.now() / 1000),
): Promise<string> {
	const sig = await computeMakepaySignature(t, rawBody, secret);
	return `t=${t},v1=${sig}`;
}

/** The documented payment payload (makecrypto.io/documentation/api/webhooks). */
function paymentBody(
	over: { session?: Record<string, unknown>; link?: Record<string, unknown> } = {},
) {
	return JSON.stringify({
		deliveryId: '9f1c6cf4-8514-4ee5-80fd-8e8fe2b5e313',
		type: 'makepay.payment.status_changed',
		createdAt: '2026-04-19T00:00:00.000Z',
		event: { type: 'status_changed', trigger: 'payment_status_reconcile' },
		paymentLink: {
			id: '8d15bb78-d0f8-45ef-88d7-2a1f1f79644b',
			uid: '01hzy4k6p4w9y2x7e2z7n8a2xm',
			status: 'active',
			publicUrl: 'https://makepay.io/payment/01hzy4k6p4w9y2x7e2z7n8a2xm',
			amount: '129.99',
			currency: 'USDT',
			asset: 'ETH.USDT-0xdac17f958d2ee523a2206206994597c13d831ec7',
			label: 'Website order #1042',
			merchantOrderId: 'order_1042',
			clientEmail: 'buyer@example.com',
			clientId: null,
			...over.link,
		},
		session: {
			id: '5b55f0bb-0ac4-4f7c-a1d1-0d9af19c3bbd',
			status: 'complete',
			previousStatus: 'pending',
			invoiceAsset: 'USDT',
			invoiceAmount: '129.99',
			...over.session,
		},
	});
}

/** The documented subscription payload. */
function subscriptionBody(over: Record<string, unknown> = {}) {
	return JSON.stringify({
		deliveryId: '78c35c42-61fb-4dd3-94b7-2a7df998bb6f',
		type: 'makepay.subscription.status_changed',
		createdAt: '2026-04-20T00:00:00.000Z',
		event: { type: 'subscription_status_changed', trigger: 'subscription_scheduler' },
		subscription: {
			id: 'f6b76460-a437-4a81-a59f-8fcbb18c0f0f',
			uid: 'sub_premium_001',
			status: 'overdue',
			previousStatus: 'active',
			customerEmail: 'buyer@example.com',
			label: 'Premium plan',
			amountUsd: '49.99',
			cadence: 'monthly',
			billingIntervalUnit: 'month',
			billingIntervalCount: 1,
			metadata: { clientId: 'client_1042' },
			...over,
		},
		cycle: {
			dueAt: '2026-04-18T00:00:00.000Z',
			amountUsd: '49.99',
			paymentLinkUid: '01hzy4k6p4w9y2x7e2z7n8a2xm',
			status: 'overdue',
		},
	});
}

describe('computeMakepaySignature', () => {
	it('produces a hex SHA256 (64 chars)', async () => {
		const sig = await computeMakepaySignature(1700000000, '{"a":1}', WEBHOOK_SECRET);
		expect(sig).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic and changes when the body or timestamp changes', async () => {
		const a = await computeMakepaySignature(123, '{"a":1}', WEBHOOK_SECRET);
		const b = await computeMakepaySignature(123, '{"a":1}', WEBHOOK_SECRET);
		const c = await computeMakepaySignature(123, '{"a":2}', WEBHOOK_SECRET);
		const d = await computeMakepaySignature(124, '{"a":1}', WEBHOOK_SECRET);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).not.toBe(d);
	});

	it('matches an independently-computed reference digest (docs Node example)', async () => {
		// Cross-checks our WebCrypto digest against a hand-built control so a
		// future refactor can't silently change the signing bytes.
		const body = '{"event":{"type":"status_changed"}}';
		const sig = await computeMakepaySignature(1776556800, body, 'whsec_test');
		const control = await referenceHmacSha256Hex(`1776556800.${body}`, 'whsec_test');
		expect(sig).toBe(control);
	});
});

describe('parseMakepaySignatureHeader', () => {
	it('parses t and v1, tolerating whitespace', () => {
		expect(parseMakepaySignatureHeader('t=1776556800,v1=deadBEEF')).toEqual({
			t: 1776556800,
			v1: 'deadBEEF',
		});
		expect(parseMakepaySignatureHeader('t=123, v1=abcd')).toEqual({ t: 123, v1: 'abcd' });
	});

	it('returns null for a missing/invalid timestamp or non-hex signature', () => {
		expect(parseMakepaySignatureHeader('v1=abcd')).toBeNull();
		expect(parseMakepaySignatureHeader('t=notanumber,v1=abcd')).toBeNull();
		expect(parseMakepaySignatureHeader('t=123,v1=nothex!!')).toBeNull();
	});
});

describe('mapMakepaySessionStatus', () => {
	it('maps ONLY session.status "complete" to success', () => {
		expect(mapMakepaySessionStatus('complete')).toBe('success');
		expect(mapMakepaySessionStatus('COMPLETE')).toBe('success');
	});

	it('maps documented terminal non-payment event types to failed', () => {
		for (const e of ['payment_request_expired', 'quote_expired', 'payment_cancelled_by_payer']) {
			expect(mapMakepaySessionStatus('pending', e)).toBe('failed');
		}
	});

	it('SAFETY: pending / unknown session status never maps to success', () => {
		for (const s of ['pending', 'channel_created', 'mystery_state', undefined]) {
			expect(mapMakepaySessionStatus(s)).toBe('pending');
		}
	});

	it('maps explicit failure/underpayment session statuses', () => {
		for (const s of ['expired', 'cancelled', 'failed']) {
			expect(mapMakepaySessionStatus(s)).toBe('failed');
		}
		expect(mapMakepaySessionStatus('underpaid')).toBe('partial');
	});
});

describe('createMakepayVerifier — payment deliveries', () => {
	it('accepts a validly signed completed payment and normalizes it from session.status', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = paymentBody();
		const header = await signHeader(body);

		const result = asPayment(
			await verify(body, {
				'x-makepay-signature': header,
				'x-makepay-delivery-id': 'dlv_1',
			}),
		);
		expect(result!.status).toBe('success');
		expect(result!.provider).toBe('makepay');
		expect(result!.paymentId).toBe('01hzy4k6p4w9y2x7e2z7n8a2xm');
		expect(result!.amount).toBe(129.99);
		expect(result!.currency).toBe('USDT');
		const md = result!.metadata as Record<string, string>;
		expect(md.merchantOrderId).toBe('order_1042');
		expect(md.customerEmail).toBe('buyer@example.com');
		expect(md.deliveryId).toBe('dlv_1');
	});

	it('treats a still-pending session as pending even though the link status is active', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = paymentBody({ session: { status: 'pending' } });
		const header = await signHeader(body);
		const result = asPayment(await verify(body, { 'x-makepay-signature': header }));
		// paymentLink.status is "active" — must NOT be read as the payment state.
		expect(result!.status).toBe('pending');
	});

	it('reads the signature header case-insensitively', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = paymentBody();
		const header = await signHeader(body);
		const result = asPayment(await verify(body, { 'X-MakePay-Signature': header }));
		expect(result!.status).toBe('success');
	});

	it('rejects a body signed with the wrong secret', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = paymentBody();
		const header = await signHeader(body, 'wrong_secret');
		await expect(verify(body, { 'x-makepay-signature': header })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a tampered body (signature no longer matches the bytes)', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const header = await signHeader(paymentBody());
		const tampered = paymentBody({ link: { amount: '99999' } });
		await expect(verify(tampered, { 'x-makepay-signature': header })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a delivery whose timestamp is outside the tolerance window', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET, toleranceSeconds: 300 });
		const body = paymentBody();
		const staleT = Math.floor(Date.now() / 1000) - 10_000;
		const header = await signHeader(body, WEBHOOK_SECRET, staleT);
		await expect(verify(body, { 'x-makepay-signature': header })).rejects.toThrow(/tolerance/);
	});

	it('rejects a missing or malformed signature header', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		await expect(verify(paymentBody(), {})).rejects.toThrow(/missing/);
		await expect(
			verify(paymentBody(), { 'x-makepay-signature': 'not-a-valid-header' }),
		).rejects.toThrow(/malformed/);
	});

	it('rejects a non-string body (cannot verify exact signed bytes)', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const header = await signHeader(paymentBody());
		await expect(
			verify({ event: { type: 'status_changed' } }, { 'x-makepay-signature': header }),
		).rejects.toThrow(/string.*required/);
	});

	it('throws when no webhook secret is configured', async () => {
		const verify = createMakepayVerifier({ webhookSecret: '' });
		await expect(verify(paymentBody(), { 'x-makepay-signature': 't=1,v1=ab' })).rejects.toThrow(
			/webhookSecret missing/,
		);
	});
});

describe('createMakepayVerifier — subscription deliveries', () => {
	it('normalizes an overdue subscription to a payment_failed/past_due event', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = subscriptionBody();
		const header = await signHeader(body);

		const sub = asSubscription(await verify(body, { 'x-makepay-signature': header }));
		expect(sub).not.toBeNull();
		expect(sub!.type).toBe('subscription.payment_failed');
		expect(sub!.status).toBe('past_due');
		expect(sub!.subscriptionId).toBe('sub_premium_001');
		expect(sub!.provider).toBe('makepay');
		expect(sub!.customerRef).toBe('buyer@example.com');
		expect(sub!.amount).toBe(49.99);
		expect(sub!.currency).toBe('USD');
		// dueAt → unix seconds for 2026-04-18T00:00:00Z
		expect(sub!.currentPeriodEnd).toBe(Math.floor(Date.parse('2026-04-18T00:00:00.000Z') / 1000));
	});

	it('maps a cancelled subscription to canceled and active to updated', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });

		const cancelledBody = subscriptionBody({ status: 'cancelled' });
		const cancelled = asSubscription(
			await verify(cancelledBody, { 'x-makepay-signature': await signHeader(cancelledBody) }),
		);
		expect(cancelled!.type).toBe('subscription.canceled');
		expect(cancelled!.status).toBe('canceled');

		const activeBody = subscriptionBody({ status: 'active' });
		const active = asSubscription(
			await verify(activeBody, { 'x-makepay-signature': await signHeader(activeBody) }),
		);
		expect(active!.type).toBe('subscription.updated');
		expect(active!.status).toBe('active');
	});

	it('maps a paused subscription to updated/paused and an unknown status to updated/unknown', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });

		const pausedBody = subscriptionBody({ status: 'paused' });
		const paused = asSubscription(
			await verify(pausedBody, { 'x-makepay-signature': await signHeader(pausedBody) }),
		);
		expect(paused!.type).toBe('subscription.updated');
		expect(paused!.status).toBe('paused');

		// An unrecognized status stays safe: updated event, unknown status, and a
		// missing/invalid cycle dueAt yields a null currentPeriodEnd.
		const mysteryBody = subscriptionBody({ status: 'mystery_state' });
		const mystery = asSubscription(
			await verify(mysteryBody, { 'x-makepay-signature': await signHeader(mysteryBody) }),
		);
		expect(mystery!.type).toBe('subscription.updated');
		expect(mystery!.status).toBe('unknown');
	});
});

describe('createMakepayVerifier — defensive field handling', () => {
	it('throws on a validly-signed body that is not valid JSON', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const notJson = 'this-is-not-json';
		const header = await signHeader(notJson);
		await expect(verify(notJson, { 'x-makepay-signature': header })).rejects.toThrow(
			/not valid JSON/,
		);
	});

	it('maps a documented terminal non-payment event type to failed', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = JSON.stringify({
			type: 'makepay.payment.status_changed',
			event: { type: 'payment_request_expired', trigger: 'expiry' },
			paymentLink: { uid: 'pl_x', merchantOrderId: 'order_x' },
			session: { id: 'sess_x', status: 'pending' },
		});
		const result = asPayment(await verify(body, { 'x-makepay-signature': await signHeader(body) }));
		expect(result!.status).toBe('failed');
	});

	it('falls back to session id, invoice amount/asset, and body deliveryId when link fields are absent', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = JSON.stringify({
			deliveryId: 'body_dlv_42',
			type: 'makepay.payment.status_changed',
			event: { type: 'status_changed' },
			// no paymentLink.uid / amount / currency — exercise the fallbacks
			paymentLink: { merchantOrderId: 'order_y' },
			session: {
				id: 'sess_y',
				status: 'complete',
				invoiceAmount: 42.5,
				invoiceAsset: 'usdc',
			},
		});
		// No x-makepay-delivery-id header — deliveryId must come from the body.
		const result = asPayment(await verify(body, { 'x-makepay-signature': await signHeader(body) }));
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe('sess_y');
		expect(result!.amount).toBe(42.5);
		expect(result!.currency).toBe('USDC');
		expect((result!.metadata as Record<string, string>).deliveryId).toBe('body_dlv_42');
	});

	it('coerces a non-numeric amount to 0 without throwing', async () => {
		const verify = createMakepayVerifier({ webhookSecret: WEBHOOK_SECRET });
		const body = paymentBody({ link: { amount: 'not-a-number' }, session: { status: 'complete' } });
		const result = asPayment(await verify(body, { 'x-makepay-signature': await signHeader(body) }));
		expect(result!.amount).toBe(0);
	});
});

/** A self-contained HMAC-SHA256 hex reference, independent of the impl under test. */
async function referenceHmacSha256Hex(message: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
