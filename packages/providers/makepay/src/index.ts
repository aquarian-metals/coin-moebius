/**
 * MakePay client-side provider for Coin Moebius.
 *
 * Hosted-checkout flow only. Calls the configured checkout endpoint on your
 * own backend, receives MakePay's hosted checkout URL (the payment link's
 * `publicUrl`), and redirects the buyer there. MakePay handles coin selection,
 * blockchain monitoring, and direct settlement to the merchant's own wallet —
 * funds are never custodied by MakePay.
 *
 * The server-side webhook verifier lives at `./server` so this client-only
 * entry doesn't pull Node/Web crypto into browser bundles.
 *
 *     import { createMakepayProvider } from '@aquarian-metals/coin-moebius-makepay';
 *     const makepay = createMakepayProvider({
 *       checkoutEndpoint: '/api/checkout/makepay',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [makepay] });
 *     await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
 */
import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

/** Client-side config. The customer's API keys + webhook secret stay server-side. */
export interface MakepayProviderConfig {
	/** Full URL of the checkout endpoint that returns `{ url: publicUrl }`. */
	checkoutEndpoint: string;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/** Optional navigation override — used by tests. Defaults to `location.assign`. */
	navigate?: (url: string) => void;
}

interface CheckoutResponse {
	url: string;
	/** The payment link `uid` echoed back from MakePay — useful for status polling. */
	paymentId?: string;
}

/**
 * Build a `PaymentProvider` registered as `id: 'makepay'`. Returns a
 * `PaymentResult` with status `'pending'` immediately after redirect, since
 * settlement happens asynchronously and lands via the signed webhook on the
 * server side. Consumers wanting buyer-side completion notice should also call
 * `manager.subscribeToStatus(paymentId, …)` after `initiate` resolves.
 */
export function createMakepayProvider(config: MakepayProviderConfig): PaymentProvider {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const navigate =
		config.navigate ??
		((url: string) => {
			window.location.assign(url);
		});

	return {
		id: 'makepay',
		name: 'MakePay',
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
					throw new Error(`coin-moebius/makepay: checkout endpoint responded ${response.status}`);
				}
				const payload = (await response.json()) as CheckoutResponse;
				if (!payload.url) {
					throw new Error('coin-moebius/makepay: checkout response missing `url`');
				}

				// Fire a pending event so the SDK's listeners can update UI before
				// we navigate away. The buyer's onSuccess lands via the status-polling
				// channel after the signed webhook confirms server-side.
				const result: PaymentResult = {
					status: 'pending',
					paymentId: payload.paymentId ?? '',
					provider: 'makepay',
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
			`coin-moebius/makepay: redirect URL scheme "${parsed.protocol}" is not allowed`,
		);
	}
}
