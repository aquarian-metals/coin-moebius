// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createAuthorizenetProvider } from '../src/index.js';

/**
 * Tests the browser-side provider — session endpoint call, pending callback
 * fire, and the form-POST that lands the buyer on the hosted page. We stub
 * the form submission via the `submitForm` injection seam so we can assert
 * the action URL and field shape without touching the real DOM.
 */

describe('createAuthorizenetProvider', () => {
	it('POSTs to the session endpoint and submits a form to the returned url with the token', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(
					JSON.stringify({
						url: 'https://test.authorize.net/payment/payment',
						token: 'HOSTED_TOKEN_ABC',
						paymentId: 'cm_pay_001',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
		);
		const submitFormStub = vi.fn();
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createAuthorizenetProvider({
			sessionEndpoint: 'http://test/api/checkout/authorizenet',
			fetcher: fetchStub,
			submitForm: submitFormStub,
		});

		await provider.initiate(
			{ productId: 'pro', amount: 9.99, currency: 'USD' },
			{ onSuccess, onError, onPending },
		);

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchStub.mock.calls[0];
		expect(calledUrl).toBe('http://test/api/checkout/authorizenet');
		const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
		const body = JSON.parse(bodyStr) as Record<string, unknown>;
		expect(body.productId).toBe('pro');
		expect(body.amount).toBe(9.99);
		expect(body.currency).toBe('USD');

		expect(onPending).toHaveBeenCalledTimes(1);
		expect(submitFormStub).toHaveBeenCalledWith('https://test.authorize.net/payment/payment', {
			token: 'HOSTED_TOKEN_ABC',
		});
		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('forwards metadata through to the session endpoint when provided', async () => {
		let capturedBody: Record<string, unknown> = {};
		const fetchStub = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const bodyStr = typeof init?.body === 'string' ? init.body : '{}';
			capturedBody = JSON.parse(bodyStr) as Record<string, unknown>;
			return new Response(JSON.stringify({ url: 'https://x.example', token: 't' }), {
				status: 200,
			});
		});

		const provider = createAuthorizenetProvider({
			sessionEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			submitForm: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD', metadata: { orderRef: 'abc' } },
			{ onSuccess: () => undefined, onError: () => undefined },
		);

		expect(capturedBody.metadata).toEqual({ orderRef: 'abc' });
	});

	it('calls onError when the session endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(async () => new Response('{}', { status: 500 }));
		const submitFormStub = vi.fn();
		const onError = vi.fn();

		const provider = createAuthorizenetProvider({
			sessionEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			submitForm: submitFormStub,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		expect(submitFormStub).not.toHaveBeenCalled();
	});

	it('calls onError when the response omits url or token', async () => {
		const fetchStub = vi.fn(
			async () => new Response(JSON.stringify({ url: 'https://x.example' }), { status: 200 }),
		);
		const onError = vi.fn();

		const provider = createAuthorizenetProvider({
			sessionEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			submitForm: () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		const err = onError.mock.calls[0][0] as Error;
		expect(err.message).toContain('missing `url` or `token`');
	});

	it('falls back to an empty paymentId when the session response omits one', async () => {
		const fetchStub = vi.fn(
			async () =>
				new Response(JSON.stringify({ url: 'https://x.example', token: 't' }), { status: 200 }),
		);
		const onPending = vi.fn();
		const provider = createAuthorizenetProvider({
			sessionEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			submitForm: () => undefined,
		});
		await provider.initiate(
			{ productId: 'p', amount: 1, currency: 'USD' },
			{ onSuccess: () => undefined, onError: () => undefined, onPending },
		);
		expect(onPending).toHaveBeenCalledOnce();
		const pending = onPending.mock.calls[0][0] as { paymentId: string };
		expect(pending.paymentId).toBe('');
	});

	it('uses the real DOM form path when no submitForm override is provided', async () => {
		// happy-dom (via the file-level @vitest-environment directive) gives us
		// a working document. We spy on HTMLFormElement.submit because happy-dom
		// would otherwise try to navigate, which is not implemented in jsdom-like
		// environments. The form's action + token input are observable via the
		// DOM after the submit call.
		const submitSpy = vi
			.spyOn(globalThis.HTMLFormElement.prototype, 'submit')
			.mockImplementation(() => undefined);
		try {
			const fetchStub = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							url: 'https://accept.authorize.net/payment/payment',
							token: 'TOKEN_VIA_DOM',
						}),
						{ status: 200 },
					),
			);
			const provider = createAuthorizenetProvider({
				sessionEndpoint: 'http://test/checkout',
				fetcher: fetchStub,
			});
			await provider.initiate(
				{ productId: 'p', amount: 1, currency: 'USD' },
				{ onSuccess: () => undefined, onError: () => undefined },
			);
			expect(submitSpy).toHaveBeenCalledOnce();
			// Vitest types `mock.instances` elements as `unknown`; assert the
			// actual `this`-receiver (the form element) to read its properties.
			const form = submitSpy.mock.instances[0] as HTMLFormElement;
			expect(form.action).toBe('https://accept.authorize.net/payment/payment');
			expect(form.method.toLowerCase()).toBe('post');
			const tokenInput = form.querySelector<HTMLInputElement>('input[name="token"]');
			expect(tokenInput?.value).toBe('TOKEN_VIA_DOM');
		} finally {
			submitSpy.mockRestore();
		}
	});
});
