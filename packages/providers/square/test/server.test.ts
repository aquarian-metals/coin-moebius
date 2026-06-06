import { describe, it, expect } from 'vitest';
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';
import { createSquareVerifier, computeSquareSignature, getSquarePortalUrl } from '../src/server.js';

const SIGNATURE_KEY = 'sq0sig_unit_test_key';
const NOTIFICATION_URL = 'https://example.com/webhooks/square';

interface BuildEventOptions {
	type?: string;
	paymentStatus?: string;
	refundStatus?: string;
	amount?: number;
	currency?: string;
}

function event(opts: BuildEventOptions = {}): string {
	const type = opts.type ?? 'payment.updated';
	const amount = opts.amount ?? 999; // smallest-currency-unit (cents) = $9.99
	const currency = opts.currency ?? 'USD';

	if (type.startsWith('payment.')) {
		return JSON.stringify({
			merchant_id: 'M_TEST',
			type,
			event_id: 'evt_001',
			created_at: '2026-05-19T18:00:00Z',
			data: {
				type: 'payment',
				id: 'payment_event_id',
				object: {
					payment: {
						id: 'PAYMENT_ABC',
						status: opts.paymentStatus ?? 'COMPLETED',
						amount_money: { amount, currency },
						order_id: 'ORDER_X',
					},
				},
			},
		});
	}
	if (type.startsWith('refund.')) {
		return JSON.stringify({
			merchant_id: 'M_TEST',
			type,
			event_id: 'evt_002',
			data: {
				type: 'refund',
				id: 'refund_event_id',
				object: {
					refund: {
						id: 'REFUND_ABC',
						status: opts.refundStatus ?? 'COMPLETED',
						amount_money: { amount, currency },
						payment_id: 'PAYMENT_ABC',
					},
				},
			},
		});
	}
	// dispute.*
	return JSON.stringify({
		merchant_id: 'M_TEST',
		type,
		event_id: 'evt_003',
		data: {
			type: 'dispute',
			id: 'dispute_event_id',
			object: {
				dispute: {
					id: 'DISPUTE_ABC',
					state: 'INQUIRY_EVIDENCE_REQUIRED',
					amount_money: { amount, currency },
					disputed_payment: { payment_id: 'PAYMENT_ABC' },
				},
			},
		},
	});
}

async function signedHeaders(
	body: string,
	notificationUrl = NOTIFICATION_URL,
	key = SIGNATURE_KEY,
): Promise<Record<string, string>> {
	const sig = await computeSquareSignature(notificationUrl, new TextEncoder().encode(body), key);
	return { 'x-square-hmacsha256-signature': sig };
}

describe('computeSquareSignature', () => {
	it('produces a 44-char base64 SHA-256 digest', async () => {
		const sig = await computeSquareSignature(
			NOTIFICATION_URL,
			new TextEncoder().encode(event()),
			SIGNATURE_KEY,
		);
		// HMAC-SHA256 → 32 bytes → 44 chars base64 (with padding)
		expect(sig).toMatch(/^[A-Za-z0-9+/]{43}=$/);
	});

	it('is deterministic for the same inputs', async () => {
		const body = event();
		const a = await computeSquareSignature(
			NOTIFICATION_URL,
			new TextEncoder().encode(body),
			SIGNATURE_KEY,
		);
		const b = await computeSquareSignature(
			NOTIFICATION_URL,
			new TextEncoder().encode(body),
			SIGNATURE_KEY,
		);
		expect(a).toBe(b);
	});

	it('changes when the notification URL changes (URL is part of the signed payload)', async () => {
		const body = event();
		const a = await computeSquareSignature(
			NOTIFICATION_URL,
			new TextEncoder().encode(body),
			SIGNATURE_KEY,
		);
		const b = await computeSquareSignature(
			NOTIFICATION_URL + '/extra',
			new TextEncoder().encode(body),
			SIGNATURE_KEY,
		);
		expect(a).not.toBe(b);
	});
});

