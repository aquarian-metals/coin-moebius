import type { PaymentProvider, InitiateOptions, PaymentResult } from './types';

export type { PaymentProvider, InitiateOptions, PaymentResult } from './types';

export interface PaymentManagerConfig {
	providers: PaymentProvider[];
}

export function createPaymentManager(config: PaymentManagerConfig) {
	const providerMap = new Map(config.providers.map((p) => [p.id, p]));

	const listeners = {
		success: [] as Array<(result: PaymentResult) => void>,
		pending: [] as Array<(result: PaymentResult) => void>,
		error: [] as Array<(error: Error) => void>,
	};

	const manager = {
		initiate(options: InitiateOptions) {
			const providerId = options.providerId || config.providers[0]?.id;
			const provider = providerMap.get(providerId);

			if (!provider) {
				throw new Error(`coin-moebius: unknown provider "${providerId}"`);
			}

			return provider.initiate(options, {
				onSuccess: (result: PaymentResult) => listeners.success.forEach((cb) => cb(result)),
				onPending: (result: PaymentResult) => listeners.pending.forEach((cb) => cb(result)),
				onError: (err: Error) => listeners.error.forEach((cb) => cb(err)),
			});
		},

		onSuccess(cb: (result: PaymentResult) => void) {
			listeners.success.push(cb);
			return () => {
				listeners.success = listeners.success.filter((l) => l !== cb);
			};
		},

		onPending(cb: (result: PaymentResult) => void) {
			listeners.pending.push(cb);
			return () => {
				listeners.pending = listeners.pending.filter((l) => l !== cb);
			};
		},

		onError(cb: (error: Error) => void) {
			listeners.error.push(cb);
			return () => {
				listeners.error = listeners.error.filter((l) => l !== cb);
			};
		},

		subscribeToStatus(
			paymentId: string,
			handlers: {
				statusEndpoint: string;
				onPending?: (result: PaymentResult) => void;
				onSuccess?: (result: PaymentResult) => void;
				onTimeout?: () => void;
			},
			options: { pollIntervalMs?: number; timeoutMs?: number } = {}
		) {
			const { statusEndpoint, onPending, onSuccess, onTimeout } = handlers;
			const { pollIntervalMs = 15000, timeoutMs = 30 * 60 * 1000 } = options;
			const start = Date.now();

			const interval = setInterval(async () => {
				if (Date.now() - start > timeoutMs) {
					clearInterval(interval);
					onTimeout?.();
					return;
				}

				try {
					const url = `${statusEndpoint}?paymentId=${encodeURIComponent(paymentId)}`;
					const res = await fetch(url);
					if (!res.ok) return;
					const record = (await res.json()) as PaymentResult;

					if (record.status === 'pending') onPending?.(record);
					if (record.status === 'success') {
						clearInterval(interval);
						onSuccess?.(record);
					}
				} catch {
					/* poll again */
				}
			}, pollIntervalMs);

			return () => clearInterval(interval);
		},
	};

	return manager;
}
