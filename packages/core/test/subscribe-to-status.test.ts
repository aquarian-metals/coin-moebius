import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPaymentManager, type PaymentResult } from '../src/index';

function pendingResult(): PaymentResult {
	return {
		status: 'pending',
		paymentId: 'p1',
		provider: 'monero',
		amount: 0.12,
		currency: 'XMR',
		metadata: { confirmations: 2 },
		timestamp: Date.now(),
	};
}

function successResult(): PaymentResult {
	return { ...pendingResult(), status: 'success' };
}

describe('manager.subscribeToStatus', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		// Pin the poll jitter (nextDelay uses Math.random for +/-10%) so the
		// timer-advance assertions are deterministic. Without this, the tick that
		// crosses timeoutMs lands at a jittered time and can slip just past a
		// fixed advanceTimersByTimeAsync window under load (e.g. the coverage run),
		// flaking the onTimeout test. 0.5 -> jitter factor 1.0 -> exact intervals.
		vi.spyOn(Math, 'random').mockReturnValue(0.5);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const buildManager = () =>
		createPaymentManager({
			providers: [{ id: 'monero', name: 'monero', initiate: () => undefined }],
		});

	it('polls the configured endpoint and fires onPending while pending', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(pendingResult()), { status: 200 }));
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const payments = buildManager();
		const stop = payments.subscribeToStatus(
			'p1',
			{ statusEndpoint: '/api/status', onPending, onSuccess },
			{ pollIntervalMs: 1000, timeoutMs: 60_000 },
		);

		await vi.advanceTimersByTimeAsync(1100);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(onPending).toHaveBeenCalledTimes(1);
		expect(onSuccess).not.toHaveBeenCalled();

		stop();
	});

	it('fires onSuccess and stops polling once status flips to success', async () => {
		let call = 0;
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			call += 1;
			return new Response(JSON.stringify(call < 2 ? pendingResult() : successResult()), {
				status: 200,
			});
		});
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const payments = buildManager();
		payments.subscribeToStatus(
			'p1',
			{ statusEndpoint: '/api/status', onPending, onSuccess },
			{ pollIntervalMs: 1000 },
		);

		await vi.advanceTimersByTimeAsync(2200);
		expect(onSuccess).toHaveBeenCalledTimes(1);
		const callsAtSuccess = fetchMock.mock.calls.length;

		// further ticks should not re-poll
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchMock.mock.calls.length).toBe(callsAtSuccess);
	});

	it('calls onTimeout once timeoutMs elapses', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(pendingResult()), { status: 200 }),
		);
		const onTimeout = vi.fn();
		const payments = buildManager();
		payments.subscribeToStatus(
			'p1',
			{ statusEndpoint: '/api/status', onTimeout },
			{ pollIntervalMs: 1000, timeoutMs: 5000 },
		);

		await vi.advanceTimersByTimeAsync(6000);
		expect(onTimeout).toHaveBeenCalledTimes(1);
	});

	it('keeps polling when fetch errors transiently', async () => {
		let call = 0;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			call += 1;
			if (call === 1) throw new Error('network blip');
			return new Response(JSON.stringify(successResult()), { status: 200 });
		});
		const onSuccess = vi.fn();
		const payments = buildManager();
		payments.subscribeToStatus(
			'p1',
			{ statusEndpoint: '/api/status', onSuccess },
			{ pollIntervalMs: 1000 },
		);

		await vi.advanceTimersByTimeAsync(2200);
		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it('fires onFailed and STOPS polling on a terminal non-success status (W1)', async () => {
		const refunded: PaymentResult = { ...pendingResult(), status: 'refunded' };
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(refunded), { status: 200 }));
		const onFailed = vi.fn();
		const payments = buildManager();

		payments.subscribeToStatus(
			'p1',
			{ statusEndpoint: '/api/status', onFailed },
			{ pollIntervalMs: 1000 },
		);

		await vi.advanceTimersByTimeAsync(1100);
		expect(onFailed).toHaveBeenCalledTimes(1);

		// Polling must have stopped — no further fetches after the terminal status.
		const callsAfterTerminal = fetchMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(10000);
		expect(fetchMock.mock.calls.length).toBe(callsAfterTerminal);
	});

	it('returns an unsubscribe that halts polling', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(pendingResult()), { status: 200 }));
		const payments = buildManager();
		const stop = payments.subscribeToStatus(
			'p1',
			{ statusEndpoint: '/api/status' },
			{ pollIntervalMs: 1000 },
		);
		stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