describe('createSquareVerifier', () => {
	function makeVerifier() {
		return createSquareVerifier({
			signatureKey: SIGNATURE_KEY,
			notificationUrl: NOTIFICATION_URL,
		});
	}

	it('maps payment.updated with status COMPLETED to success', async () => {
		const verifier = makeVerifier();
		const body = event({ paymentStatus: 'COMPLETED' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('success');
		expect(result?.provider).toBe('square');
		expect(result?.paymentId).toBe('PAYMENT_ABC');
		expect(result?.amount).toBe(9.99);
		expect(result?.currency).toBe('USD');
	});

	it('maps payment.created to pending', async () => {
		const verifier = makeVerifier();
		const body = event({ type: 'payment.created', paymentStatus: 'APPROVED' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('pending');
	});

	it('maps payment.updated with APPROVED to pending (auth-only state)', async () => {
		const verifier = makeVerifier();
		const body = event({ paymentStatus: 'APPROVED' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('pending');
	});

	it('maps payment.updated with FAILED or CANCELED to failed', async () => {
		const verifier = makeVerifier();
		for (const status of ['FAILED', 'CANCELED']) {
			const body = event({ paymentStatus: status });
			const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
			expect(result?.status).toBe('failed');
		}
	});

	it('maps refund.created to pending', async () => {
		const verifier = makeVerifier();
		const body = event({ type: 'refund.created' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('pending');
	});

	it('maps refund.updated with COMPLETED to refunded', async () => {
		const verifier = makeVerifier();
		const body = event({ type: 'refund.updated', refundStatus: 'COMPLETED' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('refunded');
	});

	it('maps refund.updated with FAILED or REJECTED to failed', async () => {
		const verifier = makeVerifier();
		for (const status of ['FAILED', 'REJECTED']) {
			const body = event({ type: 'refund.updated', refundStatus: status });
			const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
			expect(result?.status).toBe('failed');
		}
	});

	it('maps dispute.created and dispute.state.updated to disputed', async () => {
		const verifier = makeVerifier();
		for (const type of ['dispute.created', 'dispute.state.updated']) {
			const body = event({ type });
			const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
			expect(result?.status).toBe('disputed');
		}
	});

	it('returns null for unrecognized event types (signature still validated)', async () => {
		const verifier = makeVerifier();
		const body = JSON.stringify({
			merchant_id: 'M',
			type: 'oauth.authorization.revoked',
			event_id: 'evt_other',
			data: { type: 'oauth', id: 'x' },
		});
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result).toBeNull();
	});

	it('rejects a signature computed against a different notification URL', async () => {
		const verifier = makeVerifier();
		const body = event();
		const wrongUrlHeaders = await signedHeaders(body, 'https://attacker.example/webhooks/square');
		await expect(verifier.verify(body, wrongUrlHeaders)).rejects.toThrow(/invalid signature/);
	});

	it('rejects a payload signed with the wrong key', async () => {
		const verifier = makeVerifier();
		const body = event();
		const wrongKeyHeaders = await signedHeaders(body, NOTIFICATION_URL, 'wrong_key');
		await expect(verifier.verify(body, wrongKeyHeaders)).rejects.toThrow(/invalid signature/);
	});

	it('rejects a tampered body with a stale signature', async () => {
		const verifier = makeVerifier();
		const body = event();
		const headers = await signedHeaders(body);
		const tampered = body.replace('"amount":999', '"amount":1');
		await expect(verifier.verify(tampered, headers)).rejects.toThrow(/invalid signature/);
	});

	it('rejects when the signature header is missing', async () => {
		const verifier = makeVerifier();
		await expect(verifier.verify(event(), {})).rejects.toThrow(/missing/);
	});

	it('rejects when signatureKey is empty', async () => {
		const v = createSquareVerifier({ signatureKey: '', notificationUrl: NOTIFICATION_URL });
		await expect(v.verify(event(), await signedHeaders(event()))).rejects.toThrow(
			/signatureKey missing/,
		);
	});

	it('rejects when notificationUrl is empty', async () => {
		const v = createSquareVerifier({ signatureKey: SIGNATURE_KEY, notificationUrl: '' });
		await expect(v.verify(event(), await signedHeaders(event()))).rejects.toThrow(
			/notificationUrl missing/,
		);
	});

	it('accepts both a string body and a Uint8Array equivalently', async () => {
		const verifier = makeVerifier();
		const body = event();
		const headers = await signedHeaders(body);
		const fromString = asPayment(await verifier.verify(body, headers));
		const fromBytes = asPayment(await verifier.verify(new TextEncoder().encode(body), headers));
		expect(fromString?.paymentId).toBe(fromBytes?.paymentId);
	});

	it('preserves the currency from the payload (not hard-coded)', async () => {
		const verifier = makeVerifier();
		const body = event({ currency: 'CAD', amount: 1500 });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.currency).toBe('CAD');
		expect(result?.amount).toBe(15);
	});

	it('treats an unknown payment.updated inner status as pending (defensive default)', async () => {
		const verifier = makeVerifier();
		const body = event({ paymentStatus: 'WEIRD_NEW_STATUS' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('pending');
	});

	it('treats an unknown refund.updated inner status as pending (defensive default)', async () => {
		const verifier = makeVerifier();
		const body = event({ type: 'refund.updated', refundStatus: 'WEIRD_NEW_STATUS' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('pending');
	});

	it('defaults to USD when a dispute payload omits amount_money.currency', async () => {
		const verifier = makeVerifier();
		const body = JSON.stringify({
			merchant_id: 'M',
			type: 'dispute.created',
			event_id: 'evt_no_money',
			data: {
				type: 'dispute',
				object: { dispute: { id: 'D', disputed_payment: { payment_id: 'P' } } },
			},
		});
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.currency).toBe('USD');
		expect(result?.amount).toBe(0);
	});

	it('accepts an object body (re-serialized internally)', async () => {
		const verifier = makeVerifier();
		const body = event();
		const headers = await signedHeaders(body);
		const result = asPayment(await verifier.verify(JSON.parse(body) as object, headers));
		expect(result?.status).toBe('success');
	});

	it('rejects an unsupported body type (e.g., a number)', async () => {
		const verifier = makeVerifier();
		await expect(verifier.verify(42, await signedHeaders(event()))).rejects.toThrow(
			/unsupported body type/,
		);
	});

	it('rejects a body that is not valid JSON', async () => {
		const verifier = makeVerifier();
		const bad = 'not-json-at-all';
		const sig = await computeSquareSignature(
			NOTIFICATION_URL,
			new TextEncoder().encode(bad),
			SIGNATURE_KEY,
		);
		await expect(verifier.verify(bad, { 'x-square-hmacsha256-signature': sig })).rejects.toThrow(
			/not valid JSON/,
		);
	});
});

function makeVerifier() {
	return createSquareVerifier({
		signatureKey: SIGNATURE_KEY,
		notificationUrl: NOTIFICATION_URL,
	});
}

function subscriptionEventBody(type: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		merchant_id: 'M_TEST',
		type,
		event_id: 'evt_' + Math.random().toString(36).slice(2, 10),
		created_at: '2026-05-22T10:00:00Z',
		data: {
			type: 'subscription',
			id: 'sq_sub_123',
			object: {
				subscription: {
					id: 'sq_sub_123',
					status: 'ACTIVE',
					plan_variation_id: 'plan_pro_monthly',
					customer_id: 'sq_cust_42',
					location_id: 'loc_main',
					charged_through_date: '2026-06-22',
					...overrides,
				},
			},
		},
	});
}

function invoiceEventBody(
	type: 'invoice.payment_made' | 'invoice.scheduled_charge_failed',
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		merchant_id: 'M_TEST',
		type,
		event_id: 'evt_' + Math.random().toString(36).slice(2, 10),
		created_at: '2026-05-22T10:00:00Z',
		data: {
			type: 'invoice',
			object: {
				invoice: {
					id: 'inv_123',
					subscription_id: 'sq_sub_123',
					status: 'PAID',
					payment_requests: [{ computed_amount_money: { amount: 999, currency: 'USD' } }],
					...overrides,
				},
			},
		},
	});
}

describe('event → SubscriptionEvent mapping (Square)', () => {
	it('maps subscription.created to subscription.created with active status', async () => {
		const verifier = makeVerifier();
		const body = subscriptionEventBody('subscription.created');
		const result = asSubscription(await verifier.verify(body, await signedHeaders(body)));
		expect(result).not.toBeNull();
		expect(result!.type).toBe('subscription.created');
		expect(result!.subscriptionId).toBe('sq_sub_123');
		expect(result!.provider).toBe('square');
		expect(result!.productId).toBe('plan_pro_monthly');
		expect(result!.customerRef).toBe('sq_cust_42');
		expect(result!.status).toBe('active');
		// charged_through_date 2026-06-22 → midnight UTC → unix seconds
		const expectedSeconds = Math.floor(Date.parse('2026-06-22T00:00:00Z') / 1000);
		expect(result!.currentPeriodEnd).toBe(expectedSeconds);
	});

	it('maps invoice.payment_made with subscription_id to subscription.renewed', async () => {
		const verifier = makeVerifier();
		const body = invoiceEventBody('invoice.payment_made');
		const result = asSubscription(await verifier.verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.renewed');
		expect(result!.subscriptionId).toBe('sq_sub_123');
		expect(result!.amount).toBeCloseTo(9.99, 2);
		expect(result!.currency).toBe('USD');
	});

	it('ignores invoice.payment_made when not linked to a subscription', async () => {
		// One-time invoice payments shouldn't trigger a renewal event.
		const verifier = makeVerifier();
		const body = JSON.stringify({
			merchant_id: 'M_TEST',
			type: 'invoice.payment_made',
			event_id: 'evt_one_time',
			data: {
				type: 'invoice',
				object: {
					invoice: { id: 'inv_one', status: 'PAID' },
				},
			},
		});
		const event = await verifier.verify(body, await signedHeaders(body));
		expect(event).toBeNull();
	});

	it('maps invoice.scheduled_charge_failed to subscription.payment_failed', async () => {
		const verifier = makeVerifier();
		const body = invoiceEventBody('invoice.scheduled_charge_failed');
		const result = asSubscription(await verifier.verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.payment_failed');
		expect(result!.status).toBe('past_due');
	});

	it('maps subscription.updated to subscription.updated', async () => {
		const verifier = makeVerifier();
		const body = subscriptionEventBody('subscription.updated', { status: 'PAUSED' });
		const result = asSubscription(await verifier.verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.updated');
		expect(result!.status).toBe('paused');
	});

	it('maps subscription.canceled to subscription.canceled', async () => {
		const verifier = makeVerifier();
		const body = subscriptionEventBody('subscription.canceled', { status: 'CANCELED' });
		const result = asSubscription(await verifier.verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.canceled');
		expect(result!.status).toBe('canceled');
	});
});

describe('getSquarePortalUrl', () => {
	it('returns the merchant dashboard subscriptions index by default', () => {
		expect(getSquarePortalUrl()).toBe('https://squareup.com/dashboard/subscriptions');
	});

	it('deep-links to a specific subscription when given an id', () => {
		expect(getSquarePortalUrl({ subscriptionId: 'sq_sub_xyz' })).toBe(
			'https://squareup.com/dashboard/subscriptions/sq_sub_xyz',
		);
	});

	it('uses the sandbox host when mode is sandbox', () => {
		expect(getSquarePortalUrl({ mode: 'sandbox' })).toBe(
			'https://app.squareupsandbox.com/dashboard/subscriptions',
		);
	});
});
