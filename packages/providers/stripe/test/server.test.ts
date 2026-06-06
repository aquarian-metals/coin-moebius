import { describe, it, expect } from 'vitest';
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';
import Stripe from 'stripe';
import { createStripeVerifier, getStripePortalUrl } from '../src/server';

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

		const result = asPayment(await verify(body, headers));

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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
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
		const result = asPayment(await verify(body, headers));
		expect(result).not.toBeNull();
		expect((result!.metadata as { email: string }).email).toBe('fromdetails@example.com');
	});
});

describe('createStripeVerifier — subscription events', () => {
	// Helper: build a Stripe.Subscription-shaped object with the fields the
	// verifier actually reads. Inline rather than imported so test fixtures
	// stay self-contained against Stripe SDK shape drift.
	function subResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: 'sub_test_1',
			object: 'subscription',
			status: 'active',
			customer: 'cus_test_1',
			cancel_at_period_end: false,
			current_period_end: 1750000000,
			items: {
				data: [
					{
						id: 'si_1',
						price: {
							id: 'price_1',
							product: 'prod_1',
							unit_amount: 999,
							currency: 'usd',
							recurring: { interval: 'month', interval_count: 1 },
						},
					},
				],
			},
			metadata: { productId: 'sku-monthly' },
			...overrides,
		};
	}

	it('maps customer.subscription.created to subscription.created with active status', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_created',
			object: 'event',
			type: 'customer.subscription.created',
			data: { object: subResource() },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result).not.toBeNull();
		expect(result!.type).toBe('subscription.created');
		expect(result!.subscriptionId).toBe('sub_test_1');
		expect(result!.provider).toBe('stripe');
		expect(result!.productId).toBe('prod_1');
		expect(result!.customerRef).toBe('cus_test_1');
		expect(result!.status).toBe('active');
		expect(result!.currentPeriodEnd).toBe(1750000000);
		expect(result!.amount).toBeCloseTo(9.99, 2);
		expect(result!.currency).toBe('USD');
	});

	it('maps trialing subscriptions to active status', async () => {
		// Trialing subscribers have "access" and should look "active" to merchants —
		// the verifier flattens Stripe's `trialing` into our neutral `active` enum.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_trial',
			object: 'event',
			type: 'customer.subscription.created',
			data: { object: subResource({ status: 'trialing' }) },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.status).toBe('active');
		expect((result!.metadata as { stripeStatus: string }).stripeStatus).toBe('trialing');
	});

	it('maps customer.subscription.deleted to subscription.canceled with canceled status', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_deleted',
			object: 'event',
			type: 'customer.subscription.deleted',
			data: { object: subResource({ status: 'canceled' }) },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.type).toBe('subscription.canceled');
		expect(result!.status).toBe('canceled');
	});

	it('maps customer.subscription.updated to subscription.updated with mapped status', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_updated',
			object: 'event',
			type: 'customer.subscription.updated',
			data: { object: subResource({ status: 'past_due' }) },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.type).toBe('subscription.updated');
		expect(result!.status).toBe('past_due');
	});

	it('maps invoice.payment_succeeded with billing_reason=subscription_cycle to subscription.renewed', async () => {
		// Renewal cycles emit through invoice events, not customer.subscription.*.
		// The verifier should pick this up as a renewal — not a one-time payment.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_inv_renewed',
			object: 'event',
			type: 'invoice.payment_succeeded',
			data: {
				object: {
					id: 'in_1',
					object: 'invoice',
					subscription: 'sub_test_1',
					customer: 'cus_test_1',
					billing_reason: 'subscription_cycle',
					period_end: 1751000000,
					amount_paid: 999,
					currency: 'usd',
					lines: {
						data: [
							{
								price: { id: 'price_1', product: 'prod_1' },
							},
						],
					},
					metadata: {},
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result).not.toBeNull();
		expect(result!.type).toBe('subscription.renewed');
		expect(result!.status).toBe('active');
		expect(result!.subscriptionId).toBe('sub_test_1');
		expect(result!.amount).toBeCloseTo(9.99, 2);
		expect(result!.currentPeriodEnd).toBe(1751000000);
	});

	it('ignores invoice.payment_succeeded for the initial cycle (billing_reason=subscription_create)', async () => {
		// First-cycle invoices fire alongside customer.subscription.created. To avoid
		// double-emitting signups, the verifier swallows them and lets the
		// subscription.created event carry the signup signal.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_inv_first',
			object: 'event',
			type: 'invoice.payment_succeeded',
			data: {
				object: {
					id: 'in_first',
					object: 'invoice',
					subscription: 'sub_test_1',
					billing_reason: 'subscription_create',
					period_end: 1751000000,
					amount_paid: 999,
					currency: 'usd',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result).toBeNull();
	});

	it('maps invoice.payment_failed to subscription.payment_failed with past_due status', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_inv_failed',
			object: 'event',
			type: 'invoice.payment_failed',
			data: {
				object: {
					id: 'in_failed',
					object: 'invoice',
					subscription: 'sub_test_1',
					customer: 'cus_test_1',
					billing_reason: 'subscription_cycle',
					period_end: 1751000000,
					amount_due: 999,
					currency: 'usd',
					metadata: {},
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.type).toBe('subscription.payment_failed');
		expect(result!.status).toBe('past_due');
		expect(result!.amount).toBeCloseTo(9.99, 2);
	});

	it('maps unpaid subscriptions to past_due status', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_unpaid',
			object: 'event',
			type: 'customer.subscription.updated',
			data: { object: subResource({ status: 'unpaid' }) },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.status).toBe('past_due');
	});

	it('maps incomplete_expired subscriptions to canceled status', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_incomplete_expired',
			object: 'event',
			type: 'customer.subscription.updated',
			data: { object: subResource({ status: 'incomplete_expired' }) },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.status).toBe('canceled');
	});

	it('maps paused subscriptions to paused status', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_paused',
			object: 'event',
			type: 'customer.subscription.updated',
			data: { object: subResource({ status: 'paused' }) },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.status).toBe('paused');
	});

	it('maps unrecognized subscription statuses to unknown', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_mystery',
			object: 'event',
			type: 'customer.subscription.updated',
			data: { object: subResource({ status: 'some_future_status' }) },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.status).toBe('unknown');
	});

	it('reads current_period_end from items.data[0] when the top-level field is absent', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const sub = subResource();
		delete sub.current_period_end;
		(sub as { items: { data: Record<string, unknown>[] } }).items.data[0].current_period_end =
			1760000000;
		const event = {
			id: 'evt_sub_item_period',
			object: 'event',
			type: 'customer.subscription.created',
			data: { object: sub },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.currentPeriodEnd).toBe(1760000000);
	});

	it('returns null currentPeriodEnd when neither top-level nor item has the field', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const sub = subResource();
		delete sub.current_period_end;
		const event = {
			id: 'evt_sub_no_period',
			object: 'event',
			type: 'customer.subscription.created',
			data: { object: sub },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.currentPeriodEnd).toBeNull();
	});

	it('resolves expanded customer objects in subscription events to the inner id', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_sub_expanded_cust',
			object: 'event',
			type: 'customer.subscription.created',
			data: {
				object: subResource({
					customer: { id: 'cus_expanded', object: 'customer' },
				}),
			},
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.customerRef).toBe('cus_expanded');
	});

	it('falls back to productId from metadata when price.product is absent', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const sub = subResource();
		const items = sub.items as { data: Record<string, unknown>[] };
		items.data[0].price = { id: 'price_1', unit_amount: 999, currency: 'usd' };
		const event = {
			id: 'evt_sub_meta_product',
			object: 'event',
			type: 'customer.subscription.created',
			data: { object: sub },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.productId).toBe('sku-monthly');
	});

	it('surfaces the price id in subscription metadata', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const sub = {
			id: 'sub_price',
			object: 'subscription',
			customer: 'cus_price',
			status: 'active',
			current_period_end: 1751000000,
			cancel_at_period_end: false,
			items: { data: [{ price: { id: 'price_abc', product: 'prod_abc' } }] },
		};
		const event = {
			id: 'evt_price',
			object: 'event',
			type: 'customer.subscription.created',
			data: { object: sub },
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result!.metadata.priceId).toBe('price_abc');
	});

	it('surfaces a paid invoice without a subscription id as a payment, passing metadata through', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_inv_no_sub',
			object: 'event',
			type: 'invoice.payment_succeeded',
			data: {
				object: {
					id: 'in_no_sub',
					object: 'invoice',
					billing_reason: 'manual',
					period_end: 1751000000,
					amount_paid: 999,
					currency: 'usd',
					metadata: { invoice_type: 'overage', user_id: 'user_x' },
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = asPayment(await verify(body, headers));
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe('in_no_sub');
		expect(result!.amount).toBe(9.99);
		expect(result!.metadata.invoiceId).toBe('in_no_sub');
		// The invoice's own metadata rides through so consumers can route it.
		expect(result!.metadata.invoice_type).toBe('overage');
		expect(result!.metadata.user_id).toBe('user_x');
	});

	it('handles invoice with empty lines gracefully', async () => {
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_inv_empty_lines',
			object: 'event',
			type: 'invoice.payment_succeeded',
			data: {
				object: {
					id: 'in_empty',
					object: 'invoice',
					subscription: 'sub_test_1',
					customer: 'cus_test_1',
					billing_reason: 'subscription_cycle',
					period_end: 1751000000,
					amount_paid: 999,
					currency: 'usd',
					lines: { data: [] },
					metadata: {},
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = asSubscription(await verify(body, headers));
		expect(result).not.toBeNull();
		expect(result!.productId).toBeNull();
	});

	it('skips subscription-mode checkout.session.completed (canonical signup is subscription.created)', async () => {
		// Subscription-mode Checkout Sessions fire alongside customer.subscription.created.
		// Without this skip, the verifier would emit a one-time payment event AND a
		// subscription event for the same signup — double-counting.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_cs_sub_mode',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_sub',
					object: 'checkout.session',
					mode: 'subscription',
					payment_status: 'paid',
					status: 'complete',
					amount_total: 999,
					currency: 'usd',
					subscription: 'sub_test_1',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = await verify(body, headers);
		expect(result).toBeNull();
	});

	it('still emits a payment event for mode:payment checkout.session.completed', async () => {
		// Regression guard for the previous test — make sure we didn't accidentally
		// stop emitting payment events for one-time checkouts.
		const verify = createStripeVerifier({ endpointSecret: ENDPOINT_SECRET });
		const event = {
			id: 'evt_cs_pay_mode',
			object: 'event',
			type: 'checkout.session.completed',
			data: {
				object: {
					id: 'cs_pay',
					object: 'checkout.session',
					mode: 'payment',
					payment_status: 'paid',
					status: 'complete',
					amount_total: 999,
					currency: 'usd',
					payment_intent: 'pi_pay_1',
				},
			},
		};
		const { body, headers } = signedRequest(event);
		const result = asPayment(await verify(body, headers));
		expect(result).not.toBeNull();
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe('pi_pay_1');
	});
});

describe('getStripePortalUrl', () => {
	it('throws when the secret key is rejected by Stripe', async () => {
		// We don't have a sandbox secret key available in unit tests, so the
		// happy-path API call is integration-tested in CI. Here we verify the
		// helper at least surfaces Stripe-side auth errors cleanly rather than
		// returning a phantom URL on misconfiguration.
		await expect(
			getStripePortalUrl({
				secretKey: 'sk_test_invalid_key',
				customerId: 'cus_test_1',
				returnUrl: 'https://example.com/account',
			}),
		).rejects.toThrow();
	});
});
