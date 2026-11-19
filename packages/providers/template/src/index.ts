import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';
import { ensureScriptLoaded } from './script-loader.js';

export interface MyProviderConfig {
	publishableKey?: string;
}

export default function createMyProvider(config: MyProviderConfig): PaymentProvider {
	const provider: PaymentProvider = {
		id: 'my-provider-id',
		name: 'My Provider Name',
		icon: 'https://.../icon.svg',

		async initiate(
			_options: InitiateOptions & { providerId?: string },
			callbacks: {
				onSuccess: (result: PaymentResult) => void;
				onPending?: (result: PaymentResult) => void;
				onError: (error: Error) => void;
			},
		) {
			try {
				if (config.publishableKey) {
					await ensureScriptLoaded('https://js.stripe.com/v3/', 'Stripe');
				}

				throw new Error('Implement server-side checkout before enabling this provider');
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};

	return provider;
}
