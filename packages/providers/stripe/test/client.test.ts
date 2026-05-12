import { describe, it, expect, vi, beforeEach } from 'vitest';

const { loadStripe, redirectToCheckout } = vi.hoisted(() => {
	const redirectToCheckout = vi.fn(async () => ({ error: undefined as undefined | Error }));
	const loadStripe = vi.fn(async () => ({ redirectToCheckout }));
	return { loadStripe, redirectToCheckout };
});

vi.mock('@stripe/stripe-js', () => ({ loadStripe }));

import createStripeProvider from '../src/index';

describe('createStripeProvider (browser)', () => {
	beforeEach(() => {
		redirectToCheckout.mockResolvedValue({ error: undefined });
		loadStripe.mockResolvedValue({ redirectToCheckout });
	});

	it('POSTs to the configured sessionEndpoint with the order payload', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ sessionId: 'cs_123' }), { status: 200 }));
		const provider = createStripeProvider({
			publishableKey: 'pk_test',
			sessionEndpoint: '/api/create-stripe',
		});

		const onError = vi.fn();
		await provider.initiate(
			{ productId: 'sku-1', amount: 19.99, currency: 'USD', metadata: { tier: 'pro' } },
			{ onSuccess: vi.fn(), onError, onPending: vi.fn() },
		);

		expect(onError).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/create-stripe');
		expect(init?.method).toBe('POST');
		const body = JSON.parse(init?.body as string);
		expect(body).toEqual({
			productId: 'sku-1',
			amount: 19.99,
			currency: 'USD',
			metadata: { tier: 'pro' },
		});
		expect(redirectToCheckout).toHaveBeenCalledWith({ sessionId: 'cs_123' });
	});

	it('uses the default Netlify endpoint when none is configured', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ sessionId: 'cs_xyz' }), { status: 200 }));
		const provider = createStripeProvider({ publishableKey: 'pk_test' });

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: vi.fn(), onError: vi.fn(), onPending: vi.fn() },
		);

		expect(fetchMock.mock.calls[0][0]).toBe('/api/checkout/stripe');
	});

	it('routes a non-OK session response to onError', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
		const provider = createStripeProvider({ publishableKey: 'pk_test' });
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: vi.fn(), onError, onPending: vi.fn() },
		);

		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/session endpoint returned 500/);
	});

	it('routes a Stripe redirect error to onError', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ sessionId: 'cs_x' }), { status: 200 }),
		);
		redirectToCheckout.mockResolvedValueOnce({ error: new Error('redirect failed') });
		const provider = createStripeProvider({ publishableKey: 'pk_test' });
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: vi.fn(), onError, onPending: vi.fn() },
		);

		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/redirect failed/);
	});
});
