import type { PaymentResult } from '@aquarianmetals/coin-moebius-core';
import Stripe from 'stripe';

export interface StripeVerifierConfig {
	/** Stripe webhook signing secret (the `whsec_…` value from your dashboard). */
	endpointSecret: string;
	/**
	 * Your Stripe secret key (`sk_live_…` / `sk_test_…`). Optional — webhook
	 * signature verification works without it, but providing it lets the same
	 * `Stripe` instance be reused for refunds, retrievals, etc., and avoids
	 * relying on the SDK accepting placeholder keys.
	 */
	secretKey?: string;
	/**
	 * Pin the Stripe API version. Defaults to the version this package was
	 * tested against. Override if you've upgraded the `stripe` SDK and need a
	 * matching version.
	 */
	apiVersion?: Stripe.LatestApiVersion;
}

const DEFAULT_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia';

export function createStripeVerifier(config: StripeVerifierConfig) {
	// Webhooks.constructEvent only uses the endpointSecret — the API key on the
	// instance is never consulted for that call. We accept a placeholder when no
	// real key is supplied so callers using this purely for verification don't
	// have to thread their secret key through.
	const stripe = new Stripe(config.secretKey ?? 'sk_unused_for_webhook_verification_only', {
		apiVersion: config.apiVersion ?? DEFAULT_API_VERSION,
	});

	return async function verifyStripeWebhook(rawBody: unknown, headers: unknown): Promise<PaymentResult> {
		const headerRecord = (headers ?? {}) as Record<string, string | undefined>;
		const signature = headerRecord['stripe-signature'] || headerRecord['Stripe-Signature'];

		if (!signature) {
			throw new Error('coin-moebius/stripe: missing stripe-signature header');
		}

		let event: Stripe.Event;
		try {
			event = await stripe.webhooks.constructEventAsync(
				rawBody as string | Buffer,
				signature,
				config.endpointSecret
			);
		} catch (err) {
			throw new Error(
				`coin-moebius/stripe: invalid signature – ${err instanceof Error ? err.message : String(err)}`
			);
		}

		if (event.type === 'checkout.session.completed') {
			const session = event.data.object as Stripe.Checkout.Session;
			if (session.payment_status === 'paid' || session.status === 'complete') {
				return {
					status: 'success',
					paymentId: session.id,
					provider: 'stripe',
					amount: (session.amount_total ?? 0) / 100,
					currency: (session.currency || 'usd').toUpperCase(),
					metadata: {
						...(session.metadata ?? {}),
						email: session.customer_details?.email || session.customer_email,
					},
					timestamp: Date.now(),
					raw: event,
				};
			}
		}

		if (event.type === 'payment_intent.succeeded') {
			const pi = event.data.object as Stripe.PaymentIntent;
			if (pi.status === 'succeeded') {
				return {
					status: 'success',
					paymentId: pi.id,
					provider: 'stripe',
					amount: (pi.amount ?? 0) / 100,
					currency: (pi.currency || 'usd').toUpperCase(),
					metadata: {
						...(pi.metadata ?? {}),
						email: pi.receipt_email,
					},
					timestamp: Date.now(),
					raw: event,
				};
			}
		}

		return {
			status: 'pending',
			paymentId:
				'id' in event.data.object && typeof event.data.object.id === 'string'
					? event.data.object.id
					: 'unknown',
			provider: 'stripe',
			amount: 0,
			currency: 'USD',
			metadata: {},
			timestamp: Date.now(),
			raw: event,
		};
	};
}
