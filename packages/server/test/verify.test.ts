import { describe, it, expect, vi, beforeEach } from 'vitest';

// registerVerifier mutates module-level state, so re-import per test for isolation.
async function freshServer() {
	vi.resetModules();
	return await import('../src/index');
}

describe('registerVerifier + verify', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('dispatches based on the x-provider header', async () => {
		const { registerVerifier, verify } = await freshServer();
		const stripeVerifier = vi.fn(async () => ({
			status: 'success' as const,
			paymentId: 's1',
			provider: 'stripe',
			amount: 10,
			currency: 'USD',
			metadata: {},
			timestamp: 1,
		}));
		registerVerifier('stripe', stripeVerifier);

		const result = await verify({ foo: 'bar' }, { 'x-provider': 'stripe' });

		expect(stripeVerifier).toHaveBeenCalledOnce();
		expect(result.provider).toBe('stripe');
	});

	it('falls back to body.provider when no header is present', async () => {
		const { registerVerifier, verify } = await freshServer();
		const moneroVerifier = vi.fn(async () => ({
			status: 'pending' as const,
			paymentId: 'm1',
			provider: 'monero-cryptomus',
			amount: 0,
			currency: 'XMR',
			metadata: {},
			timestamp: 1,
		}));
		registerVerifier('monero-cryptomus', moneroVerifier);

		const result = await verify({ provider: 'monero-cryptomus' }, undefined);

		expect(moneroVerifier).toHaveBeenCalledOnce();
		expect(result.provider).toBe('monero-cryptomus');
	});

	it('throws when no verifier is registered for the resolved provider', async () => {
		const { verify } = await freshServer();
		await expect(verify({}, { 'x-provider': 'mystery' })).rejects.toThrow(
			/no verifier registered for provider "mystery"/
		);
	});

	it('throws when neither header nor body identifies a provider', async () => {
		const { verify } = await freshServer();
		await expect(verify({}, undefined)).rejects.toThrow(/no verifier registered/);
	});
});
