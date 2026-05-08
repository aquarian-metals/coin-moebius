import { describe, it, expect, vi } from 'vitest';
import createMoneroCryptomusProvider from '../src/index';

const okResponse = (uuid = 'crypt-1', address = '4abc...') =>
	new Response(JSON.stringify({ uuid, address, qr: 'data:qr', amount: '0.12' }), { status: 200 });

describe('createMoneroCryptomusProvider (browser)', () => {
	it('POSTs to the configured endpoint and fires onPending with normalized payload', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse('uuid-1', 'addr-1'));
		const provider = createMoneroCryptomusProvider({ createEndpoint: '/api/cm' });
		const onPending = vi.fn();
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 0.12, currency: 'XMR', metadata: { tier: 'pro' } },
			{ onSuccess: vi.fn(), onPending, onError }
		);

		expect(onError).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('/api/cm');
		expect(init?.method).toBe('POST');
		const body = JSON.parse(init?.body as string);
		expect(body).toEqual({ productId: 'p', amount: 0.12, metadata: { tier: 'pro' } });

		expect(onPending).toHaveBeenCalledOnce();
		const result = onPending.mock.calls[0][0];
		expect(result.status).toBe('pending');
		expect(result.paymentId).toBe('uuid-1');
		expect(result.provider).toBe('monero-cryptomus');
		expect(result.currency).toBe('XMR');
		expect(result.metadata).toMatchObject({ tier: 'pro', address: 'addr-1', qr: 'data:qr' });
	});

	it('uses the default endpoint when none is configured', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());
		const provider = createMoneroCryptomusProvider();

		await provider.initiate(
			{ productId: 'p', amount: 0.12, currency: 'XMR' },
			{ onSuccess: vi.fn(), onPending: vi.fn(), onError: vi.fn() }
		);

		expect(fetchMock.mock.calls[0][0]).toBe('/.netlify/functions/create-cryptomus-payment');
	});

	it('routes a non-OK response to onError', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 502 }));
		const provider = createMoneroCryptomusProvider();
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 0.12, currency: 'XMR' },
			{ onSuccess: vi.fn(), onPending: vi.fn(), onError }
		);

		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/returned 502/);
	});

	it('routes a missing-uuid response to onError', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ address: 'addr-only' }), { status: 200 })
		);
		const provider = createMoneroCryptomusProvider();
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 0.12, currency: 'XMR' },
			{ onSuccess: vi.fn(), onPending: vi.fn(), onError }
		);

		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/uuid \+ address/);
	});

	it('routes thrown fetch errors to onError', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
		const provider = createMoneroCryptomusProvider();
		const onError = vi.fn();

		await provider.initiate(
			{ productId: 'p', amount: 0.12, currency: 'XMR' },
			{ onSuccess: vi.fn(), onPending: vi.fn(), onError }
		);

		expect(onError).toHaveBeenCalledOnce();
		expect((onError.mock.calls[0][0] as Error).message).toMatch(/offline/);
	});
});
