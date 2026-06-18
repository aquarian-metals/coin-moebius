import { describe, it, expect, vi } from 'vitest';
import { createMakepayProvider } from '../src/index.js';

/**
 * Tests the client-side `createMakepayProvider` — checkout-endpoint call,
 * pending callback fire, navigation. The hosted-checkout redirect is stubbed
 * via the `navigate` injection so we can assert the URL it was handed.
 */

describe('createMakepayProvider', () => {
	it('POSTs to the configured checkout endpoint and navigates to the returned url', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ url: 'https://makepay.io/payment/abc', paymentId: 'pl_1' }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		const navigateStub = vi.fn();
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createMakepayProvider({
			checkoutEndpoint: 'http://test/api/checkout/makepay/proj_x',
			fetcher: fetchStub,
			navigate: navigateStub,
		});

		await provider.initiate(
			{ productId: 'pro', amount: 9.99, currency: 'USD' },
			{ onSuccess, onError, onPending },
		);

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchStub.mock.calls[0];
		expect(calledUrl).toBe('http://test/api/checkout/makepay/proj_x');
		const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
		const body = JSON.parse(bodyStr) as Record<string, unknown>;
		expect(body.productId).toBe('pro');
		expect(body.amount).toBe(9.99);
		expect(body.currency).toBe('USD');

		expect(onPending).toHaveBeenCalledTimes(1);
		expect(navigateStub).toHaveBeenCalledWith('https://makepay.io/payment/abc');
		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('reports a pending result carrying the returned paymentId', async () => {
		const fetchStub = vi.fn(
			async () =>
				new Response(JSON.stringify({ url: 'https://makepay.io/payment/abc', paymentId: 'pl_1' }), {
					status: 200,
				}),
		);
		const onPending = vi.fn();
		const provider = createMakepayProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError: () => undefined, onPending },
		);
		const pending = onPending.mock.calls[0][0] as { status: string; paymentId: string };
		expect(pending.status).toBe('pending');
		expect(pending.paymentId).toBe('pl_1');
	});

	it('includes metadata in the request body when provided', async () => {
		let capturedBody: Record<string, unknown> = {};
		const fetchStub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
			capturedBody = JSON.parse(bodyStr) as Record<string, unknown>;
			return new Response(JSON.stringify({ url: 'https://makepay.io/payment/x' }), { status: 200 });
		});
		const provider = createMakepayProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD', metadata: { ref: 'abc' } },
			{ onSuccess: () => undefined, onError: () => undefined },
		);

		expect(capturedBody.metadata).toEqual({ ref: 'abc' });
	});

	it('calls onError when the checkout endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(async () => new Response('{}', { status: 500 }));
		const navigateStub = vi.fn();
		const onError = vi.fn();

		const provider = createMakepayProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: navigateStub,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		expect(navigateStub).not.toHaveBeenCalled();
	});

	it('calls onError when the response omits the redirect url', async () => {
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
		);
		const onError = vi.fn();
		const provider = createMakepayProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		const err = onError.mock.calls[0][0] as Error;
		expect(err.message).toContain('missing `url`');
	});

	it('rejects redirect URLs with non-http(s) schemes', async () => {
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ url: 'javascript:alert(1)' }), { status: 200 }),
		);
		const onError = vi.fn();
		const provider = createMakepayProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		const err = onError.mock.calls[0][0] as Error;
		expect(err.message).toContain('not allowed');
	});
});
