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

	it('treats a paid session with status=open as success (payment_status side of ||)', async () => {
		// `payment_status === 'paid'` should be sufficient even if `status` is
		// still `open` (Stripe sometimes lags status transitions). Covers the
		// short-circuit on the left side of the OR.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_paid_open',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_paid_open',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'open',
					amount_total: 1000,
					currency: 'usd',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result.status).toBe('success');
	});

	it('treats an unpaid checkout.session.completed as pending', async () => {
		// Neither `payment_status === 'paid'` nor `status === 'complete'` — falls
		// through past the success branch into the pending tail return.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_unpaid',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_unpaid',
					object: 'checkout.session',
					payment_status: 'unpaid',
					status: 'open',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result.status).toBe('pending');
		expect(result.paymentId).toBe('cs_unpaid');
	});

	it('treats payment_intent.succeeded with status=requires_action as pending', async () => {
		// `pi.status !== 'succeeded'` — falls through past the success branch.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_pi_pending',
			object: 'event',
			type: 'payment_intent.succeeded',
			data: {
				object: {
					id: 'pi_pending',
					object: 'payment_intent',
					status: 'requires_action',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result.status).toBe('pending');
		expect(result.paymentId).toBe('pi_pending');
	});

	it('falls back to defaults when amount_total / currency / metadata / email are absent', async () => {
		// Exercises every `??` and `?.` along the checkout success path.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sparse',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_sparse',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'complete',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result.status).toBe('success');
		expect(result.amount).toBe(0);
		expect(result.currency).toBe('USD');
		expect(result.metadata).toMatchObject({ email: undefined });
	});

	it('uses customer_details.email when set, ignoring customer_email', async () => {
		// Left side of `customer_details?.email ?? customer_email` — confirms
		// the deeper-nested path wins.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_cd_email',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_cd_email',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'complete',
					customer_details: { email: 'fromdetails@example.com' },
					customer_email: 'ignored@example.com',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect((result.metadata as { email: string }).email).toBe('fromdetails@example.com');
	});

	it('falls back to defaults on payment_intent.succeeded with no amount/currency/metadata', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_pi_sparse',
			object: 'event',
			type: 'payment_intent.succeeded',
			data: {
				object: {
					id: 'pi_sparse',
					object: 'payment_intent',
					status: 'succeeded',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result.amount).toBe(0);
		expect(result.currency).toBe('USD');
	});

	it('returns paymentId="unknown" when the event data has no id', async () => {
		// Pending-tail fallback: `'id' in event.data.object && typeof … === 'string'`
		// is false → 'unknown' wins.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_no_id',
			object: 'event',
			type: 'customer.created',
			data: { object: { object: 'customer' } },
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result.status).toBe('pending');
		expect(result.paymentId).toBe('unknown');
	});
});
