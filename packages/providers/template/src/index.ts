import type { PaymentProvider, InitiateOptions, PaymentResult } from '@aquarianmetals/coin-moebius-core';
import { ensureScriptLoaded } from './script-loader';

export interface MyProviderConfig {
	publishableKey?: string;
}

export default function createMyProvider(config: MyProviderConfig): PaymentProvider {
	const provider: PaymentProvider = {
		id: 'my-provider-id',
		name: 'My Provider Name',
		icon: 'https://.../icon.svg',

		async initiate(
			options: InitiateOptions & { providerId?: string },
			callbacks: {
				onSuccess: (result: PaymentResult) => void;
				onPending?: (result: PaymentResult) => void;
				onError: (error: Error) => void;
			}
		) {
			try {
				if (config.publishableKey) {
					await ensureScriptLoaded(
						'https://js.stripe.com/v3/',
						'Stripe'
					);
				}

				const result: PaymentResult = {
					status: 'success',
					paymentId: 'generated-id-here',
					provider: provider.id,
					amount: options.amount,
					currency: options.currency,
					metadata: options.metadata || {},
					timestamp: Date.now(),
					raw: {}
				};

				callbacks.onSuccess(result);
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		}
	};

	return provider;
}
