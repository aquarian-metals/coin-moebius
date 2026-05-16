import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import createStripeProvider from '../src/index';

/**
 * Browser-side provider tests. The provider POSTs to the session endpoint,
 * receives `{ url }`, and redirects via `window.location.assign(url)`. We
 * mock both `fetch` (to control the endpoint response) and
 * `window.location.assign` (to capture the redirect target without actually
 * navigating away from the test environment).
 */

describe('createStripeProvider (browser)', () => {
	let assignMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		assignMock = vi.fn();
		// jsdom-style window stub; the SDK only reads `window.location.assign`.
		// Cast through `unknown` because the real `Window` type is much wider
		// than what the SDK touches, and we don't want to stand up jsdom for
		// one method.
		(globalThis as unknown as { window: { location: { assign: typeof assignMock } } }).window = {
			location: { assign: assignMock },
		};
	});

	afterEach(() => {
		delete (globalThis as unknown as { window?: unknown }).window;
		vi.restoreAllMocks();
	});

	it('POSTs to the configured sessionEndpoint with the order payload and redirects to the returned url', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_123' }), {
				status: 200,
			}),
		);
		const provider = createStripeProvider({ sessionEndpoint: '/api/create-stripe' });

		const onError = vi.fn();
		const onPending = vi.fn();
		await provider.initiate(
			{ productId: 'sku-1', amount: 19.99, currency: 'USD', metadata: { tier: 'pro' } },
			{ onSuccess: vi.fn(), onError, onPending },
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
		expect(onPending).toHaveBeenCalledOnce();
		expect(assignMock).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_123');
	});

	it('uses the default endpoint when none is configured', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_xyz' }), {
				status: 200,
			}),
		);
		const provider = createStripeProvider();

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: vi.fn(), onError: vi.fn(), onPending: vi.fn() },
		);

		expect(fetchMock.mock.calls[0][0]).toBe('/api/checkout/stripe');
	});

	it('routes a non-OK session response to onError', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
		const provider = createStripeProvider();
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: vi.fn(), onError, onPending: vi.fn() },
		);

		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/session endpoint returned 500/);
		expect(assignMock).not.toHaveBeenCalled();
	});

	it('errors when the session endpoint returns no url', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({}), { status: 200 }),
		);
		const provider = createStripeProvider();
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: vi.fn(), onError, onPending: vi.fn() },
		);

		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/did not return url/);
		expect(assignMock).not.toHaveBeenCalled();
	});
});
