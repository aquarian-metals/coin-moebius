// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createBitcoinCashProvider } from '../src/index.js';
import type { BitcoinCashInstructions } from '../src/index.js';

const ADDRESS = 'bitcoincash:qpazurdjn2gcwl0j8gpe7rd3n663gnhrmqgqmuw0ef';

function sampleInstructions(
	overrides: Partial<BitcoinCashInstructions> = {},
): BitcoinCashInstructions {
	return {
		paymentId: 'bch_1dfe5a88ff9effb3',
		address: ADDRESS,
		atomicAmount: '3998000',
		bchAmount: 0.03998,
		uri: `${ADDRESS}?amount=0.03998`,
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

async function errorFor(instructions: BitcoinCashInstructions | object): Promise<string> {
	const onError = vi.fn();
	const provider = createBitcoinCashProvider({
		fetcher: okFetch(instructions),
		renderModal: () => () => undefined,
	});
	await provider.initiate(
		{ productId: 'p', amount: 0.001, currency: 'BCH' },
		{ onSuccess: () => undefined, onError },
	);
	expect(onError).toHaveBeenCalledOnce();
	return (onError.mock.calls[0][0] as Error).message;
}

describe('createBitcoinCashProvider', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('POSTs to the configured checkout endpoint and surfaces the instructions on onPending', async () => {
		const instructions = sampleInstructions();
		const fetchStub = okFetch(instructions);
		const renderModal = vi.fn(
			(_instructions: BitcoinCashInstructions, _cb: { onClose: () => void }) => () => undefined,
		);
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createBitcoinCashProvider({
			checkoutEndpoint: 'http://test/api/checkout/bitcoin-cash',
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
		expect(calledUrl).toBe('http://test/api/checkout/bitcoin-cash');
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
		expect(pendingResult.provider).toBe('bitcoin-cash');
		expect(pendingResult.metadata.address).toBe(instructions.address);
		expect(pendingResult.metadata.bchAmount).toBe(0.03998);
		expect(pendingResult.metadata.statusEndpoint).toBe('http://test/api/payment-status');

		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('defaults checkoutEndpoint to /api/checkout/bitcoin-cash and id to bitcoin-cash', async () => {
		const fetchStub = okFetch(sampleInstructions());
		const provider = createBitcoinCashProvider({
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});
		expect(provider.id).toBe('bitcoin-cash');
		expect(provider.name).toBe('Bitcoin Cash');
		await provider.initiate({ productId: 'p', amount: 0.001, currency: 'BCH' }, noCallbacks);
		expect(fetchStub.mock.calls[0][0]).toBe('/api/checkout/bitcoin-cash');
	});

	it('calls onError when the checkout endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 500 }),
		);
		const onError = vi.fn();
		const provider = createBitcoinCashProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.001, currency: 'BCH' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toContain('responded 500');
	});

	it('calls onError when the response is missing required fields', async () => {
		expect(await errorFor({ paymentId: 'p1', address: ADDRESS })).toContain(
			'missing required fields',
		);
	});

	it('calls onError when the satoshi amount is not a whole number', async () => {
		expect(await errorFor(sampleInstructions({ atomicAmount: '0.0002' }))).toContain(
			'missing required fields',
		);
	});

	it('calls onError when the wallet link is not a bitcoincash: link', async () => {
		expect(await errorFor(sampleInstructions({ uri: 'https://evil.example/pay' }))).toContain(
			'not allowed',
		);
		expect(
			await errorFor(sampleInstructions({ uri: `bitcoin:${ADDRESS.slice(12)}?amount=1` })),
		).toContain('not allowed');
	});

	it('accepts the test-network and regtest link prefixes', async () => {
		for (const address of [
			'bchtest:qpazurdjn2gcwl0j8gpe7rd3n663gnhrmqvjlmvc74',
			'bchreg:qpazurdjn2gcwl0j8gpe7rd3n663gnhrmqkwf60tan',
		]) {
			const onError = vi.fn();
			const provider = createBitcoinCashProvider({
				fetcher: okFetch(sampleInstructions({ address, uri: `${address}?amount=0.03998` })),
				renderModal: () => () => undefined,
			});
			await provider.initiate(
				{ productId: 'p', amount: 0.001, currency: 'BCH' },
				{ onSuccess: () => undefined, onError },
			);
			expect(onError).not.toHaveBeenCalled();
		}
	});

	it('calls onError when the wallet link is not a URI at all', async () => {
		expect(await errorFor(sampleInstructions({ uri: 'not a uri' }))).toContain('invalid URI');
	});

	it('renders a default modal naming the network, the exact amount, and the address', async () => {
		const provider = createBitcoinCashProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: okFetch(sampleInstructions()),
		});

		await provider.initiate({ productId: 'p', amount: 19.99, currency: 'USD' }, noCallbacks);

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain('Pay with Bitcoin Cash');
		expect(dialog?.textContent).toContain('0.03998 BCH');
		expect(dialog?.textContent).toContain('Send only on the Bitcoin Cash network');
		expect(dialog?.textContent).toContain(ADDRESS);
		expect(dialog?.textContent).toContain(`${ADDRESS}?amount=0.03998`);
	});

	it('prints the amount from satoshis, never from the float beside it', async () => {
		const provider = createBitcoinCashProvider({
			fetcher: okFetch(sampleInstructions({ atomicAmount: '1', bchAmount: 1e-8 })),
		});

		await provider.initiate({ productId: 'p', amount: 1, currency: 'USD' }, noCallbacks);

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain('0.00000001 BCH');
		expect(dialog?.textContent).not.toContain('1e-8');
	});

	it('removes the default modal when the Done button is clicked', async () => {
		const provider = createBitcoinCashProvider({ fetcher: okFetch(sampleInstructions()) });
		await provider.initiate({ productId: 'p', amount: 0.001, currency: 'BCH' }, noCallbacks);

		const closeBtn = document.querySelector<HTMLButtonElement>('[data-action="close"]');
		expect(closeBtn).not.toBeNull();
		closeBtn?.click();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('removes the default modal when Escape is pressed', async () => {
		const provider = createBitcoinCashProvider({ fetcher: okFetch(sampleInstructions()) });
		await provider.initiate({ productId: 'p', amount: 0.001, currency: 'BCH' }, noCallbacks);

		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
