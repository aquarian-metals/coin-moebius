import { describe, it, expect, vi } from 'vitest';
import { createNowPaymentsProvider } from '../src/index.js';

/**
 * Tests the client-side `createNowPaymentsProvider` — checkout-endpoint call,
 * pending callback fire, navigation. The actual `invoice_url` redirect is
 * stubbed via the `navigate` injection so we can assert it was called with
 * the right URL.
 */

describe('createNowPaymentsProvider', () => {
	it('POSTs to the configured checkout endpoint and navigates to the returned url', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({ url: 'https://nowpayments.io/invoice/abc', paymentId: 'inv_1' }),
					{
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					},
				),
		);
		const navigateStub = vi.fn();
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createNowPaymentsProvider({
			checkoutEndpoint: 'http://test/api/checkout/nowpayments/proj_x',
			fetcher: fetchStub,
			navigate: navigateStub,
		});

		await provider.initiate(
			{ productId: 'pro', amount: 9.99, currency: 'USD' },
			{ onSuccess, onError, onPending },
		);

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchStub.mock.calls[0];
		expect(calledUrl).toBe('http://test/api/checkout/nowpayments/proj_x');
		const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
		const body = JSON.parse(bodyStr) as Record<string, unknown>;
		expect(body.productId).toBe('pro');
		expect(body.amount).toBe(9.99);
		expect(body.currency).toBe('USD');

		expect(onPending).toHaveBeenCalledTimes(1);
		expect(navigateStub).toHaveBeenCalledWith('https://nowpayments.io/invoice/abc');
		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('passes the configured payCurrency through to the checkout endpoint', async () => {
		let capturedBody: Record<string, unknown> = {};
		const fetchStub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
			capturedBody = JSON.parse(bodyStr) as Record<string, unknown>;
			return new Response(JSON.stringify({ url: 'https://x.example' }), { status: 200 });
		});
		const provider = createNowPaymentsProvider({
			checkoutEndpoint: 'http://test/checkout',
			payCurrency: 'xmr',
			fetcher: fetchStub,
			navigate: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError: () => undefined },
		);

		expect(capturedBody.payCurrency).toBe('xmr');
	});

	it('calls onError when the checkout endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(async () => new Response('{}', { status: 500 }));
		const navigateStub = vi.fn();
		const onError = vi.fn();

		const provider = createNowPaymentsProvider({
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

		const provider = createNowPaymentsProvider({
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
});
