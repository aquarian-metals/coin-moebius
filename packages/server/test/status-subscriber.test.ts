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

	it.each([false, true])('serializes slow reads and honors cancellation (%s)', async (cancel) => {
		let finish!: (record: PaymentRecord) => void;
		const get = vi.fn(
			() =>
				new Promise<PaymentRecord>((resolve) => {
					finish = resolve;
				}),
		);
		const onSuccess = vi.fn();
		const stop = createStatusSubscriber({ get, upsert: async () => undefined })(
			'p1',
			{ onSuccess },
			{ pollIntervalMs: 10 },
		);
		await vi.advanceTimersByTimeAsync(50);
		expect(get).toHaveBeenCalledOnce();
		if (cancel) stop();
		finish(baseRecord('success'));
		await vi.advanceTimersByTimeAsync(50);
		expect(onSuccess).toHaveBeenCalledTimes(cancel ? 0 : 1);
	});
	it('retries a transient read error and ignores the wrong order', async () => {
		const get = vi
			.fn()
			.mockRejectedValueOnce(new Error('unavailable'))
			.mockResolvedValueOnce({ ...baseRecord('success'), paymentId: 'other' })
			.mockResolvedValueOnce(baseRecord('success'));
		const onSuccess = vi.fn();
		createStatusSubscriber({ get, upsert: async () => undefined })(
			'p1',
			{ onSuccess },
			{ pollIntervalMs: 10 },
		);
		await vi.advanceTimersByTimeAsync(20);
		expect(onSuccess).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(10);
		expect(onSuccess).toHaveBeenCalledOnce();
	});
	it('times out once even if the store never responds', async () => {
		let finish!: (record: PaymentRecord) => void;
		const get = () =>
			new Promise<PaymentRecord>((resolve) => {
				finish = resolve;
			});
		const onSuccess = vi.fn(),
			onTimeout = vi.fn();
		createStatusSubscriber({ get, upsert: async () => undefined })(
			'p1',
			{ onSuccess, onTimeout },
			{ pollIntervalMs: 10, timeoutMs: 30 },
		);
		await vi.advanceTimersByTimeAsync(40);
		finish(baseRecord('success'));
		await vi.advanceTimersByTimeAsync(10);
		expect(onTimeout).toHaveBeenCalledOnce();
		expect(onSuccess).not.toHaveBeenCalled();
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
