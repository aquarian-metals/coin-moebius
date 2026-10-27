// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBitcoinProvider } from '../src/index.js';
import type { BitcoinInstructions } from '../src/index.js';

const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

function sampleInstructions(overrides: Partial<BitcoinInstructions> = {}): BitcoinInstructions {
	return {
		paymentId: 'btc_1dfe5a88ff9effb3',
		address: ADDRESS,
		atomicAmount: '19990',
		btcAmount: 0.0001999,
		uri: `bitcoin:${ADDRESS}?amount=0.0001999`,
		expiresAt: 1_700_000_900_000,
		...overrides,
	};
}

function okFetch(body: unknown) {
	return vi.fn(
		async (_url: RequestInfo | URL, _init?: RequestInit) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
	);
}

const noCallbacks = {
	onSuccess: () => undefined,
	onError: () => undefined,
	onPending: () => undefined,
};

describe('createBitcoinProvider', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('POSTs to the configured checkout endpoint and surfaces the instructions on onPending', async () => {
		const instructions = sampleInstructions();
		const fetchStub = okFetch(instructions);
		const renderModal = vi.fn(
			(_instructions: BitcoinInstructions, _cb: { onClose: () => void }) => () => undefined,
		);
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createBitcoinProvider({
			checkoutEndpoint: 'http://test/api/checkout/bitcoin',
			statusEndpoint: 'http://test/api/payment-status',
			fetcher: fetchStub,
			renderModal,
		});

		await provider.initiate(
			{ productId: 'pro', amount: 19.99, currency: 'USD' },
			{ onSuccess, onError, onPending },
		);

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchStub.mock.calls[0];
		expect(calledUrl).toBe('http://test/api/checkout/bitcoin');
		const body = JSON.parse(init?.body as string);
		expect(body).toEqual({ productId: 'pro', amount: 19.99, currency: 'USD' });

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
		expect(pendingResult.provider).toBe('bitcoin');
		expect(pendingResult.metadata.address).toBe(instructions.address);
		expect(pendingResult.metadata.btcAmount).toBe(0.0001999);
		expect(pendingResult.metadata.statusEndpoint).toBe('http://test/api/payment-status');

		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('defaults checkoutEndpoint to /api/checkout/bitcoin and id to bitcoin', async () => {
		const fetchStub = okFetch(sampleInstructions());
		const provider = createBitcoinProvider({
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});
		expect(provider.id).toBe('bitcoin');
		expect(provider.name).toBe('Bitcoin');
		await provider.initiate({ productId: 'p', amount: 0.001, currency: 'BTC' }, noCallbacks);
		expect(fetchStub.mock.calls[0][0]).toBe('/api/checkout/bitcoin');
	});

	it('calls onError when the checkout endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 500 }),
		);
		const onError = vi.fn();
		const provider = createBitcoinProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.001, currency: 'BTC' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toContain('responded 500');
	});

	it('calls onError when the response is missing required fields', async () => {
		const fetchStub = okFetch({ paymentId: 'p1', address: ADDRESS });
		const onError = vi.fn();
		const provider = createBitcoinProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.001, currency: 'BTC' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toContain('missing required fields');
	});

	it('calls onError when the satoshi amount is not a whole number', async () => {
		const fetchStub = okFetch(sampleInstructions({ atomicAmount: '0.0002' }));
		const onError = vi.fn();
		const provider = createBitcoinProvider({
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.001, currency: 'BTC' },
			{ onSuccess: () => undefined, onError },
		);
		expect((onError.mock.calls[0][0] as Error).message).toContain('missing required fields');
	});

	it('calls onError when the wallet link is not a bitcoin: link', async () => {
		const fetchStub = okFetch(sampleInstructions({ uri: 'https://evil.example/pay' }));
		const onError = vi.fn();
		const provider = createBitcoinProvider({
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.001, currency: 'BTC' },
			{ onSuccess: () => undefined, onError },
		);
		expect((onError.mock.calls[0][0] as Error).message).toContain('not allowed');
	});

	it('calls onError when the wallet link is not a URI at all', async () => {
		const fetchStub = okFetch(sampleInstructions({ uri: 'not a uri' }));
		const onError = vi.fn();
		const provider = createBitcoinProvider({
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.001, currency: 'BTC' },
			{ onSuccess: () => undefined, onError },
		);
		expect((onError.mock.calls[0][0] as Error).message).toContain('invalid URI');
	});

	it('renders a default modal naming the network, the exact amount, and the address', async () => {
		const provider = createBitcoinProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: okFetch(sampleInstructions()),
		});

		await provider.initiate({ productId: 'p', amount: 19.99, currency: 'USD' }, noCallbacks);

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain('Pay with Bitcoin');
		expect(dialog?.textContent).toContain('0.0001999 BTC');
		expect(dialog?.textContent).toContain('Send only on the Bitcoin network');
		expect(dialog?.textContent).toContain(ADDRESS);
		expect(dialog?.textContent).toContain(`bitcoin:${ADDRESS}?amount=0.0001999`);
	});

	it('prints the amount from satoshis, never from the float beside it', async () => {
		const provider = createBitcoinProvider({
			fetcher: okFetch(sampleInstructions({ atomicAmount: '1', btcAmount: 1e-8 })),
		});

		await provider.initiate({ productId: 'p', amount: 1, currency: 'USD' }, noCallbacks);

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain('0.00000001 BTC');
		expect(dialog?.textContent).not.toContain('1e-8');
	});

	it('removes the default modal when the Done button is clicked', async () => {
		const provider = createBitcoinProvider({ fetcher: okFetch(sampleInstructions()) });
		await provider.initiate({ productId: 'p', amount: 0.001, currency: 'BTC' }, noCallbacks);

		const closeBtn = document.querySelector<HTMLButtonElement>('[data-action="close"]');
		expect(closeBtn).not.toBeNull();
		closeBtn?.click();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('removes the default modal when Escape is pressed', async () => {
		const provider = createBitcoinProvider({ fetcher: okFetch(sampleInstructions()) });
		await provider.initiate({ productId: 'p', amount: 0.001, currency: 'BTC' }, noCallbacks);

		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
