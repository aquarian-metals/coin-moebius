import type { PaymentProvider, InitiateOptions, PaymentResult } from './types.js';

export type { PaymentProvider, InitiateOptions, PaymentResult } from './types.js';

export interface PaymentManagerConfig {
	providers: PaymentProvider[];
}

export function createPaymentManager(config: PaymentManagerConfig) {
	const providerMap = new Map(config.providers.map((p) => [p.id, p]));

	const listeners = {
		success: [] as ((result: PaymentResult) => void)[],
		pending: [] as ((result: PaymentResult) => void)[],
		error: [] as ((error: Error) => void)[],
	};

	const manager = {
		initiate(options: InitiateOptions) {
			const providerId = options.providerId ?? config.providers[0]?.id;
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

		/**
		 * Browser-side polling helper for delayed-confirmation flows (Monero
		 * block confirmations, Cryptomus async settlement, etc.). Hits an HTTP
		 * status endpoint on a configurable interval until the payment lands
		 * in `success` (or `pending`, repeatedly, until `timeoutMs`).
		 *
		 * Note: there's a sibling helper on the server side —
		 * `createStatusSubscriber(store)` in `@aquarian-metals/coin-moebius-server`.
		 * The split is by environment:
		 *
		 * - **This one** (browser): polls an HTTP endpoint via `fetch`. Use
		 *   when the polling happens in the buyer's browser.
		 * - **Server version**: polls a `PaymentStore` directly. Use when
		 *   the polling happens server-side (e.g., a worker waiting for a
		 *   delayed webhook before triggering downstream logic).
		 *
		 * They have different signatures because they read from different
		 * data sources; they share no implementation. Pick the one whose
		 * environment matches your call site.
		 */
		subscribeToStatus(
			paymentId: string,
			handlers: {
				statusEndpoint: string;
				onPending?: (result: PaymentResult) => void;
				onSuccess?: (result: PaymentResult) => void;
				onTimeout?: () => void;
			},
			options: { pollIntervalMs?: number; timeoutMs?: number } = {},
		) {
			const { statusEndpoint, onPending, onSuccess, onTimeout } = handlers;
			const { pollIntervalMs = 15000, timeoutMs = 30 * 60 * 1000 } = options;
			const start = Date.now();

			// setInterval expects a sync callback; we run async work inside an
			// IIFE wrapped with `void` so the returned promise is explicitly
			// fire-and-forget. The downside (a slow fetch may overlap with the
			// next tick) is a known Phase 3 candidate for refactoring to a
			// setTimeout chain that awaits before scheduling the next call.
			const interval = setInterval(() => {
				void (async () => {
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
				})();
			}, pollIntervalMs);

			return () => clearInterval(interval);
		},
	};

	return manager;
}
