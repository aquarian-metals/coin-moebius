import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { handleStripeCheckout } from '../dev-api/checkout-stripe.js';
import { handleCryptomusCheckout } from '../dev-api/checkout-cryptomus.js';
import { handlePaymentWebhook } from '../dev-api/payment-webhook.js';
import { handlePaymentStatus } from '../dev-api/payment-status.js';
import {
	getMoneroHmacSecret,
	getZanoHmacSecret,
	getBitcoinHmacSecret,
	getBitcoinCashHmacSecret,
} from '../dev-api/_shared.js';

const sessionCreate = vi.hoisted(() => vi.fn());
vi.mock('stripe', async (importOriginal) => {
	const { default: ActualStripe } = await importOriginal();
	return {
		default: class extends ActualStripe {
			constructor(...args) {
				super(...args);
				this.checkout.sessions.create = sessionCreate;
			}
		},
	};
});

async function call(handler, url, body, headers = {}) {
	const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), {
		url,
		headers,
	});
	const response = {
		statusCode: 200,
		setHeader: vi.fn(),
		end(payload) {
			this.payload = payload;
		},
	};
	await handler(request, response);
	return response;
}
async function stripeEvent(id, type, payment_status, amount_total = 1999, currency = 'usd') {
	const body = {
		type,
		data: {
			object: {
				object: 'checkout.session',
				id,
				payment_intent: 'pi_fixture',
				mode: 'payment',
				status: 'complete',
				payment_status,
				amount_total,
				currency,
			},
		},
	};
	const signature = Stripe.webhooks.generateTestHeaderString({
		payload: JSON.stringify(body),
		secret: process.env.STRIPE_WEBHOOK_SECRET,
	});
	return call(handlePaymentWebhook, '/api/payment-webhook/stripe', body, {
		'stripe-signature': signature,
	});
}
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
describe('demo checkout and payment status', () => {
	it.each([
		['MONERO_HMAC_SECRET', 'MONERO_MOCK', getMoneroHmacSecret],
		['ZANO_HMAC_SECRET', 'ZANO_MOCK', getZanoHmacSecret],
		['BITCOIN_HMAC_SECRET', 'BITCOIN_REGTEST', getBitcoinHmacSecret],
		['BCH_HMAC_SECRET', 'BCH_REGTEST', getBitcoinCashHmacSecret],
	])('requires %s outside explicit local simulation', (name, mode, readKey) => {
		vi.stubEnv(name, undefined);
		vi.stubEnv(mode, undefined);
		expect(readKey()).toBeUndefined();
		vi.stubEnv(name, '   ');
		expect(readKey()).toBeUndefined();
		vi.stubEnv(mode, 'true');
		const key = readKey();
		expect(key).toMatch(/^[a-f0-9]{64}$/);
		expect(readKey()).toBe(key);
		vi.stubEnv(name, 'configured-fixture');
		expect(readKey()).toBe('configured-fixture');
	});
	it('generates independent local keys for each provider and fresh process state', async () => {
		for (const name of [
			'MONERO_HMAC_SECRET',
			'ZANO_HMAC_SECRET',
			'BITCOIN_HMAC_SECRET',
			'BCH_HMAC_SECRET',
		])
			vi.stubEnv(name, undefined);
		for (const mode of ['MONERO_MOCK', 'ZANO_MOCK', 'BITCOIN_REGTEST', 'BCH_REGTEST'])
			vi.stubEnv(mode, 'true');
		const keys = [
			getMoneroHmacSecret(),
			getZanoHmacSecret(),
			getBitcoinHmacSecret(),
			getBitcoinCashHmacSecret(),
		];
		expect(new Set(keys).size).toBe(4);
		vi.resetModules();
		const fresh = await import('../dev-api/_shared.js');
		const next = [
			fresh.getMoneroHmacSecret(),
			fresh.getZanoHmacSecret(),
			fresh.getBitcoinHmacSecret(),
			fresh.getBitcoinCashHmacSecret(),
		];
		expect(new Set([...keys, ...next]).size).toBe(8);
	});
	it('keeps unconfigured indexers out of the webhook routes', async () => {
		for (const [id, key, mode] of [
			['monero', 'MONERO_HMAC_SECRET', 'MONERO_MOCK'],
			['zano', 'ZANO_HMAC_SECRET', 'ZANO_MOCK'],
			['bitcoin', 'BITCOIN_HMAC_SECRET', 'BITCOIN_REGTEST'],
			['bitcoin-cash', 'BCH_HMAC_SECRET', 'BCH_REGTEST'],
		]) {
			vi.stubEnv(key, undefined);
			vi.stubEnv(mode, undefined);
			const response = await call(handlePaymentWebhook, '/api/payment-webhook/' + id, {});
			expect(response.statusCode).toBe(400);
			expect(response.payload).toContain('no verifier registered');
		}
	});
	it('uses the Stripe catalog and grants success only after matching paid confirmation', async () => {
		vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fixture');
		vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_fixture');
		sessionCreate.mockResolvedValue({ id: 'cs_fixture', url: 'https://checkout.stripe.com/test' });
		expect((await call(handleStripeCheckout, '/', { productId: 'unlisted' })).statusCode).toBe(404);
		expect(sessionCreate).not.toHaveBeenCalled();
		await call(handleStripeCheckout, '/', {
			productId: 'jamstack-guide',
			amount: 7,
			currency: 'CAD',
			metadata: { test: 'browser' },
		});
		expect(sessionCreate.mock.calls[0][0]).toMatchObject({
			line_items: [{ price_data: { unit_amount: 1999, currency: 'usd' } }],
		});
		expect(sessionCreate.mock.calls[0][0].metadata).toEqual({ productId: 'jamstack-guide' });
		const poll = async () =>
			JSON.parse(
				(await call(handlePaymentStatus, '/api/payment-status?paymentId=cs_fixture')).payload,
			).status;
		for (const [id, total, currency] of [
			['unrelated', 1999, 'usd'],
			['cs_fixture', 700, 'usd'],
			['cs_fixture', 1999, 'cad'],
		]) {
			expect(
				(await stripeEvent(id, 'checkout.session.completed', 'paid', total, currency)).statusCode,
			).toBe(409);
		}
		expect(
			(await stripeEvent('cs_fixture', 'checkout.session.completed', 'unpaid')).statusCode,
		).toBe(200);
		expect(await poll()).toBe('pending');
		for (const type of [
			'checkout.session.async_payment_succeeded',
			'checkout.session.async_payment_succeeded',
			'checkout.session.completed',
		]) {
			expect(
				(await stripeEvent('cs_fixture', type, type.endsWith('succeeded') ? 'paid' : 'unpaid'))
					.statusCode,
			).toBe(200);
			expect(await poll()).toBe('success');
		}
	});
	it('bills the catalog amount and stores server-selected metadata for Cryptomus', async () => {
		vi.stubEnv('CRYPTOMUS_MERCHANT_UUID', 'merchant');
		vi.stubEnv('CRYPTOMUS_PAYMENT_API_KEY', 'key');
		vi.stubEnv('CRYPTOMUS_CALLBACK_URL', 'https://shop.example/webhook');
		const fetcher = vi
			.fn()
			.mockResolvedValue(Response.json({ result: { uuid: 'crypt_fixture', address: 'address' } }));
		vi.stubGlobal('fetch', fetcher);
		expect((await call(handleCryptomusCheckout, '/', { productId: 'unlisted' })).statusCode).toBe(
			404,
		);
		expect(fetcher).not.toHaveBeenCalled();
		await call(handleCryptomusCheckout, '/', {
			productId: 'jamstack-guide',
			amount: 7,
			currency: 'CAD',
			metadata: { test: 'browser' },
		});
		expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
			amount: '19.99',
			currency: 'USD',
		});
		const record = JSON.parse(
			(await call(handlePaymentStatus, '/api/payment-status?paymentId=crypt_fixture')).payload,
		);
		expect(record).toMatchObject({
			status: 'pending',
			amount: 19.99,
			currency: 'USD',
			metadata: { productId: 'jamstack-guide' },
		});
		expect(record.metadata).not.toHaveProperty('test');
	});
});

