/**
 * PayPal client-side provider for Coin Moebius.
 *
 * Hosted-checkout flow (PayPal Orders v2). The provider POSTs the buyer's
 * selection to the caller's `sessionEndpoint`, receives `{ url }` pointing at
 * PayPal's hosted approval page (`https://www.paypal.com/checkoutnow?token=<id>`),
 * fires `onPending`, and redirects the buyer. PayPal handles the wallet,
 * funding source picker, and buyer approval; the buyer then returns to the
 * merchant's return URL where the merchant captures the order. The final
 * `PAYMENT.CAPTURE.COMPLETED` webhook lands on the server side.
 *
 *     import { createPaypalProvider } from '@aquarian-metals/coin-moebius-paypal';
 *     const paypal = createPaypalProvider({
 *       sessionEndpoint: '/api/checkout/paypal',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [paypal] });
 *     await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
 *
 * The session endpoint is expected to call `POST /v2/checkout/orders` with
 * `intent: 'CAPTURE'` and return `{ url }` containing the response's
 * `payer-action` HATEOAS link.
 */
import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

export interface PaypalProviderConfig {
	/** Full URL of the session endpoint that returns `{ url: payer-action }`. */
	sessionEndpoint: string;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/** Optional navigation override — used by tests. Defaults to `location.assign`. */
	navigate?: (url: string) => void;
}

interface SessionResponse {
	url: string;
	/** PayPal order id, echoed back by well-behaved session endpoints. */
	paymentId?: string;
}

/**
 * Build a `PaymentProvider` registered as `id: 'paypal'`. Fires `onPending`
 * immediately after redirect; the actual settlement lands on the server via
 * the webhook (`PAYMENT.CAPTURE.COMPLETED` is the canonical success event,
 * after the merchant calls `POST /v2/checkout/orders/{id}/capture` on the
 * buyer's return).
 */
export function createPaypalProvider(config: PaypalProviderConfig): PaymentProvider {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const navigate =
		config.navigate ??
		((url: string) => {
			window.location.assign(url);
		});

	return {
		id: 'paypal',
		name: 'PayPal',
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
					throw new Error(`coin-moebius/paypal: session endpoint responded ${response.status}`);
				}
				const payload = (await response.json()) as SessionResponse;
				if (!payload.url) {
					throw new Error('coin-moebius/paypal: session response missing `url`');
				}

				const result: PaymentResult = {
					status: 'pending',
					paymentId: payload.paymentId ?? '',
					provider: 'paypal',
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
		throw new Error(`coin-moebius/paypal: redirect URL scheme "${parsed.protocol}" is not allowed`);
	}
}
