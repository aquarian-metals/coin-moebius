import { describe, it, expect, vi, afterEach } from 'vitest';
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';
import {
	createDodoPaymentsVerifier,
	computeDodoSignature,
	getDodoPortalUrl,
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

	it('accepts an ArrayBuffer body equivalently to a string body', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(paymentPayload());
		const buffer = new TextEncoder().encode(body).buffer;
		const result = asPayment(await verify(buffer, headers));
		expect(result!.status).toBe('success');
	});

	it('throws when the verifier was built without a secret', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: '' });
		await expect(verify('{}', {})).rejects.toThrow(/webhookSecret missing/);
	});

	it('treats absent headers as empty and reports the missing webhook headers', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body } = await signedDelivery(paymentPayload());
		await expect(verify(body)).rejects.toThrow(/missing webhook-id/);
	});

	it('rejects a non-numeric webhook-timestamp', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(paymentPayload(), { timestamp: 'not-a-number' });
		await expect(verify(body, headers)).rejects.toThrow(/not a number/);
	});

	it('skips signature tokens without a version comma and matches a later valid token', async () => {
		const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });
		const { body, headers } = await signedDelivery(paymentPayload());
		const event = await verify(body, {
			...headers,
			'webhook-signature': `garbagetoken ${headers['webhook-signature']}`,
		});
		expect(event).not.toBeNull();
	});
});

describe('createDodoPaymentsVerifier — field fallbacks', () => {
	const verify = createDodoPaymentsVerifier({ webhookSecret: WEBHOOK_SECRET });

	it('defaults missing currency to USD and missing amount/metadata to safe values', async () => {
		const { body, headers } = await signedDelivery(
			paymentPayload({ currency: undefined, total_amount: undefined, metadata: undefined }),
		);
		const event = asPayment(await verify(body, headers));
		expect(event?.currency).toBe('USD');
		expect(event?.amount).toBe(0);
		expect(event?.metadata.orderRef).toBeUndefined();
	});

	it('falls back from payment_id to subscription_id to empty string', async () => {
		const { body, headers } = await signedDelivery(
			paymentPayload({ payment_id: undefined, subscription_id: undefined }),
		);
		const event = asPayment(await verify(body, headers));
		expect(event?.paymentId).toBe('');
	});

	it('uses the refund total_amount fallback when the refund amount is absent', async () => {
		const payload = paymentPayload({
			payload_type: 'Refund',
			amount: undefined,
			total_amount: 500,
		});
		payload.type = 'refund.succeeded';
		const { body, headers } = await signedDelivery(payload);
		const event = asPayment(await verify(body, headers));
		expect(event?.status).toBe('refunded');
		expect(event?.amount).toBe(5);
	});

	it('falls back customerRef to email, productId to null, and subscriptionId to empty', async () => {
		const { body, headers } = await signedDelivery(
			subscriptionPayload('subscription.renewed', {
				subscription_id: undefined,
				product_id: undefined,
				customer: { email: 'only-email@example.com' },
			}),
		);
		const event = asSubscription(await verify(body, headers));
		expect(event?.subscriptionId).toBe('');
		expect(event?.productId).toBeNull();
		expect(event?.customerRef).toBe('only-email@example.com');
	});

	it('maps the paused subscription status', async () => {
		const { body, headers } = await signedDelivery(
			subscriptionPayload('subscription.updated', { status: 'paused' }),
		);
		expect(asSubscription(await verify(body, headers))?.status).toBe('paused');
	});

	it('maps an absent/unknown status to unknown with safe defaults', async () => {
		const { body, headers } = await signedDelivery(
			subscriptionPayload('subscription.updated', {
				status: undefined,
				next_billing_date: undefined,
				recurring_pre_tax_amount: undefined,
				currency: undefined,
			}),
		);
		const event = asSubscription(await verify(body, headers));
		expect(event?.status).toBe('unknown');
		expect(event?.currentPeriodEnd).toBeNull();
		expect(event?.amount).toBe(0);
		expect(event?.currency).toBe('USD');
	});

	it('returns null currentPeriodEnd for an unparseable next_billing_date', async () => {
		const { body, headers } = await signedDelivery(
			subscriptionPayload('subscription.renewed', { next_billing_date: 'not-a-date' }),
		);
		expect(asSubscription(await verify(body, headers))?.currentPeriodEnd).toBeNull();
	});
});

describe('getDodoPortalUrl', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('posts to the portal session endpoint and returns the link, including return_url', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ link: 'https://portal.dodo/abc' }), { status: 200 }),
			);
		const url = await getDodoPortalUrl({
			apiKey: 'key_123',
			apiBase: 'https://test.dodopayments.com/',
			customerId: 'cus_9',
			returnUrl: 'https://shop.example/account',
		});
		expect(url).toBe('https://portal.dodo/abc');
		const called = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
		expect(called.pathname).toBe('/customers/cus_9/customer-portal/session');
		expect(called.searchParams.get('return_url')).toBe('https://shop.example/account');
	});

	it('omits return_url when not provided', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(
				new Response(JSON.stringify({ link: 'https://portal.dodo/xyz' }), { status: 200 }),
			);
		await getDodoPortalUrl({
			apiKey: 'k',
			apiBase: 'https://test.dodopayments.com',
			customerId: 'cus_1',
		});
		const called = new URL((fetchSpy.mock.calls[0][0] as URL).toString());
		expect(called.searchParams.has('return_url')).toBe(false);
	});

	it('throws when the portal session request fails', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
		await expect(
			getDodoPortalUrl({
				apiKey: 'k',
				apiBase: 'https://test.dodopayments.com',
				customerId: 'cus_1',
			}),
		).rejects.toThrow(/customer-portal session failed \(500\)/);
	});

	it('throws when the response is missing the link field', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({}), { status: 200 }),
		);
		await expect(
			getDodoPortalUrl({
				apiKey: 'k',
				apiBase: 'https://test.dodopayments.com',
				customerId: 'cus_1',
			}),
		).rejects.toThrow(/missing `link`/);
	});
});
