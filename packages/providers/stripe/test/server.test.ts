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
	it('returns a success result for a paid checkout.session.completed, keyed by payment_intent', async () => {
		// The verifier prefers the PaymentIntent id for `paymentId` so later
		// `charge.refunded` / `charge.dispute.created` events for the same
		// logical payment carry the SAME paymentId and consumers can update
		// the original row in place.
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
					payment_intent: 'pi_test_abc',
					metadata: { productId: 'sku-1' },
					customer_email: 'buyer@example.com',
				},
			},
		};
		const { body, headers } = signedRequest(event);

		const result = await verify(body, headers);

		expect(result).not.toBeNull();
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe('pi_test_abc');
		expect(result!.provider).toBe('stripe');
		expect(result!.amount).toBeCloseTo(19.99, 2);
		expect(result!.currency).toBe('USD');
		expect(result!.metadata).toMatchObject({ productId: 'sku-1', email: 'buyer@example.com' });
	});

	it('falls back to session id when the Checkout Session has no payment_intent', async () => {
		// Setup-mode sessions (rare in v1) have no payment_intent; v1 doesn't
		// use them, but the contract is total — paymentId must always be a
		// non-empty string.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_no_pi',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_no_pi',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'complete',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result).not.toBeNull();
		expect(result!.paymentId).toBe('cs_no_pi');
	});

	it('returns a refunded result for charge.refunded keyed by the original payment_intent', async () => {
		// A refund event carries the original payment_intent in charge.payment_intent.
		// The verifier echoes it as `paymentId` so consumers can match the
		// refund back to the original transaction row.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_refund_full',
			object: 'event',
			type: 'charge.refunded',
			data: {
				object: {
					id: 'ch_refund',
					object: 'charge',
					payment_intent: 'pi_test_abc',
					amount: 1999,
					amount_refunded: 1999,
					currency: 'usd',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result).not.toBeNull();
		expect(result!.status).toBe('refunded');
		expect(result!.paymentId).toBe('pi_test_abc');
		expect(result!.amount).toBeCloseTo(19.99, 2);
		expect(result!.metadata).toMatchObject({ originalChargeId: 'ch_refund' });
	});

	it('reports a partial refund using amount_refunded, not the original amount', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_refund_partial',
			object: 'event',
			type: 'charge.refunded',
			data: {
				object: {
					id: 'ch_partial',
					object: 'charge',
					payment_intent: 'pi_test_partial',
					amount: 2000,
					amount_refunded: 500,
					currency: 'usd',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result).not.toBeNull();
		expect(result!.status).toBe('refunded');
		expect(result!.amount).toBeCloseTo(5.0, 2);
		expect(result!.metadata).toMatchObject({ originalAmount: 20 });
	});

	it('returns a disputed result for charge.dispute.created keyed by payment_intent', async () => {
		// We pass Stripe's `reason` value through in metadata verbatim — but
		// keep the test fixture neutral (`general`) rather than using a loaded
		// value like `fraudulent`. Disputes commonly resolve in the buyer's
		// favor and our default copy stays neutral; the merchant who renders
		// metadata.reason gets to decide how to display it.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_dispute',
			object: 'event',
			type: 'charge.dispute.created',
			data: {
				object: {
					id: 'dp_xyz',
					object: 'dispute',
					payment_intent: 'pi_test_disp',
					charge: 'ch_disp',
					amount: 1999,
					currency: 'usd',
					reason: 'general',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result).not.toBeNull();
		expect(result!.status).toBe('disputed');
		expect(result!.paymentId).toBe('pi_test_disp');
		expect(result!.metadata).toMatchObject({
			disputeId: 'dp_xyz',
			reason: 'general',
			originalChargeId: 'ch_disp',
		});
	});

	it('resolves expanded `payment_intent` objects in dispute events to the inner id', async () => {
		// Stripe may return payment_intent as either a string id or an
		// expanded object `{ id: 'pi_…', … }` depending on whether the API
		// caller requested expansion. Our verifier must handle both.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_dispute_expanded',
			object: 'event',
			type: 'charge.dispute.created',
			data: {
				object: {
					id: 'dp_expanded',
					object: 'dispute',
					payment_intent: { id: 'pi_test_expanded', object: 'payment_intent' },
					charge: { id: 'ch_expanded', object: 'charge' },
					amount: 500,
					currency: 'usd',
					reason: 'general',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result?.paymentId).toBe('pi_test_expanded');
		expect(result?.metadata).toMatchObject({ originalChargeId: 'ch_expanded' });
	});

	it('resolves expanded `payment_intent` objects in refund events to the inner id', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_refund_expanded',
			object: 'event',
			type: 'charge.refunded',
			data: {
				object: {
					id: 'ch_refund_expanded',
					object: 'charge',
					payment_intent: { id: 'pi_refund_expanded', object: 'payment_intent' },
					amount: 1000,
					amount_refunded: 1000,
					currency: 'usd',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result?.paymentId).toBe('pi_refund_expanded');
	});

	it('accepts a custom apiVersion override via config (instead of the package default)', async () => {
		// Exercises the `config.apiVersion ?? DEFAULT_API_VERSION` override
		// path. Verification doesn't depend on which version string we sent —
		// signature verification is API-version-agnostic — but we want both
		// branches of the `??` covered.
		const verify = createStripeVerifier({
			endpointSecret: ENDPOINT_SECRET,
			apiVersion: '2024-12-18.acacia',
		});
		const event = {
			id: 'evt_apiv_override',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_apiv',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'complete',
					mode: 'payment',
					payment_intent: 'pi_apiv',
					amount_total: 100,
					currency: 'usd',
					metadata: {},
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result?.status).toBe('success');
	});

	it('returns null for a dispute event whose payment_intent is null/missing', async () => {
		// Disputes against direct-charge flows (no PaymentIntent) leave us
		// with nothing to link the dispute back to in the merchant's
		// transaction store. Returning null keeps us from creating an orphan
		// disputed row.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_dispute_no_pi',
			object: 'event',
			type: 'charge.dispute.created',
			data: {
				object: {
					id: 'dp_no_pi',
					object: 'dispute',
					payment_intent: null,
					charge: 'ch_only',
					amount: 1000,
					currency: 'usd',
					reason: 'general',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result).toBeNull();
	});

	it('returns null for a checkout.session.completed where session is non-object (defensive)', async () => {
		// readStringField's runtime null/non-object guard. In practice Stripe
		// always sends a proper session object; this covers the defensive
		// path so a malformed event doesn't blow up the verifier.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_cs_no_pi_field',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_no_pi',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'complete',
					mode: 'payment',
					// payment_intent omitted entirely; readStringField returns undefined,
					// caller falls back to session.id as paymentId.
					amount_total: 500,
					currency: 'usd',
					metadata: {},
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result?.paymentId).toBe('cs_no_pi');
	});

	it('resolves expanded `payment_intent` objects in checkout.session.completed', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_cs_expanded',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_test_expanded',
					object: 'checkout.session',
					payment_status: 'paid',
					status: 'complete',
					mode: 'payment',
					payment_intent: { id: 'pi_session_expanded', object: 'payment_intent' },
					amount_total: 2000,
					currency: 'usd',
					metadata: {},
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result?.paymentId).toBe('pi_session_expanded');
	});

	it("returns null for refund/dispute events that lack a payment_intent (can't link)", async () => {
		// Refunds against direct-charge flows (no Checkout / no PaymentIntent)
		// have nothing to match back to in the merchant's transaction store.
		// Returning null here keeps the merchant from getting an "orphan"
		// refund row that doesn't connect to any original payment.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_orphan_refund',
			object: 'event',
			type: 'charge.refunded',
			data: {
				object: {
					id: 'ch_orphan',
					object: 'charge',
					amount: 1000,
					amount_refunded: 1000,
					currency: 'usd',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		expect(await verify(body, headers)).toBeNull();
	});

	it('returns null for payment_intent.succeeded (Checkout fires it alongside checkout.session.completed; counting both double-records the payment)', async () => {
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
				},
			},
		};
		const { body, headers } = signedRequest(event);

		expect(await verify(body, headers)).toBeNull();
	});

	it('returns null for unrecognized event types (signed-but-not-a-payment)', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_3',
			object: 'event',
			type: 'invoice.paid',
			data: { object: { id: 'in_1', object: 'invoice' } },
		};
		const { body, headers } = signedRequest(event);

		expect(await verify(body, headers)).toBeNull();
	});

	it('returns null for product.created / price.created / charge.succeeded setup-fixture events (no fake pending rows)', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		for (const type of ['product.created', 'price.created', 'charge.succeeded'] as const) {
			const event = {
				id: `evt_${type}`,
				object: 'event',
				type,
				data: {
					object: { id: type === 'product.created' ? 'prod_x' : 'something_x', object: type },
				},
			};
			const { body, headers } = signedRequest(event);
			expect(await verify(body, headers)).toBeNull();
		}
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
		expect(result?.status).toBe('success');
	});

	it('treats an unpaid checkout.session.completed as pending (async payment in progress, e.g. ACH)', async () => {
		// Neither `payment_status === 'paid'` nor `status === 'complete'` — but
		// it IS a Checkout event for a Checkout-mode purchase, so we keep
		// tracking it as pending (delayed payment methods land later via a
		// follow-up checkout.session.async_payment_succeeded etc.).
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
		expect(result).not.toBeNull();
		expect(result!.status).toBe('pending');
		expect(result!.paymentId).toBe('cs_unpaid');
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
		expect(result).not.toBeNull();
		expect(result!.status).toBe('success');
		expect(result!.amount).toBe(0);
		expect(result!.currency).toBe('USD');
		expect(result!.metadata).toMatchObject({ email: undefined });
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
		expect(result).not.toBeNull();
		expect((result!.metadata as { email: string }).email).toBe('fromdetails@example.com');
	});
});
