import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';
import { loadStripe } from '@stripe/stripe-js';

export interface StripeProviderConfig {
	publishableKey: string;
	/**
	 * Endpoint on your own backend that creates a Stripe Checkout session and
	 * returns `{ sessionId }`. Defaults to `/api/checkout/stripe` — a
	 * vendor-neutral REST-style path that works out-of-the-box on Cloudflare
	 * Workers, Vercel, Express, or any host where you serve that route.
	 * Override for hosts with different conventions (e.g.,
	 * `/.netlify/functions/create-stripe-session` for Netlify).
	 *
	 * Your secret key must stay server-side — never ship it to the browser.
	 */
	sessionEndpoint?: string;
}

export default function createStripeProvider(config: StripeProviderConfig): PaymentProvider {
	const sessionEndpoint = config.sessionEndpoint ?? '/api/checkout/stripe';

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
			},
		) {
			try {
				const stripe = await loadStripe(config.publishableKey);
				if (!stripe) throw new Error('Failed to load Stripe.js');

				const response = await fetch(sessionEndpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						productId: options.productId,
						amount: options.amount,
						currency: options.currency,
						metadata: options.metadata,
					}),
				});

				if (!response.ok) {
					throw new Error(`coin-moebius/stripe: session endpoint returned ${response.status}`);
				}

				const { sessionId } = (await response.json()) as { sessionId: string };

				if (!sessionId) {
					throw new Error('coin-moebius/stripe: session endpoint did not return sessionId');
				}

				const { error } = await stripe.redirectToCheckout({ sessionId });

				// Stripe.js types `error` as a plain object (`{ message?: string, type?: string }`),
				// not a true Error instance. Wrap it before throwing so downstream handlers can
				// rely on `instanceof Error`.
				if (error) {
					throw new Error(error.message ?? 'coin-moebius/stripe: redirectToCheckout failed');
				}

				callbacks.onPending?.({
					status: 'pending',
					paymentId: sessionId,
					provider: provider.id,
					amount: options.amount,
					currency: options.currency,
					metadata: options.metadata ?? {},
					timestamp: Date.now(),
				});
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};

	return provider;
}
