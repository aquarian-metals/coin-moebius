import type { PaymentProvider, InitiateOptions, PaymentResult } from '@coin-moebius/core';

export interface MoneroCryptomusConfig {
	apiKey: string;
	merchantUuid: string;
}

export default function createMoneroCryptomusProvider(config: MoneroCryptomusConfig): PaymentProvider {
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
				const response = await fetch('https://api.cryptomus.com/v1/payment', {
					method: 'POST',
					headers: {
						merchant: config.merchantUuid,
						/* compute HMAC signature – see Cryptomus docs */
						sign: '',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						amount: options.amount.toString(),
						currency: 'XMR',
						order_id: `${options.productId}-${Date.now()}`,
						url_callback: `${window.location.origin}/.netlify/functions/payment-webhook`,
						url_return: `${window.location.origin}/success?paymentId=PLACEHOLDER`,
					}),
				});

				const data = (await response.json()) as {
					result?: { address?: string; uuid?: string; order_id?: string; qr?: string; amount?: string };
				};

				if (!data.result?.address) throw new Error('Failed to create Monero payment');

				const result: PaymentResult = {
					status: 'pending',
					paymentId: data.result.uuid || data.result.order_id || '',
					provider: provider.id,
					amount: options.amount,
					currency: 'XMR',
					metadata: {
						...(options.metadata || {}),
						address: data.result.address,
						qr: data.result.qr,
						amountXMR: data.result.amount,
					},
					timestamp: Date.now(),
					raw: data,
				};

				callbacks.onPending?.(result);
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};

	return provider;
}
