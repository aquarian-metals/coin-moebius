import type { PaymentProvider, InitiateOptions, PaymentResult } from '@coin-moebius/core';
import { loadStripe } from '@stripe/stripe-js';

export interface StripeProviderConfig {
	publishableKey: string;
}

export default function createStripeProvider(config: StripeProviderConfig): PaymentProvider {
	const provider: PaymentProvider = {
		id: 'stripe',
		name: 'Stripe',
		icon: 'https://upload.wikimedia.org/wikipedia/commons/b/ba/Stripe_Logo%2C_revised_2016.svg',

		async initiate(
			options: InitiateOptions,
			callbacks: {
				onSuccess: (result: PaymentResult) => void;
				onPending?: (result: PaymentResult) => void;
				onError: (error: Error) => void;
			}
		) {
			try {
				const stripe = await loadStripe(config.publishableKey);
				if (!stripe) throw new Error('Failed to load Stripe.js');

				const response = await fetch('/.netlify/functions/create-stripe-session', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						productId: options.productId,
						amount: options.amount,
						currency: options.currency,
						metadata: options.metadata,
					}),
				});

				const { sessionId } = (await response.json()) as { sessionId: string };

				const { error } = await stripe.redirectToCheckout({ sessionId });

				if (error) throw error;

				callbacks.onPending?.({
					status: 'pending',
					paymentId: sessionId,
					provider: provider.id,
					amount: options.amount,
					currency: options.currency,
					metadata: options.metadata || {},
					timestamp: Date.now(),
				});
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};

	return provider;
}
