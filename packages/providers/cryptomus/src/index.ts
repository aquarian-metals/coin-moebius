import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

/**
 * Configuration for the Cryptomus payment provider (client-side).
 */
export interface CryptomusConfig {
	/**
	 * Endpoint on your own backend that creates the Cryptomus payment.
	 * Must hold the `paymentApiKey` server-side and call `createCryptomusCreator`
	 * (from `@aquarian-metals/coin-moebius-cryptomus/server`) — never expose
	 * the API key to the browser.
	 *
	 * Defaults to `/api/checkout/cryptomus` — a vendor-neutral REST-style
	 * path that works out-of-the-box on Cloudflare Workers, Vercel, Express,
	 * or any host where you serve that route. Override for hosts with
	 * different conventions (e.g., `/.netlify/functions/create-cryptomus-payment`).
	 */
	createEndpoint?: string;
}

interface CreateCryptomusPaymentResponse {
	uuid: string;
	address: string;
	qr?: string;
	amount?: string;
}

/**
 * Create a Cryptomus payment provider.
 *
 * Cryptomus is a third-party crypto payment gateway that supports many
 * coins (Monero, btc, USDT, and others). Pick the coin via the
 * `currency` field in `InitiateOptions` — that value is forwarded to your
 * backend's create-endpoint and ultimately to Cryptomus.
 *
 * The browser entry never sees the Cryptomus API key. The actual API call
 * happens server-side via `createCryptomusCreator` from the `./server`
 * subpath of this package.
 */
export default function createCryptomusProvider(config: CryptomusConfig = {}): PaymentProvider {
	const endpoint = config.createEndpoint ?? '/api/checkout/cryptomus';

	const provider: PaymentProvider = {
		id: 'cryptomus',
		name: 'Cryptomus',
		icon: 'https://cryptomus.com/favicon.ico',

		async initiate(
			options: InitiateOptions,
			callbacks: {
				onSuccess: (result: PaymentResult) => void;
				onPending?: (result: PaymentResult) => void;
				onError: (error: Error) => void;
			},
		) {
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						productId: options.productId,
						amount: options.amount,
						currency: options.currency,
						metadata: options.metadata ?? {},
					}),
				});

				if (!response.ok) {
					throw new Error(`coin-moebius/cryptomus: create endpoint returned ${response.status}`);
				}

				const data = (await response.json()) as CreateCryptomusPaymentResponse;

				if (!data?.uuid || !data?.address) {
					throw new Error('coin-moebius/cryptomus: create endpoint did not return uuid + address');
				}

				callbacks.onPending?.({
					status: 'pending',
					paymentId: data.uuid,
					provider: provider.id,
					amount: options.amount,
					currency: options.currency,
					metadata: {
						...(options.metadata ?? {}),
						address: data.address,
						qr: data.qr,
						cryptomusAmount: data.amount,
					},
					timestamp: Date.now(),
					raw: data,
				});
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};

	return provider;
}
