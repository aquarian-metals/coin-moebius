import type { PaymentResult } from '@coin-moebius/core';
import Stripe from 'stripe';

export interface StripeVerifierConfig {
	endpointSecret: string;
}

export function createStripeVerifier(config: StripeVerifierConfig) {
	const stripe = new Stripe('dummy-key', {
		apiVersion: '2025-02-24.acacia',
	});

	return async function verifyStripeWebhook(rawBody: unknown, headers: unknown): Promise<PaymentResult> {
		const headerRecord = headers as Record<string, string | undefined>;
		const signature = headerRecord?.['stripe-signature'] || headerRecord?.['Stripe-Signature'];

		if (!signature) {
			throw new Error('coin-moebius/stripe: missing stripe-signature header');
		}

		let event: Stripe.Event;
		try {
			event = stripe.webhooks.constructEvent(rawBody as string | Buffer, signature, config.endpointSecret);
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
