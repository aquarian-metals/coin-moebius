import { describe, it, expect } from 'vitest';
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';
import {
	createDodoPaymentsVerifier,
	computeDodoSignature,
	type DodoWebhookPayload,
} from '../src/server.js';

/**
 * Unit tests for the Dodo Payments Standard Webhooks verifier. We sign a raw
 * body string with `computeDodoSignature` and feed the exact same string back
 * to the verifier — if the signed-content construction or base64 secret decode
 * were wrong, the round-trip would fail.
 */

// `whsec_` + base64("secret-key-for-dodo-tests").
const WEBHOOK_SECRET = 'whsec_c2VjcmV0LWtleS1mb3ItZG9kby10ZXN0cw==';
const WEBHOOK_ID = 'evt_2KWPBgLlAfxdpx2AI54pPJ85f4W';

function nowSeconds(): string {
	return String(Math.floor(Date.now() / 1000));
}

/** Build a signed delivery: stringify once, sign that exact string. */
async function signedDelivery(
	payload: DodoWebhookPayload,
	opts: { secret?: string; id?: string; timestamp?: string } = {},
): Promise<{ body: string; headers: Record<string, string> }> {
	const secret = opts.secret ?? WEBHOOK_SECRET;
	const id = opts.id ?? WEBHOOK_ID;
	const timestamp = opts.timestamp ?? nowSeconds();
	const body = JSON.stringify(payload);
	const sig = await computeDodoSignature(id, timestamp, body, secret);
	return {
		body,
		headers: {
			'webhook-id': id,
			'webhook-timestamp': timestamp,
			'webhook-signature': `v1,${sig}`,
		},
	};
}

function paymentPayload(overrides: Partial<DodoWebhookPayload['data']> = {}): DodoWebhookPayload {
	return {
		business_id: 'bus_123',
		type: 'payment.succeeded',
		timestamp: '2026-05-31T12:00:00Z',
		data: {
			payload_type: 'Payment',
			payment_id: 'pay_abc123',
			total_amount: 2999,
			currency: 'usd',
			status: 'succeeded',
			customer: { customer_id: 'cust_1', email: 'buyer@example.com', name: 'Jane' },
			metadata: { orderRef: 'order_7' },
			...overrides,
		},
	};
}

function subscriptionPayload(
	type: string,
	overrides: Partial<DodoWebhookPayload['data']> = {},
): DodoWebhookPayload {
	return {
		business_id: 'bus_123',
		type,
		timestamp: '2026-05-31T12:00:00Z',
		data: {
			payload_type: 'Subscription',
			subscription_id: 'sub_xyz',
			product_id: 'prod_pro',
			recurring_pre_tax_amount: 1500,
			currency: 'usd',
			status: 'active',
			next_billing_date: '2026-06-30T12:00:00Z',
			customer: { customer_id: 'cust_1', email: 'buyer@example.com' },
			metadata: { plan: 'pro' },
			...overrides,
		},
	};
}

describe('computeDodoSignature', () => {
	it('produces a base64 string and is deterministic', async () => {
		const a = await computeDodoSignature(WEBHOOK_ID, '1700000000', '{"a":1}', WEBHOOK_SECRET);
		const b = await computeDodoSignature(WEBHOOK_ID, '1700000000', '{"a":1}', WEBHOOK_SECRET);
		expect(a).toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9+/]+=*$/);
	});

	it('changes when the body, id, or timestamp changes', async () => {
		const base = await computeDodoSignature(WEBHOOK_ID, '1700000000', '{"a":1}', WEBHOOK_SECRET);
		expect(
			await computeDodoSignature(WEBHOOK_ID, '1700000000', '{"a":2}', WEBHOOK_SECRET),
		).not.toBe(base);
		expect(
			await computeDodoSignature(WEBHOOK_ID, '1700000001', '{"a":1}', WEBHOOK_SECRET),
		).not.toBe(base);
		expect(
			await computeDodoSignature('evt_other', '1700000000', '{"a":1}', WEBHOOK_SECRET),
		).not.toBe(base);
	});

	it('decodes a secret with or without the whsec_ prefix to the same key', async () => {
		const withPrefix = await computeDodoSignature(WEBHOOK_ID, '1700000000', '{}', WEBHOOK_SECRET);
		const withoutPrefix = await computeDodoSignature(
			WEBHOOK_ID,
			'1700000000',
			'{}',
			WEBHOOK_SECRET.slice('whsec_'.length),
		);
		expect(withPrefix).toBe(withoutPrefix);
	});
});

