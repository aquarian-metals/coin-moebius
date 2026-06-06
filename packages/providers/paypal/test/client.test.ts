// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createPaypalProvider } from '../src/index.js';

/**
 * Tests the browser-side provider — session endpoint call, pending callback
 * fire, and navigation. Navigation is stubbed via the `navigate` injection
 * so we can assert it was called with the approval URL returned by the
 * session endpoint.
 */

describe('createPaypalProvider', () => {
	it('POSTs to the configured session endpoint and navigates to the returned url', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						url: 'https://www.paypal.com/checkoutnow?token=ORDER_ABC',
						paymentId: 'ORDER_ABC',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const navigateStub = vi.fn();
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createPaypalProvider({
			sessionEndpoint: 'http://test/api/checkout/paypal',
			fetcher: fetchStub,
			navigate: navigateStub,
		});

		await provider.initiate(
			{ productId: 'pro', amount: 9.99, currency: 'USD' },
			{ onSuccess, onError, onPending },
		);

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchStub.mock.calls[0];
		expect(calledUrl).toBe('http://test/api/checkout/paypal');
		const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
		const body = JSON.parse(bodyStr) as Record<string, unknown>;
		expect(body.productId).toBe('pro');
		expect(body.amount).toBe(9.99);
		expect(body.currency).toBe('USD');

		expect(onPending).toHaveBeenCalledTimes(1);
		expect(navigateStub).toHaveBeenCalledWith('https://www.paypal.com/checkoutnow?token=ORDER_ABC');
		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('forwards metadata through to the session endpoint when provided', async () => {
		let capturedBody: Record<string, unknown> = {};
		const fetchStub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
			capturedBody = JSON.parse(bodyStr) as Record<string, unknown>;
			return new Response(JSON.stringify({ url: 'https://x.example' }), { status: 200 });
		});

		const provider = createPaypalProvider({
			sessionEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD', metadata: { orderRef: 'abc' } },
			{ onSuccess: () => undefined, onError: () => undefined },
		);

		expect(capturedBody.metadata).toEqual({ orderRef: 'abc' });
	});

	it('calls onError when the session endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(async () => new Response('{}', { status: 500 }));
		const navigateStub = vi.fn();
		const onError = vi.fn();

		const provider = createPaypalProvider({
			sessionEndpoint: 'http://test/checkout',
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

		const provider = createPaypalProvider({
			sessionEndpoint: 'http://test/checkout',
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

	it('uses the real window.location.assign when no navigate override is provided', async () => {
		const assignSpy = vi.fn();
		const originalAssign = window.location.assign.bind(window.location);
		window.location.assign = assignSpy;
		try {
			const fetchStub = vi.fn(
				async () =>
					new Response(JSON.stringify({ url: 'https://www.paypal.com/checkoutnow?token=X' }), {
						status: 200,
					}),
			);
			const provider = createPaypalProvider({
				sessionEndpoint: 'http://test/checkout',
				fetcher: fetchStub,
			});
			await provider.initiate(
				{ productId: 'p', amount: 1, currency: 'USD' },
				{ onSuccess: () => undefined, onError: () => undefined },
			);
			expect(assignSpy).toHaveBeenCalledWith('https://www.paypal.com/checkoutnow?token=X');
		} finally {
			window.location.assign = originalAssign;
		}
	});

	it('rejects redirect URLs with non-http(s) schemes', async () => {
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ url: 'javascript:alert(1)' }), { status: 200 }),
		);
		const onError = vi.fn();
		const provider = createPaypalProvider({
			sessionEndpoint: 'http://test/checkout',
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

	it('succeeds without calling onPending when the callback is not provided', async () => {
		const fetchStub = vi.fn(
			async () =>
				new Response(JSON.stringify({ url: 'https://www.paypal.com/checkoutnow?token=Y' }), {
					status: 200,
				}),
		);
		const navigateStub = vi.fn();
		const provider = createPaypalProvider({
			sessionEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: navigateStub,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError: () => undefined },
		);
		expect(navigateStub).toHaveBeenCalledWith('https://www.paypal.com/checkoutnow?token=Y');
	});

	it('falls back to an empty paymentId when the session response omits one', async () => {
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ url: 'https://x.example' }), { status: 200 }),
		);
		const onPending = vi.fn();
		const provider = createPaypalProvider({
			sessionEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			navigate: () => undefined,
		});
		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError: () => undefined, onPending },
		);
		const pending = onPending.mock.calls[0][0] as { paymentId: string; metadata: object };
		expect(pending.paymentId).toBe('');
		expect(pending.metadata).toEqual({});
	});
});
