import { describe, it, expect } from 'vitest';

/**
 * `@aquarian-metals/coin-moebius` is a re-export alias for
 * `@aquarian-metals/coin-moebius-core`. The whole point of the package is
 * to give consumers a friendlier install name without forcing them to learn
 * the core/* split before they get started.
 *
 * This smoke test makes sure the re-export is real: every symbol the core
 * package exposes is reachable through the alias, with the same identity
 * (not a copy, not a wrapper). If we ever drop a re-export or accidentally
 * rename one, this test fails immediately rather than at runtime in some
 * customer's bundle.
 */
describe('@aquarian-metals/coin-moebius re-export smoke test', () => {
	it('re-exports every public symbol from coin-moebius-core', async () => {
		const alias = await import('../src/index.js');
		const core = await import('@aquarian-metals/coin-moebius-core');

		const coreKeys = Object.keys(core).sort();
		const aliasKeys = Object.keys(alias).sort();

		expect(aliasKeys).toEqual(coreKeys);
	});

	it('re-exports the same identity for each value (not a copy)', async () => {
		const alias = (await import('../src/index.js')) as Record<string, unknown>;
		const core = (await import('@aquarian-metals/coin-moebius-core')) as Record<string, unknown>;

		for (const [key, value] of Object.entries(core)) {
			expect(alias[key]).toBe(value);
		}
	});

	it('exposes createPaymentManager as a working function', async () => {
		const { createPaymentManager } = await import('../src/index.js');

		const manager = createPaymentManager({
			providers: [
				{
					id: 'noop',
					name: 'noop',
					initiate: () => undefined,
				},
			],
		});

		expect(typeof manager.initiate).toBe('function');
		expect(typeof manager.onSuccess).toBe('function');
		expect(typeof manager.onPending).toBe('function');
		expect(typeof manager.onError).toBe('function');
		expect(typeof manager.subscribeToStatus).toBe('function');
	});
});