describe('standalone self-hosted examples', () => {
	it('matches a saved order and preserves the expected price through a partial payment', async () => {
		const { createMemoryStore } = await import('@aquarian-metals/coin-moebius-server');
		const { recordIndexerPayment } = await import('../record-indexer-payment.js');
		const store = createMemoryStore();
		const deliver = vi.fn();
		const order = {
			provider: 'bitcoin',
			paymentId: 'invoice',
			amount: 3,
			currency: 'USD',
			status: 'pending',
			metadata: { productId: 'guide' },
			timestamp: 1,
			createdAt: 1,
			updatedAt: 1,
		};
		const paid = { ...order, status: 'success', metadata: {} };
		expect((await recordIndexerPayment(store, paid, deliver)).status).toBe(409);
		await store.upsert(order);
		for (const mismatch of [{ amount: 2 }, { currency: 'CAD' }, { provider: 'zano' }]) {
			expect((await recordIndexerPayment(store, { ...paid, ...mismatch }, deliver)).status).toBe(
				409,
			);
		}
		await recordIndexerPayment(store, { ...paid, status: 'partial', amount: 1 }, deliver);
		expect(deliver).not.toHaveBeenCalled();
		deliver.mockRejectedValueOnce(new Error('temporary delivery failure'));
		await expect(recordIndexerPayment(store, paid, deliver)).rejects.toThrow(/temporary/);
		deliver.mockClear();
		await Promise.all([
			recordIndexerPayment(store, paid, deliver),
			recordIndexerPayment(store, paid, deliver),
		]);
		expect(deliver).toHaveBeenCalledOnce();
		expect(deliver).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ productId: 'guide', invoiceAmount: 3 }),
			}),
		);
	});
});
