import type { PaymentResult } from '@aquarian-metals/coin-moebius-core';
import type { PaymentRecord, PaymentStore } from './types';

const verifyRegistry = new Map<string, (raw: unknown, headers?: unknown) => Promise<PaymentResult>>();

export function registerVerifier(
	providerId: string,
	verifier: (raw: unknown, headers?: unknown) => Promise<PaymentResult>
) {
	verifyRegistry.set(providerId, verifier);
}

export async function verify(rawBody: unknown, headers?: unknown): Promise<PaymentResult> {
	const headerRecord = headers as Record<string, string | undefined> | undefined;
	const bodyRecord = rawBody as Record<string, string | undefined> | undefined;
	const providerId = headerRecord?.['x-provider'] || bodyRecord?.provider;
	const verifier = verifyRegistry.get(providerId ?? '');

	if (!verifier) {
		throw new Error(`coin-moebius: no verifier registered for provider "${providerId}"`);
	}

	return verifier(rawBody, headers);
}

export function createStatusSubscriber(store: PaymentStore) {
	return function subscribeToStatus(
		paymentId: string,
		handlers: {
			onPending?: (result: PaymentResult) => void;
			onSuccess?: (result: PaymentResult) => void;
			onTimeout?: () => void;
		},
		options: { pollIntervalMs?: number; timeoutMs?: number } = {}
	) {
		const { pollIntervalMs = 15000, timeoutMs = 30 * 60 * 1000 } = options;
		const start = Date.now();

		const interval = setInterval(async () => {
			if (Date.now() - start > timeoutMs) {
				clearInterval(interval);
				handlers.onTimeout?.();
				return;
			}

			const record = await store.get(paymentId);
			if (!record) return;

			if (record.status === 'pending') handlers.onPending?.(record);
			if (record.status === 'success') {
				clearInterval(interval);
				handlers.onSuccess?.(record);
			}
		}, pollIntervalMs);

		return () => clearInterval(interval);
	};
}

export { createSupabaseStore, type SupabaseStoreConfig } from './supabase';
export type { PaymentStore, PaymentRecord } from './types';
