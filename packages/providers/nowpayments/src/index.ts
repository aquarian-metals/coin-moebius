/**
 * NOWPayments client-side provider for Coin Moebius.
 *
 * Hosted-checkout flow only — calls the configured checkout endpoint on the
 * customer's backend (or Coin Moebius Cloud), receives an `invoice_url`, and
 * redirects the buyer there. NOWPayments handles the coin selection,
 * blockchain monitoring, and forwarding to the merchant's payout wallet.
 *
 * The server-side IPN verifier lives at `./server` so this client-only entry
 * doesn't pull NOWPayments-specific Node/Web crypto into browser bundles.
 *
 *     import { createNowPaymentsProvider } from '@aquarian-metals/coin-moebius-nowpayments';
 *     const nowpayments = createNowPaymentsProvider({
 *       checkoutEndpoint: 'https://api.coinmoebius.com/api/checkout/nowpayments/proj_xxx',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [nowpayments] });
 *     await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
 */
import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

/** Client-side config. The customer's API key + IPN secret stay server-side. */
export interface NowPaymentsProviderConfig {
	/** Full URL of the checkout endpoint that returns `{ url: invoice_url }`. */
	checkoutEndpoint: string;
	/**
	 * Optional pinned `pay_currency` (e.g., "btc", "xmr"). When omitted,
	 * NOWPayments shows the buyer a coin picker on its hosted page.
	 */
	payCurrency?: string;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/** Optional navigation override — used by tests. Defaults to `location.assign`. */
	navigate?: (url: string) => void;
}

interface CheckoutResponse {
	url: string;
	/** The `invoice_id` echoed back from NOWPayments — useful for status polling. */
	paymentId?: string;
}

/**
 * Build a `PaymentProvider` registered as `id: 'nowpayments'`. Returns a
 * `PaymentResult` with status `'pending'` immediately after redirect, since
 * the actual settlement happens asynchronously and lands via the IPN webhook
 * on the server side. Consumers wanting buyer-side completion notice should
 * also call `manager.subscribeToStatus(paymentId, …)` after `initiate`
 * resolves.
 */
export function createNowPaymentsProvider(config: NowPaymentsProviderConfig): PaymentProvider {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const navigate =
		config.navigate ??
		((url: string) => {
			window.location.assign(url);
		});

	return {
		id: 'nowpayments',
		name: 'NOWPayments',
		async initiate(options: InitiateOptions, callbacks): Promise<void> {
			try {
				const body: Record<string, unknown> = {
					productId: options.productId,
					amount: options.amount,
					currency: options.currency,
				};
				if (config.payCurrency) body.payCurrency = config.payCurrency;
				if (options.metadata) body.metadata = options.metadata;

				const response = await fetcher(config.checkoutEndpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					throw new Error(
						`coin-moebius/nowpayments: checkout endpoint responded ${response.status}`,
					);
				}
				const payload = (await response.json()) as CheckoutResponse;
				if (!payload.url) {
					throw new Error('coin-moebius/nowpayments: checkout response missing `url`');
				}

				// Fire a pending event so the SDK's listeners can update UI before
				// we navigate away. The buyer's onSuccess will land via the
				// status-polling channel after the IPN clears server-side.
				const result: PaymentResult = {
					status: 'pending',
					paymentId: payload.paymentId ?? '',
					provider: 'nowpayments',
					amount: options.amount,
					currency: options.currency,
					metadata: options.metadata ?? {},
					timestamp: Date.now(),
				};
				callbacks.onPending?.(result);
				navigate(payload.url);
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};
}
