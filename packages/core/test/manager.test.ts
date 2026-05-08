import { describe, it, expect, vi } from 'vitest';
import { createPaymentManager, type PaymentProvider, type PaymentResult } from '../src/index';

function makeProvider(id: string, behaviour: 'success' | 'pending' | 'error' = 'success'): PaymentProvider {
	return {
		id,
		name: id,
		initiate(options, callbacks) {
			const result: PaymentResult = {
				status: behaviour === 'success' ? 'success' : 'pending',
				paymentId: `${id}-payment`,
				provider: id,
				amount: options.amount,
				currency: options.currency,
				metadata: options.metadata ?? {},
				timestamp: 1700000000000,
			};
			if (behaviour === 'success') callbacks.onSuccess(result);
			else if (behaviour === 'pending') callbacks.onPending?.(result);
			else callbacks.onError(new Error(`${id} blew up`));
		},
	};
}

describe('createPaymentManager', () => {
	it('dispatches initiate to the matching provider', () => {
		const stripe = makeProvider('stripe');
		const monero = makeProvider('monero');
		const stripeSpy = vi.spyOn(stripe, 'initiate');
		const moneroSpy = vi.spyOn(monero, 'initiate');

		const payments = createPaymentManager({ providers: [stripe, monero] });
		payments.initiate({ productId: 'p', amount: 10, currency: 'USD', providerId: 'monero' });

		expect(moneroSpy).toHaveBeenCalledOnce();
		expect(stripeSpy).not.toHaveBeenCalled();
	});

	it('falls back to the first provider when providerId is omitted', () => {
		const stripe = makeProvider('stripe');
		const monero = makeProvider('monero');
		const stripeSpy = vi.spyOn(stripe, 'initiate');

		const payments = createPaymentManager({ providers: [stripe, monero] });
		payments.initiate({ productId: 'p', amount: 10, currency: 'USD' });

		expect(stripeSpy).toHaveBeenCalledOnce();
	});

	it('throws on unknown providerId', () => {
		const payments = createPaymentManager({ providers: [makeProvider('stripe')] });
		expect(() =>
			payments.initiate({ productId: 'p', amount: 1, currency: 'USD', providerId: 'nope' })
		).toThrow(/unknown provider "nope"/);
	});

	it('fans out onSuccess events to every listener', () => {
		const provider = makeProvider('stripe', 'success');
		const payments = createPaymentManager({ providers: [provider] });

		const a = vi.fn();
		const b = vi.fn();
		payments.onSuccess(a);
		payments.onSuccess(b);

		payments.initiate({ productId: 'p', amount: 10, currency: 'USD' });

		expect(a).toHaveBeenCalledOnce();
		expect(b).toHaveBeenCalledOnce();
		expect(a.mock.calls[0][0].status).toBe('success');
	});

	it('returns an unsubscribe function from each listener', () => {
		const provider = makeProvider('stripe', 'success');
		const payments = createPaymentManager({ providers: [provider] });

		const cb = vi.fn();
		const unsubscribe = payments.onSuccess(cb);
		unsubscribe();

		payments.initiate({ productId: 'p', amount: 1, currency: 'USD' });
		expect(cb).not.toHaveBeenCalled();
	});

	it('routes pending callbacks separately from success callbacks', () => {
		const provider = makeProvider('stripe', 'pending');
		const payments = createPaymentManager({ providers: [provider] });

		const onSuccess = vi.fn();
		const onPending = vi.fn();
		payments.onSuccess(onSuccess);
		payments.onPending(onPending);

		payments.initiate({ productId: 'p', amount: 1, currency: 'USD' });

		expect(onPending).toHaveBeenCalledOnce();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('routes provider errors to onError listeners', () => {
		const provider = makeProvider('stripe', 'error');
		const payments = createPaymentManager({ providers: [provider] });

		const onError = vi.fn();
		payments.onError(onError);

		payments.initiate({ productId: 'p', amount: 1, currency: 'USD' });

		expect(onError).toHaveBeenCalledOnce();
		expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
	});
});
