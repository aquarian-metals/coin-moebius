/**
 * Square client-side provider for Coin Moebius.
 *
 * Hosted-checkout flow via Square's Payment Link API. The provider POSTs the
 * buyer's selection to the caller's `sessionEndpoint`, receives `{ url }`
 * pointing at the hosted checkout (`https://square.link/u/<id>` or the
 * longer `https://checkout.square.site/<id>` form), fires `onPending`, and
 * redirects the buyer. Square handles the wallet, funding source, and
 * receipt; the merchant's server receives the webhook on completion.
 *
 *     import { createSquareProvider } from '@aquarian-metals/coin-moebius-square';
 *     const square = createSquareProvider({
 *       sessionEndpoint: '/api/checkout/square',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [square] });
 *     await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
 *
 * The session endpoint is expected to call Square's
 * `POST /v2/online-checkout/payment-links` with a `quick_pay` or `order`
 * body and return `{ url }` using the `payment_link.url` value from the
 * response.
 */
import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

export interface SquareProviderConfig {
	/** Full URL of the session endpoint that returns `{ url }`. */
	sessionEndpoint: string;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/** Optional navigation override — used by tests. Defaults to `location.assign`. */
	navigate?: (url: string) => void;
}

interface SessionResponse {
	url: string;
	/** Square payment link or payment id, echoed by well-behaved session endpoints. */
	paymentId?: string;
}

/**
 * Build a `PaymentProvider` registered as `id: 'square'`. Fires `onPending`
 * immediately, then navigates to the Square-hosted checkout URL. Final
 * settlement lands on the server via webhook (HMAC-SHA256, see `./server`).
 */
export function createSquareProvider(config: SquareProviderConfig): PaymentProvider {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const navigate =
		config.navigate ??
		((url: string) => {
			window.location.assign(url);
		});

	return {
		id: 'square',
		name: 'Square',
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
					throw new Error(`coin-moebius/square: session endpoint responded ${response.status}`);
				}
				const payload = (await response.json()) as SessionResponse;
				if (!payload.url) {
					throw new Error('coin-moebius/square: session response missing `url`');
				}

				const result: PaymentResult = {
					status: 'pending',
					paymentId: payload.paymentId ?? '',
					provider: 'square',
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
		throw new Error(`coin-moebius/square: redirect URL scheme "${parsed.protocol}" is not allowed`);
	}
}
