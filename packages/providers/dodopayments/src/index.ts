/**
 * Dodo Payments client-side provider for Coin Moebius.
 *
 * Hosted-checkout flow only. Calls the configured checkout endpoint on your
 * own backend, receives a `checkout_url`, and redirects the buyer there.
 * Dodo Payments is a Merchant of Record: it hosts the payment page, collects
 * tax, and remits to you, so the buyer never touches your origin for the
 * payment itself. One Dodo checkout session can mix one-time and subscription
 * products, so this single provider covers both flows — the recurring side is
 * surfaced server-side as `kind: 'subscription'` events.
 *
 * The server-side webhook verifier lives at `./server` so this client-only
 * entry doesn't pull any Node/Web crypto into browser bundles.
 *
 *     import { createDodoPaymentsProvider } from '@aquarian-metals/coin-moebius-dodopayments';
 *     const dodo = createDodoPaymentsProvider({
 *       checkoutEndpoint: '/api/checkout/dodopayments',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [dodo] });
 *     await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
 */
import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

/** Client-side config. The Dodo API key + webhook secret stay server-side. */
export interface DodoPaymentsProviderConfig {
	/** Full URL of the checkout endpoint that returns `{ url: checkout_url }`. */
	checkoutEndpoint: string;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/** Optional navigation override — used by tests. Defaults to `location.assign`. */
	navigate?: (url: string) => void;
}

interface CheckoutResponse {
	url: string;
	/** The `payment_id` echoed back from Dodo — useful for status polling. */
	paymentId?: string;
}

/**
 * Build a `PaymentProvider` registered as `id: 'dodopayments'`. Returns a
 * `PaymentResult` with status `'pending'` immediately after redirect, since
 * settlement happens on Dodo's hosted page and the terminal signal lands via
 * the webhook on the server side. Consumers wanting buyer-side completion
 * notice should also call `manager.subscribeToStatus(paymentId, …)` after
 * `initiate` resolves.
 */
export function createDodoPaymentsProvider(config: DodoPaymentsProviderConfig): PaymentProvider {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const navigate =
		config.navigate ??
		((url: string) => {
			window.location.assign(url);
		});

	return {
		id: 'dodopayments',
		name: 'Dodo Payments',
		async initiate(options: InitiateOptions, callbacks): Promise<void> {
			try {
				const body: Record<string, unknown> = {
					productId: options.productId,
					amount: options.amount,
					currency: options.currency,
				};
				if (options.metadata) body.metadata = options.metadata;

				const response = await fetcher(config.checkoutEndpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					throw new Error(
						`coin-moebius/dodopayments: checkout endpoint responded ${response.status}`,
					);
				}
				const payload = (await response.json()) as CheckoutResponse;
				if (!payload.url) {
					throw new Error('coin-moebius/dodopayments: checkout response missing `url`');
				}

				// Fire a pending event so the SDK's listeners can update UI before
				// we navigate away. The buyer's onSuccess lands via the
				// status-polling channel after the webhook clears server-side.
				const result: PaymentResult = {
					status: 'pending',
					paymentId: payload.paymentId ?? '',
					provider: 'dodopayments',
					amount: options.amount,
					currency: options.currency,
					metadata: options.metadata ?? {},
					timestamp: Date.now(),
				};
				callbacks.onPending?.(result);
				assertSafeRedirectUrl(payload.url);
				navigate(payload.url);
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};
}

function assertSafeRedirectUrl(url: string): void {
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new Error(
			`coin-moebius/dodopayments: redirect URL scheme "${parsed.protocol}" is not allowed`,
		);
	}
}
