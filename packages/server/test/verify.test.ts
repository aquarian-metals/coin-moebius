import { describe, it, expect, vi } from 'vitest';
import { createVerifierRegistry } from '../src/index.js';

describe('createVerifierRegistry', () => {
	it('dispatches based on the x-provider header', async () => {
		const verifiers = createVerifierRegistry();
		const stripeVerifier = vi.fn(async () => ({
			status: 'success' as const,
			paymentId: 's1',
			provider: 'stripe',
			amount: 10,
			currency: 'USD',
			metadata: {},
			timestamp: 1,
		}));
		verifiers.register('stripe', stripeVerifier);

		const result = await verifiers.verify({ foo: 'bar' }, { 'x-provider': 'stripe' });

		expect(stripeVerifier).toHaveBeenCalledOnce();
		expect(result.provider).toBe('stripe');
	});

	it('falls back to body.provider when no header is present', async () => {
		const verifiers = createVerifierRegistry();
		const cryptomusVerifier = vi.fn(async () => ({
			status: 'pending' as const,
			paymentId: 'm1',
			provider: 'cryptomus',
			amount: 0,
			currency: 'XMR',
			metadata: {},
			timestamp: 1,
		}));
		verifiers.register('cryptomus', cryptomusVerifier);

		const result = await verifiers.verify({ provider: 'cryptomus' }, undefined);

		expect(cryptomusVerifier).toHaveBeenCalledOnce();
		expect(result.provider).toBe('cryptomus');
	});

	it('rejects when no verifier is registered for the resolved provider', async () => {
		const verifiers = createVerifierRegistry();
		await expect(verifiers.verify({}, { 'x-provider': 'mystery' })).rejects.toThrow(
			/no verifier registered for provider "mystery"/,
		);
	});

	it('rejects when neither header nor body identifies a provider', async () => {
		const verifiers = createVerifierRegistry();
		await expect(verifiers.verify({}, undefined)).rejects.toThrow(/no verifier registered/);
	});

	it('isolates state across registries — registration on one does not leak to another', async () => {
		const a = createVerifierRegistry();
		const b = createVerifierRegistry();
		const stripeVerifier = vi.fn(async () => ({
			status: 'success' as const,
			paymentId: 's1',
			provider: 'stripe',
			amount: 10,
			currency: 'USD',
			metadata: {},
			timestamp: 1,
		}));
		a.register('stripe', stripeVerifier);

		// Registry b never had stripe registered.
		await expect(b.verify({}, { 'x-provider': 'stripe' })).rejects.toThrow(
			/no verifier registered/,
		);
		expect(stripeVerifier).not.toHaveBeenCalled();
	});

	it('re-registering a provider replaces the previous verifier', async () => {
		const verifiers = createVerifierRegistry();
		const oldVerifier = vi.fn(async () => ({
			status: 'pending' as const,
			paymentId: 'old',
			provider: 'stripe',
			amount: 0,
			currency: 'USD',
			metadata: {},
			timestamp: 1,
		}));
		const newVerifier = vi.fn(async () => ({
			status: 'success' as const,
			paymentId: 'new',
			provider: 'stripe',
			amount: 10,
			currency: 'USD',
			metadata: {},
			timestamp: 2,
		}));

		verifiers.register('stripe', oldVerifier);
		verifiers.register('stripe', newVerifier);

		const result = await verifiers.verify({}, { 'x-provider': 'stripe' });

		expect(newVerifier).toHaveBeenCalledOnce();
		expect(oldVerifier).not.toHaveBeenCalled();
		expect(result.paymentId).toBe('new');
	});
});
