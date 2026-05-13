import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['packages/**/test/**/*.test.ts'],
		exclude: ['**/node_modules/**', '**/dist/**'],
		// Default to Node environment. DOM-touching tests (manual provider's
		// modal, future Stripe client tests) opt in via a per-file pragma:
		//   // @vitest-environment happy-dom
		environment: 'node',
		globals: false,
		clearMocks: true,
		restoreMocks: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'json-summary', 'html'],
			include: ['packages/**/src/**/*.ts'],
			exclude: [
				'packages/**/dist/**',
				'packages/**/test/**',
				// Pure type files have no runtime to cover.
				'packages/core/src/types.ts',
				'packages/server/src/types.ts',
				// Template is a copy-and-rename starter; not tested directly.
				'packages/providers/template/**',
				// Side-effect-only auto-registration entry. Tests import
				// `element-class` directly so this file's
				// `customElements.define` line never runs — and there's
				// nothing to assert against if it did.
				'packages/element/src/index.ts',
				// Same shape — NOWPayments client provider's `onError`
				// callback wrapper path is best-tested through the
				// integration tests in coin-moebius-cloud/worker, not via
				// the SDK's unit tests. Excluding to keep the threshold
				// honest until we add a dedicated unit test.
			],
			thresholds: {
				statements: 90,
				branches: 85,
				functions: 95,
				lines: 90,
			},
		},
	},
});
