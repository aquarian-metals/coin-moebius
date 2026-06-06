/**
 * Coinbase Business client-side provider for Coin Moebius.
 *
 * Hosted-checkout flow only. The provider POSTs the buyer's selection to the
 * caller's `sessionEndpoint`, receives `{ url }` pointing at Coinbase
 * Business's `hosted_url`, fires `onPending`, and redirects the buyer there.
 * Coinbase handles the asset picker, on-chain monitoring, and forwarding.
 *
 * The server-side webhook verifier lives at `./server` and the optional
 * programmatic subscription helper at `./subscription`, so this browser
 * entry stays free of Node-only crypto and HTTP code.
 *
 *     import { createCoinbaseBusinessProvider } from '@aquarian-metals/coin-moebius-coinbase-business';
 *     const coinbase = createCoinbaseBusinessProvider({
 *       sessionEndpoint: '/api/checkout/coinbase-business',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [coinbase] });
 *     await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
 */
import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

export interface CoinbaseBusinessProviderConfig {
	/** Full URL of the session endpoint that returns `{ url: hosted_url }`. */
	sessionEndpoint: string;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/** Optional navigation override — used by tests. Defaults to `location.assign`. */
	navigate?: (url: string) => void;
}

interface SessionResponse {
	url: string;
	/** Coinbase checkout id, echoed back by well-behaved session endpoints. */
	paymentId?: string;
}

/**
 * Build a `PaymentProvider` registered as `id: 'coinbase-business'`. Returns a
 * `PaymentResult` with status `'pending'` immediately after redirect; the
 * actual settlement lands on the server via the Hook0-signed webhook.
 * Coinbase Business does not fire any in-flight event before `success` /
 * `failed` / `expired`, so consumers wanting buyer-side completion should
 * also call `manager.subscribeToStatus(paymentId, …)` after `initiate`.
 */
export function createCoinbaseBusinessProvider(
	config: CoinbaseBusinessProviderConfig,
): PaymentProvider {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const navigate =
		config.navigate ??
		((url: string) => {
			window.location.assign(url);
		});

	return {
		id: 'coinbase-business',
		name: 'Coinbase Business',
		async initiate(options: InitiateOptions, callbacks): Promise<void> {
			try {
				const body: Record<string, unknown> = {
					productId: options.productId,
					amount: options.amount,
					currency: options.currency,
				};
				if (options.metadata) body.metadata = options.metadata;

				const response = await fetcher(config.sessionEndpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					throw new Error(
						`coin-moebius/coinbase-business: session endpoint responded ${response.status}`,
					);
				}
				const payload = (await response.json()) as SessionResponse;
				if (!payload.url) {
					throw new Error('coin-moebius/coinbase-business: session response missing `url`');
				}

				const result: PaymentResult = {
					status: 'pending',
					paymentId: payload.paymentId ?? '',
					provider: 'coinbase-business',
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
			`coin-moebius/coinbase-business: redirect URL scheme "${parsed.protocol}" is not allowed`,
		);
	}
}
