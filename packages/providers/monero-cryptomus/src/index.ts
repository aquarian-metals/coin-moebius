import type { PaymentProvider, InitiateOptions, PaymentResult } from '@aquarian-metals/coin-moebius-core';

export interface MoneroCryptomusConfig {
	/**
	 * Endpoint on your own backend that creates the Cryptomus payment.
	 * Must hold the `paymentApiKey` server-side and call `createCryptomusCreator`
	 * (from `@aquarian-metals/coin-moebius-monero-cryptomus/server`) — never expose
	 * the API key to the browser.
	 *
	 * Defaults to `/.netlify/functions/create-cryptomus-payment`.
	 */
	createEndpoint?: string;
}

interface CreateCryptomusPaymentResponse {
	uuid: string;
	address: string;
	qr?: string;
	amount?: string;
}

export default function createMoneroCryptomusProvider(
	config: MoneroCryptomusConfig = {}
): PaymentProvider {
	const endpoint = config.createEndpoint ?? '/.netlify/functions/create-cryptomus-payment';

	const provider: PaymentProvider = {
		id: 'monero-cryptomus',
		name: 'Monero (via Cryptomus)',
		icon: 'https://cryptomus.com/favicon.ico',

		async initiate(
			options: InitiateOptions,
			callbacks: {
				onSuccess: (result: PaymentResult) => void;
				onPending?: (result: PaymentResult) => void;
				onError: (error: Error) => void;
			}
		) {
			try {
				const response = await fetch(endpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						productId: options.productId,
						amount: options.amount,
						metadata: options.metadata ?? {},
					}),
				});

				if (!response.ok) {
					throw new Error(
						`coin-moebius/monero-cryptomus: create endpoint returned ${response.status}`
					);
				}

				const data = (await response.json()) as CreateCryptomusPaymentResponse;

				if (!data?.uuid || !data?.address) {
					throw new Error(
						'coin-moebius/monero-cryptomus: create endpoint did not return uuid + address'
					);
				}

				callbacks.onPending?.({
					status: 'pending',
					paymentId: data.uuid,
					provider: provider.id,
					amount: options.amount,
					currency: 'XMR',
					metadata: {
						...(options.metadata ?? {}),
						address: data.address,
						qr: data.qr,
						amountXMR: data.amount,
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
