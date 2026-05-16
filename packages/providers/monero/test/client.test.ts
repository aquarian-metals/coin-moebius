// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMoneroProvider } from '../src/index.js';
import type { MoneroInstructions } from '../src/index.js';

/**
 * Tests the client-side `createMoneroProvider` — checkout-endpoint call,
 * modal render, pending callback fire, default-modal lifecycle. The
 * actual Monero wallet RPC and indexer live server-side; nothing here
 * touches them.
 */

function sampleInstructions(overrides: Partial<MoneroInstructions> = {}): MoneroInstructions {
	return {
		paymentId: 'xmr_pro_1700000000000_abc',
		address: '8AVAR4iVqEKZApGAMRpMNNDg9wnH2ANEvgyKBcGcqWy',
		atomicAmount: '100000000000',
		xmrAmount: 0.1,
		uri: 'monero:8AVAR...?tx_amount=0.1',
		expiresAt: 1_700_000_900_000,
		...overrides,
	};
}

describe('createMoneroProvider', () => {
	beforeEach(() => {
		// Default-modal tests append to `document.body`; isolate each test
		// from any leftover overlay so `querySelector` doesn't find a stale
		// dialog from a prior test.
		document.body.innerHTML = '';
	});

	it('POSTs to the configured checkout endpoint and surfaces the instructions on onPending', async () => {
		const instructions = sampleInstructions();
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify(instructions), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				}),
		);
		const renderModal = vi.fn(
			(_instructions: MoneroInstructions, _cb: { onClose: () => void }) => () => undefined,
		);
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createMoneroProvider({
			checkoutEndpoint: 'http://test/api/checkout/monero',
			statusEndpoint: 'http://test/api/payment-status',
			fetcher: fetchStub,
			renderModal,
		});

		await provider.initiate(
			{ productId: 'pro', amount: 0.1, currency: 'XMR' },
			{ onSuccess, onError, onPending },
		);

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchStub.mock.calls[0];
		expect(calledUrl).toBe('http://test/api/checkout/monero');
		const body = JSON.parse(init?.body as string);
		expect(body).toMatchObject({ productId: 'pro', amount: 0.1, currency: 'XMR' });

		expect(renderModal).toHaveBeenCalledOnce();
		expect(renderModal.mock.calls[0][0]).toMatchObject({
			paymentId: instructions.paymentId,
			address: instructions.address,
			atomicAmount: instructions.atomicAmount,
		});

		expect(onPending).toHaveBeenCalledOnce();
		const pendingResult = onPending.mock.calls[0][0];
		expect(pendingResult.status).toBe('pending');
		expect(pendingResult.paymentId).toBe(instructions.paymentId);
		expect(pendingResult.provider).toBe('monero');
		expect(pendingResult.metadata.address).toBe(instructions.address);
		expect(pendingResult.metadata.atomicAmount).toBe(instructions.atomicAmount);
		expect(pendingResult.metadata.statusEndpoint).toBe('http://test/api/payment-status');

		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('defaults checkoutEndpoint to /api/checkout/monero when omitted', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify(sampleInstructions()), { status: 200 }),
		);
		const provider = createMoneroProvider({
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});
		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'XMR' },
			{ onSuccess: () => undefined, onError: () => undefined, onPending: () => undefined },
		);
		expect(fetchStub.mock.calls[0][0]).toBe('/api/checkout/monero');
	});

	it('calls onError when the checkout endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 500 }),
		);
		const onError = vi.fn();

		const provider = createMoneroProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'XMR' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		const err = onError.mock.calls[0][0] as Error;
		expect(err.message).toContain('responded 500');
	});

	it('calls onError when the response is missing required fields', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ paymentId: 'p1' }), { status: 200 }),
		);
		const onError = vi.fn();

		const provider = createMoneroProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'XMR' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		const err = onError.mock.calls[0][0] as Error;
		expect(err.message).toContain('missing required fields');
	});

	it('renders a default modal containing the address and amount when no renderer is provided', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify(sampleInstructions()), { status: 200 }),
		);
		const provider = createMoneroProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'XMR' },
			{ onSuccess: () => undefined, onError: () => undefined, onPending: () => undefined },
		);

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain('8AVAR4iVqEKZApGAMRpMNNDg9wnH2ANEvgyKBcGcqWy');
		expect(dialog?.textContent).toContain('0.1 XMR');
		expect(dialog?.textContent).toContain('monero:8AVAR');
	});

	it('removes the default modal when the Done button is clicked', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify(sampleInstructions()), { status: 200 }),
		);
		const provider = createMoneroProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'XMR' },
			{ onSuccess: () => undefined, onError: () => undefined, onPending: () => undefined },
		);

		const closeBtn = document.querySelector<HTMLButtonElement>('[data-action="close"]');
		expect(closeBtn).not.toBeNull();
		closeBtn?.click();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('removes the default modal when Escape is pressed', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify(sampleInstructions()), { status: 200 }),
		);
		const provider = createMoneroProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'XMR' },
			{ onSuccess: () => undefined, onError: () => undefined, onPending: () => undefined },
		);

		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
