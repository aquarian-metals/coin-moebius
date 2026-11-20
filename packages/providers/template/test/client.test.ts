// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import createProvider from '../src/index.js';

it('reports unfinished checkout without granting a payment', async () => {
	const callbacks = { onPending: vi.fn(), onError: vi.fn(), onSuccess: vi.fn() };
	await createProvider({}).initiate({ productId: 'book', amount: 2, currency: 'USD' }, callbacks);
	expect(callbacks.onError).toHaveBeenCalledOnce();
	expect(callbacks.onSuccess).not.toHaveBeenCalled();
	expect(callbacks.onPending).not.toHaveBeenCalled();
});

it('can retry loading the checkout script after a network failure', async () => {
	const callbacks = { onPending: vi.fn(), onError: vi.fn(), onSuccess: vi.fn() };
	const provider = createProvider({ publishableKey: 'fixture' });
	const order = { productId: 'book', amount: 2, currency: 'USD' };
	// The DOM fixture rejects external script loads. Each attempt should insert a fresh tag.
	const insert = vi.spyOn(document.head, 'appendChild');
	await provider.initiate(order, callbacks);
	expect(document.querySelector('script')).toBeNull();
	await provider.initiate(order, callbacks);
	expect(insert).toHaveBeenCalledTimes(2);
	expect(insert.mock.calls[0][0]).not.toBe(insert.mock.calls[1][0]);
	expect(callbacks.onError).toHaveBeenCalledTimes(2);
	for (const [error] of callbacks.onError.mock.calls)
		expect(error.message).toContain('Failed to load');
	expect(callbacks.onSuccess).not.toHaveBeenCalled();
});
