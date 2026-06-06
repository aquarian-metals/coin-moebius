import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

export interface StripeProviderConfig {
	/**
	 * Endpoint on your own backend that creates a Stripe Checkout session and
	 * returns `{ url }`. Defaults to `/api/checkout/stripe` — a
	 * vendor-neutral REST-style path that works out-of-the-box on Cloudflare
	 * Workers, Vercel, Express, or any host where you serve that route.
	 * Override for hosts with different conventions (e.g.,
	 * `/.netlify/functions/create-stripe-session` for Netlify).
	 *
	 * Your Stripe secret key must stay on the server endpoint behind this URL —
	 * never ship it to the browser.
	 */
	sessionEndpoint?: string;
}

/**
 * Stripe browser-side provider.
 *
 * The provider POSTs the buyer's selection to your `sessionEndpoint`, which
 * is expected to create a Stripe Checkout Session and return `{ url }`.
 * The provider then redirects the buyer's browser to that URL via
 * `window.location.assign(url)` — Stripe's documented happy path.
 *
 * Notes:
 *   - No `@stripe/stripe-js` library load on the client. Redirecting to the
 *     Session URL is the documented current pattern; the older
 *     `stripe.redirectToCheckout({ sessionId })` flow required loading
 *     stripe.js purely to call a thin wrapper around the same redirect.
 *   - No publishable key needed on the client. Your server holds the secret;
 *     the buyer's browser only ever sees the public hosted-checkout URL.
 */
export default function createStripeProvider(config: StripeProviderConfig = {}): PaymentProvider {
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

				const { url } = (await response.json()) as { url?: string };

				if (!url) {
					throw new Error('coin-moebius/stripe: session endpoint did not return url');
				}

				// Fire the pending callback before navigating away so callers
				// can record the in-flight checkout in their analytics or UI
				// state. The buyer's browser will be on Stripe's hosted page
				// the moment the line below executes.
				callbacks.onPending?.({
					status: 'pending',
					paymentId: url,
					provider: provider.id,
					amount: options.amount,
					currency: options.currency,
					metadata: options.metadata ?? {},
					timestamp: Date.now(),
				});

				assertSafeRedirectUrl(url);
				window.location.assign(url);
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};

	return provider;
}

function assertSafeRedirectUrl(url: string): void {
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(`coin-moebius/stripe: redirect URL scheme "${parsed.protocol}" is not allowed`);
	}
}
