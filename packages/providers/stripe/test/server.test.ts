import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { createStripeVerifier } from '../src/server';

const ENDPOINT_SECRET = 'whsec_test_coin_moebius';

function signedRequest(payload: object) {
	const body = JSON.stringify(payload);
	const header = Stripe.webhooks.generateTestHeaderString({
		payload: body,
		secret: ENDPOINT_SECRET,
	});
	return { body, headers: { 'stripe-signature': header } };
}

describe('createStripeVerifier', () => {
	it('returns a success result for a paid checkout.session.completed', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_1',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_test_1',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'complete',
					amount_total: 1999,
					currency: 'usd',
					metadata: { productId: 'sku-1' },
					customer_email: 'buyer@example.com',
				},
			},
		};
		const { body, headers } = signedRequest(event);

		const result = await verify(body, headers);

		expect(result.status).toBe('success');
		expect(result.paymentId).toBe('cs_test_1');
		expect(result.provider).toBe('stripe');
		expect(result.amount).toBeCloseTo(19.99, 2);
		expect(result.currency).toBe('USD');
		expect(result.metadata).toMatchObject({ productId: 'sku-1', email: 'buyer@example.com' });
	});

	it('returns a success result for a payment_intent.succeeded', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_2',
			object: 'event',
			type: 'payment_intent.succeeded',
			data: {
				object: {
					id: 'pi_test_1',
					object: 'payment_intent',
					status: 'succeeded',
					amount: 500,
					currency: 'usd',
					metadata: {},
					receipt_email: 'buyer@example.com',
				},
			},
		};
		const { body, headers } = signedRequest(event);

		const result = await verify(body, headers);

		expect(result.status).toBe('success');
		expect(result.paymentId).toBe('pi_test_1');
		expect(result.amount).toBe(5);
	});

	it('returns a pending result for unrecognized event types', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_3',
			object: 'event',
			type: 'invoice.paid',
			data: { object: { id: 'in_1', object: 'invoice' } },
		};
		const { body, headers } = signedRequest(event);

		const result = await verify(body, headers);
		expect(result.status).toBe('pending');
		expect(result.paymentId).toBe('in_1');
	});

	it('rejects when the signature header is missing', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		await expect(verify('{}', {})).rejects.toThrow(/missing stripe-signature/);
	});

	it('rejects when the signature does not match the body', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const { body, headers } = signedRequest({ id: 'evt_4', type: 'noop', data: { object: {} } });
		await expect(verify(body + 'tampered', headers)).rejects.toThrow(/invalid signature/);
	});
});
