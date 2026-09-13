// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createZanoProvider, FREEDOM_DOLLAR_ASSET_ID, ZANO_ASSET_ID } from '../src/index.js';
import type { ZanoInstructions } from '../src/index.js';

const ADDRESS =
	'iZ2EMyPD7g28hgBfboZeCENaYrHBYZ1bLFi5cgWvn4WJLaxfgs4kqG6cJi9ai2zrXWSCpsvRXit14gKjeijx6YPCLJEv6Fx4rVm1hdAGQFis';

function sampleInstructions(overrides: Partial<ZanoInstructions> = {}): ZanoInstructions {
	return {
		paymentId: 'zano_1dfe5a88ff9effb3',
		address: ADDRESS,
		atomicAmount: '100000000000',
		assetAmount: 0.1,
		assetId: ZANO_ASSET_ID,
		ticker: 'ZANO',
		decimalPoint: 12,
		uri: `zano:action=send&address=${ADDRESS}&amount=0.1&asset_id=${ZANO_ASSET_ID}`,
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

describe('createZanoProvider', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	it('POSTs to the configured checkout endpoint and surfaces the instructions on onPending', async () => {
		const instructions = sampleInstructions();
		const fetchStub = okFetch(instructions);
		const renderModal = vi.fn(
			(_instructions: ZanoInstructions, _cb: { onClose: () => void }) => () => undefined,
		);
		const onError = vi.fn();
		const onPending = vi.fn();
		const onSuccess = vi.fn();

		const provider = createZanoProvider({
			checkoutEndpoint: 'http://test/api/checkout/zano',
			statusEndpoint: 'http://test/api/payment-status',
			fetcher: fetchStub,
			renderModal,
		});

		await provider.initiate(
			{ productId: 'pro', amount: 0.1, currency: 'ZANO' },
			{ onSuccess, onError, onPending },
		);

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const [calledUrl, init] = fetchStub.mock.calls[0];
		expect(calledUrl).toBe('http://test/api/checkout/zano');
		const body = JSON.parse(init?.body as string);
		expect(body).toEqual({ productId: 'pro', amount: 0.1, currency: 'ZANO' });

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
		expect(pendingResult.provider).toBe('zano');
		expect(pendingResult.metadata.address).toBe(instructions.address);
		expect(pendingResult.metadata.assetId).toBe(ZANO_ASSET_ID);
		expect(pendingResult.metadata.ticker).toBe('ZANO');
		expect(pendingResult.metadata.statusEndpoint).toBe('http://test/api/payment-status');

		expect(onError).not.toHaveBeenCalled();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it('defaults checkoutEndpoint to /api/checkout/zano and id to zano', async () => {
		const fetchStub = okFetch(sampleInstructions());
		const provider = createZanoProvider({ fetcher: fetchStub, renderModal: () => () => undefined });
		expect(provider.id).toBe('zano');
		expect(provider.name).toBe('Zano');
		await provider.initiate({ productId: 'p', amount: 0.1, currency: 'ZANO' }, noCallbacks);
		expect(fetchStub.mock.calls[0][0]).toBe('/api/checkout/zano');
	});

	it('sends the pinned assetId and reports under its own id for a second asset', async () => {
		const fetchStub = okFetch(
			sampleInstructions({ assetId: FREEDOM_DOLLAR_ASSET_ID, ticker: 'fUSD', decimalPoint: 4 }),
		);
		const onPending = vi.fn();
		const provider = createZanoProvider({
			id: 'fusd',
			name: 'Freedom Dollar',
			assetId: FREEDOM_DOLLAR_ASSET_ID,
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});
		expect(provider.id).toBe('fusd');
		expect(provider.name).toBe('Freedom Dollar');

		await provider.initiate(
			{ productId: 'p', amount: 19.99, currency: 'USD' },
			{ ...noCallbacks, onPending },
		);

		const body = JSON.parse(fetchStub.mock.calls[0][1]?.body as string);
		expect(body.assetId).toBe(FREEDOM_DOLLAR_ASSET_ID);
		expect(onPending.mock.calls[0][0].provider).toBe('fusd');
		expect(onPending.mock.calls[0][0].metadata.ticker).toBe('fUSD');
	});

	it('calls onError when the checkout endpoint returns non-2xx', async () => {
		const fetchStub = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 500 }),
		);
		const onError = vi.fn();
		const provider = createZanoProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'ZANO' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toContain('responded 500');
	});

	it('calls onError when the response is missing required fields', async () => {
		const fetchStub = okFetch({ paymentId: 'p1', address: ADDRESS });
		const onError = vi.fn();
		const provider = createZanoProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
			renderModal: () => () => undefined,
		});

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'ZANO' },
			{ onSuccess: () => undefined, onError },
		);
		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toContain('missing required fields');
	});

	it('calls onError when the wallet link is not a zano: link', async () => {
		const fetchStub = okFetch(sampleInstructions({ uri: 'https://evil.example/pay' }));
		const onError = vi.fn();
		const provider = createZanoProvider({ fetcher: fetchStub, renderModal: () => () => undefined });

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'ZANO' },
			{ onSuccess: () => undefined, onError },
		);
		expect((onError.mock.calls[0][0] as Error).message).toContain('not allowed');
	});

	it('calls onError when the wallet link is not a URI at all', async () => {
		const fetchStub = okFetch(sampleInstructions({ uri: 'not a uri' }));
		const onError = vi.fn();
		const provider = createZanoProvider({ fetcher: fetchStub, renderModal: () => () => undefined });

		await provider.initiate(
			{ productId: 'p', amount: 0.1, currency: 'ZANO' },
			{ onSuccess: () => undefined, onError },
		);
		expect((onError.mock.calls[0][0] as Error).message).toContain('invalid URI');
	});

	it('renders a default modal naming the asset, the amount, and the address', async () => {
		const fetchStub = okFetch(
			sampleInstructions({
				assetId: FREEDOM_DOLLAR_ASSET_ID,
				ticker: 'fUSD',
				decimalPoint: 4,
				assetAmount: 19.99,
				atomicAmount: '199900',
			}),
		);
		const provider = createZanoProvider({
			checkoutEndpoint: 'http://test/checkout',
			fetcher: fetchStub,
		});

		await provider.initiate({ productId: 'p', amount: 19.99, currency: 'USD' }, noCallbacks);

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.textContent).toContain('Pay on Zano');
		expect(dialog?.textContent).toContain('19.99 fUSD');
		expect(dialog?.textContent).toContain('Send only fUSD on the Zano network');
		expect(dialog?.textContent).toContain(ADDRESS);
		expect(dialog?.textContent).toContain('zano:action=send');
	});

	it('removes the default modal when the Done button is clicked', async () => {
		const provider = createZanoProvider({ fetcher: okFetch(sampleInstructions()) });
		await provider.initiate({ productId: 'p', amount: 0.1, currency: 'ZANO' }, noCallbacks);

		const closeBtn = document.querySelector<HTMLButtonElement>('[data-action="close"]');
		expect(closeBtn).not.toBeNull();
		closeBtn?.click();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('removes the default modal when Escape is pressed', async () => {
		const provider = createZanoProvider({ fetcher: okFetch(sampleInstructions()) });
		await provider.initiate({ productId: 'p', amount: 0.1, currency: 'ZANO' }, noCallbacks);

		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});
