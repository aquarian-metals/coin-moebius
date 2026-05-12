import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { createCryptomusVerifier, createCryptomusCreator } from '../src/server';

// Cryptomus signature: md5( base64(jsonBody) + paymentApiKey )
function cryptomusSign(jsonBody: string, key: string) {
	return crypto
		.createHash('md5')
		.update(Buffer.from(jsonBody).toString('base64') + key)
		.digest('hex');
}

const KEY = 'cryptomus_payment_api_key';
const MERCHANT = 'merchant-uuid-abc';

describe('createCryptomusVerifier', () => {
	it('verifies a correctly-signed webhook and returns a normalized success result', async () => {
		const verify = createCryptomusVerifier({ merchantUuid: MERCHANT, paymentApiKey: KEY });
		const payload = {
			uuid: 'crypt-uuid-1',
			order_id: 'sku-1-1700000000000',
			status: 'paid',
			amount: '0.12345',
			currency: 'XMR',
			address: '4abc...',
			txid: 'tx-1',
			confirmations: 6,
		};
		const sign = cryptomusSign(JSON.stringify(payload), KEY);

		const result = await verify({ ...payload, sign }, undefined);

		expect(result.status).toBe('success');
		expect(result.paymentId).toBe('crypt-uuid-1');
		expect(result.provider).toBe('cryptomus');
		expect(result.amount).toBeCloseTo(0.12345, 5);
		expect(result.currency).toBe('XMR');
		expect(result.metadata).toMatchObject({
			address: '4abc...',
			txHash: 'tx-1',
			confirmations: 6,
		});
	});

	it('marks unfinished statuses as pending', async () => {
		const verify = createCryptomusVerifier({ merchantUuid: MERCHANT, paymentApiKey: KEY });
		const payload = {
			uuid: 'crypt-uuid-2',
			status: 'check',
			amount: '0.1',
			currency: 'XMR',
			address: '4abc...',
		};
		const sign = cryptomusSign(JSON.stringify(payload), KEY);

		const result = await verify({ ...payload, sign }, undefined);
		expect(result.status).toBe('pending');
	});

	it('rejects when the sign field is missing', async () => {
		const verify = createCryptomusVerifier({ merchantUuid: MERCHANT, paymentApiKey: KEY });
		await expect(verify({ uuid: 'x', status: 'paid' }, undefined)).rejects.toThrow(/missing sign/);
	});

	it('rejects when the signature does not match the body', async () => {
		const verify = createCryptomusVerifier({ merchantUuid: MERCHANT, paymentApiKey: KEY });
		const payload = { uuid: 'x', status: 'paid', amount: '1', currency: 'XMR', address: 'addr' };
		const sign = cryptomusSign(JSON.stringify(payload), 'wrong-key');

		await expect(verify({ ...payload, sign }, undefined)).rejects.toThrow(/invalid signature/);
	});

	it('rejects when the body is tampered after signing', async () => {
		const verify = createCryptomusVerifier({ merchantUuid: MERCHANT, paymentApiKey: KEY });
		const payload = { uuid: 'x', status: 'paid', amount: '1', currency: 'XMR', address: 'addr' };
		const sign = cryptomusSign(JSON.stringify(payload), KEY);

		await expect(verify({ ...payload, amount: '999', sign }, undefined)).rejects.toThrow(
			/invalid signature/,
		);
	});
});

describe('createCryptomusCreator', () => {
	it('signs the payload with md5(base64(json)+key) and returns the parsed result', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					result: { uuid: 'crypt-1', address: '4abc...', qr: 'data:qr', amount: '0.12' },
				}),
				{ status: 200 },
			),
		);

		const create = createCryptomusCreator({
			merchantUuid: MERCHANT,
			paymentApiKey: KEY,
			callbackUrl: 'https://x.example/api/payment-webhook',
			returnUrl: 'https://x.example/success',
			apiUrl: 'https://api.cryptomus.example/v1/payment',
		});

		const out = await create({ productId: 'sku-1', amount: 0.12, currency: 'XMR' });

		expect(out).toEqual({
			uuid: 'crypt-1',
			address: '4abc...',
			qr: 'data:qr',
			amount: '0.12',
			raw: { result: { uuid: 'crypt-1', address: '4abc...', qr: 'data:qr', amount: '0.12' } },
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://api.cryptomus.example/v1/payment');
		const headers = init?.headers as Record<string, string>;
		expect(headers.merchant).toBe(MERCHANT);
		expect(headers['Content-Type']).toBe('application/json');
		// Recompute the signature ourselves and confirm it matches.
		const expectedSign = cryptomusSign(init?.body as string, KEY);
		expect(headers.sign).toBe(expectedSign);

		const sentBody = JSON.parse(init?.body as string);
		expect(sentBody).toMatchObject({
			amount: '0.12',
			currency: 'XMR',
			url_callback: 'https://x.example/api/payment-webhook',
			url_return: 'https://x.example/success',
		});
		expect(sentBody.order_id).toMatch(/^sku-1-\d+$/);
	});

	it('throws when Cryptomus returns a non-2xx response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('forbidden', { status: 403 }));
		const create = createCryptomusCreator({
			merchantUuid: MERCHANT,
			paymentApiKey: KEY,
			callbackUrl: 'https://x.example/api/payment-webhook',
			returnUrl: 'https://x.example/success',
		});

		await expect(create({ productId: 'p', amount: 1, currency: 'XMR' })).rejects.toThrow(
			/403 forbidden/,
		);
	});

	it('throws when Cryptomus returns a result missing uuid/address', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ result: { address: 'only-addr' } }), { status: 200 }),
		);
		const create = createCryptomusCreator({
			merchantUuid: MERCHANT,
			paymentApiKey: KEY,
			callbackUrl: 'https://x.example/api/payment-webhook',
			returnUrl: 'https://x.example/success',
		});

		await expect(create({ productId: 'p', amount: 1, currency: 'XMR' })).rejects.toThrow(
			/missing uuid\/address/,
		);
	});

	it('round-trips: a creator-signed body validates against createCryptomusVerifier', async () => {
		// Capture the body the creator sends, then feed it back into the verifier
		// (with a synthetic webhook-style envelope) and confirm the round-trip works.
		let sentBody: string | undefined;
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			sentBody = init!.body as string;
			return new Response(JSON.stringify({ result: { uuid: 'u1', address: 'a1' } }), {
				status: 200,
			});
		});

		const create = createCryptomusCreator({
			merchantUuid: MERCHANT,
			paymentApiKey: KEY,
			callbackUrl: 'https://x.example/api/payment-webhook',
			returnUrl: 'https://x.example/success',
		});
		await create({ productId: 'p', amount: 1, currency: 'XMR' });

		// Now build a Cryptomus-style webhook payload and verify it.
		const webhookPayload = {
			...JSON.parse(sentBody!),
			uuid: 'u1',
			status: 'paid',
			address: 'a1',
		};
		const sign = cryptomusSign(JSON.stringify(webhookPayload), KEY);

		const verify = createCryptomusVerifier({ merchantUuid: MERCHANT, paymentApiKey: KEY });
		const result = await verify({ ...webhookPayload, sign }, undefined);
		expect(result.status).toBe('success');
		expect(result.paymentId).toBe('u1');
	});
});
