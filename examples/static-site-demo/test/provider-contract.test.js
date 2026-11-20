import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import createTemplate from '@aquarian-metals/coin-moebius-provider-template';

const verifiers = [
	['authorizenet', 'createAuthorizenetVerifier', 'signatureKey'],
	['bitcoin', 'createBitcoinVerifier', 'hmacSecret'],
	['bitcoin-cash', 'createBitcoinCashVerifier', 'hmacSecret'],
	['coinbase-business', 'createCoinbaseBusinessVerifier', 'webhookSecret'],
	['cryptomus', 'createCryptomusVerifier', 'paymentApiKey'],
	['dodopayments', 'createDodoPaymentsVerifier', 'webhookSecret'],
	['makepay', 'createMakepayVerifier', 'webhookSecret'],
	['monero', 'createMoneroVerifier', 'hmacSecret'],
	['nowpayments', 'createNowPaymentsVerifier', 'ipnSecret'],
	['paypal', 'createPaypalVerifier', 'clientSecret'],
	['square', 'createSquareVerifier', 'signatureKey'],
	['stripe', 'createStripeVerifier', 'endpointSecret'],
	['zano', 'createZanoVerifier', 'hmacSecret'],
];

describe('provider trust requirements', () => {
	it('requires every provider package to declare its confirmation path', () => {
		const directories = readdirSync(new URL('../../../packages/providers/', import.meta.url), {
			withFileTypes: true,
		})
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
		expect([...verifiers.map(([id]) => id), 'manual', 'template'].sort()).toEqual(
			directories.sort(),
		);
	});
	it.each(verifiers)('%s requires its verification credential', async (id, name, credential) => {
		const pkg = await import(`@aquarian-metals/coin-moebius-${id}/server`);
		for (const value of [undefined, '', '   ']) {
			await expect(async () => {
				const verifier = pkg[name]({
					clientId: 'fixture',
					webhookId: 'fixture',
					[credential]: value,
				});
				await (typeof verifier === 'function' ? verifier : verifier.verify)('{}', {});
			}).rejects.toThrow(new RegExp(credential, 'i'));
		}
	});
	it('the starter cannot grant success before its author implements checkout', async () => {
		const callbacks = { onSuccess: vi.fn(), onError: vi.fn() };
		await createTemplate({}).initiate(
			{ productId: 'guide', amount: 19.99, currency: 'USD' },
			callbacks,
		);
		expect(callbacks.onError).toHaveBeenCalledOnce();
		expect(callbacks.onSuccess).not.toHaveBeenCalled();
	});
});