describe('createDodoPaymentsVerifier — payment events', () => {
	it('accepts a valid delivery and maps payment.succeeded to success', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(paymentPayload());

		const result = asPayment(await verify(body, headers));
		expect(result!.status).toBe('success');
		expect(result!.provider).toBe('dodopayments');
		expect(result!.paymentId).toBe('pay_abc123');
		expect(result!.amount).toBe(29.99); // 2999 minor units → major
		expect(result!.currency).toBe('USD');
		expect(result!.metadata).toMatchObject({ orderRef: 'order_7', email: 'buyer@example.com' });
	});

	it('maps payment.processing to pending', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery({
			...paymentPayload(),
			type: 'payment.processing',
		});
		const result = asPayment(await verify(body, headers));
		expect(result!.status).toBe('pending');
	});

	it('maps payment.failed and payment.cancelled to failed', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		for (const type of ['payment.failed', 'payment.cancelled']) {
			const { body, headers } = await signedDelivery({ ...paymentPayload(), type });
			const result = asPayment(await verify(body, headers));
			expect(result!.status).toBe('failed');
		}
	});

	it('maps refund.succeeded to refunded, keyed on the original payment_id with the refund amount', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const payload: DodoWebhookPayload = {
			business_id: 'bus_123',
			type: 'refund.succeeded',
			timestamp: '2026-05-31T12:00:00Z',
			data: {
				payload_type: 'Refund',
				payment_id: 'pay_abc123',
				amount: 1000,
				currency: 'usd',
				status: 'succeeded',
			},
		};
		const { body, headers } = await signedDelivery(payload);
		const result = asPayment(await verify(body, headers));
		expect(result!.status).toBe('refunded');
		expect(result!.paymentId).toBe('pay_abc123');
		expect(result!.amount).toBe(10);
	});

	it('maps dispute.opened to disputed', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const payload: DodoWebhookPayload = {
			business_id: 'bus_123',
			type: 'dispute.opened',
			timestamp: '2026-05-31T12:00:00Z',
			data: {
				payload_type: 'Dispute',
				payment_id: 'pay_abc123',
				total_amount: 2999,
				currency: 'usd',
			},
		};
		const { body, headers } = await signedDelivery(payload);
		const result = asPayment(await verify(body, headers));
		expect(result!.status).toBe('disputed');
		expect(result!.paymentId).toBe('pay_abc123');
	});

	it('returns null for unmodeled events (payout, license_key, refund.failed, dispute resolution)', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		for (const type of ['payout.success', 'license_key.created', 'refund.failed', 'dispute.won']) {
			const { body, headers } = await signedDelivery({ ...paymentPayload(), type });
			expect(await verify(body, headers)).toBeNull();
		}
	});
});

describe('createDodoPaymentsVerifier — subscription events', () => {
	it('maps subscription.active to subscription.created with active status', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(subscriptionPayload('subscription.active'));
		const sub = asSubscription(await verify(body, headers));
		expect(sub!.type).toBe('subscription.created');
		expect(sub!.status).toBe('active');
		expect(sub!.subscriptionId).toBe('sub_xyz');
		expect(sub!.productId).toBe('prod_pro');
		expect(sub!.customerRef).toBe('cust_1');
		expect(sub!.amount).toBe(15); // 1500 minor → major
		expect(sub!.currency).toBe('USD');
		expect(sub!.currentPeriodEnd).toBe(Math.floor(Date.parse('2026-06-30T12:00:00Z') / 1000));
	});

	it('maps subscription.renewed to renewed', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(subscriptionPayload('subscription.renewed'));
		const sub = asSubscription(await verify(body, headers));
		expect(sub!.type).toBe('subscription.renewed');
	});

	it('maps subscription.failed to payment_failed with past_due status', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(
			subscriptionPayload('subscription.failed', { status: 'failed' }),
		);
		const sub = asSubscription(await verify(body, headers));
		expect(sub!.type).toBe('subscription.payment_failed');
		expect(sub!.status).toBe('past_due');
	});

	it('maps subscription.cancelled and subscription.expired to canceled', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		for (const [type, status] of [
			['subscription.cancelled', 'cancelled'],
			['subscription.expired', 'expired'],
		]) {
			const { body, headers } = await signedDelivery(subscriptionPayload(type, { status }));
			const sub = asSubscription(await verify(body, headers));
			expect(sub!.type).toBe('subscription.canceled');
			expect(sub!.status).toBe('canceled');
		}
	});

	it('maps subscription.on_hold to updated with past_due status', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(
			subscriptionPayload('subscription.on_hold', { status: 'on_hold' }),
		);
		const sub = asSubscription(await verify(body, headers));
		expect(sub!.type).toBe('subscription.updated');
		expect(sub!.status).toBe('past_due');
	});
});

describe('createDodoPaymentsVerifier — verification failures', () => {
	it('rejects a delivery signed with the wrong secret', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(paymentPayload(), {
			secret: 'whsec_d3Jvbmctc2VjcmV0LXZhbHVl',
		});
		await expect(verify(body, headers)).rejects.toThrow(/invalid signature/);
	});

	it('rejects a tampered body with a stale signature', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { headers } = await signedDelivery(paymentPayload());
		const tampered = JSON.stringify({ ...paymentPayload(), data: { total_amount: 99999 } });
		await expect(verify(tampered, headers)).rejects.toThrow(/invalid signature/);
	});

	it('matches when the header carries multiple rotated signatures', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(paymentPayload());
		const rotated = {
			...headers,
			'webhook-signature': `v1,AAAAdecoysignatureAAAA= ${headers['webhook-signature']}`,
		};
		const result = asPayment(await verify(body, rotated));
		expect(result!.status).toBe('success');
	});

	it('rejects when required headers are missing', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body } = await signedDelivery(paymentPayload());
		await expect(verify(body, {})).rejects.toThrow(/missing/);
	});

	it('rejects a delivery whose timestamp is outside the tolerance window', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const stale = String(Math.floor(Date.now() / 1000) - 10000);
		const { body, headers } = await signedDelivery(paymentPayload(), { timestamp: stale });
		await expect(verify(body, headers)).rejects.toThrow(/tolerance/);
	});

	it('rejects a pre-parsed object body (raw bytes required for Standard Webhooks)', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { headers } = await signedDelivery(paymentPayload());
		await expect(verify(paymentPayload(), headers)).rejects.toThrow(/raw body/);
	});

	it('accepts a Uint8Array body equivalently to a string body', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(paymentPayload());
		const bytes = new TextEncoder().encode(body);
		const result = asPayment(await verify(bytes, headers));
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe('pay_abc123');
	});
});
