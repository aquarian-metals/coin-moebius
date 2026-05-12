import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStatusSubscriber } from '../src/index';
import type { PaymentRecord, PaymentStore } from '../src/types';

function fakeStore(records: Array<PaymentRecord | null>): PaymentStore {
	let i = 0;
	return {
		async upsert() {
			return;
		},
		async get() {
			const out = records[Math.min(i, records.length - 1)] ?? null;
			i += 1;
			return out;
		},
	};
}

const baseRecord = (status: PaymentRecord['status']): PaymentRecord => ({
	status,
	paymentId: 'p1',
	provider: 'cryptomus',
	amount: 0.12,
	currency: 'XMR',
	metadata: {},
	timestamp: Date.now(),
	createdAt: Date.now(),
	updatedAt: Date.now(),
});

describe('createStatusSubscriber', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('fires onPending while the store reports pending', async () => {
		const subscribe = createStatusSubscriber(fakeStore([baseRecord('pending')]));
		const onPending = vi.fn();
		subscribe('p1', { onPending }, { pollIntervalMs: 1000 });

		await vi.advanceTimersByTimeAsync(1100);
		expect(onPending).toHaveBeenCalledOnce();
	});

	it('fires onSuccess and stops once status flips', async () => {
		const subscribe = createStatusSubscriber(
			fakeStore([baseRecord('pending'), baseRecord('success')]),
		);
		const onSuccess = vi.fn();
		const onPending = vi.fn();
		subscribe('p1', { onPending, onSuccess }, { pollIntervalMs: 1000 });

		await vi.advanceTimersByTimeAsync(2200);
		expect(onSuccess).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(5000);
		// Should still be 1 — interval should have been cleared.
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it('fires onTimeout after timeoutMs', async () => {
		const subscribe = createStatusSubscriber(fakeStore([baseRecord('pending')]));
		const onTimeout = vi.fn();
		subscribe('p1', { onTimeout }, { pollIntervalMs: 1000, timeoutMs: 3000 });

		await vi.advanceTimersByTimeAsync(4000);
		expect(onTimeout).toHaveBeenCalledOnce();
	});

	it('returns an unsubscribe that halts polling', async () => {
		const get = vi.fn(async () => baseRecord('pending'));
		const subscribe = createStatusSubscriber({ upsert: async () => undefined, get });
		const stop = subscribe('p1', {}, { pollIntervalMs: 1000 });
		stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(get).not.toHaveBeenCalled();
	});
});
