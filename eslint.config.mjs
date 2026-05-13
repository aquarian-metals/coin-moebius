// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * SDK-wide ESLint flat config.
 *
 * Per-package overrides go in additional config blocks below (or in
 * package-local eslint.config.mjs files that extend this one). The
 * project uses tab indentation; Prettier handles the formatting layer.
 */
export default tseslint.config(
	{
		ignores: [
			'**/dist/',
			'**/dist-cdn/',
			'**/node_modules/',
			'**/coverage/',
			'docs/api/',
			'package-lock.json',
		],
	},
	js.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			globals: {
				...globals.node,
				...globals.browser,
			},
			parserOptions: {
				project: './tsconfig.eslint.json',
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Type safety: no `any`, no unsafe operations.
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unsafe-assignment': 'error',
			'@typescript-eslint/no-unsafe-member-access': 'error',
			'@typescript-eslint/no-unsafe-call': 'error',
			'@typescript-eslint/no-unsafe-return': 'error',
			'@typescript-eslint/no-unsafe-argument': 'error',

			// Unused code: error, allow underscore-prefixed for intentional unused.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],

			// Import hygiene.
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ prefer: 'type-imports', fixStyle: 'separate-type-imports' },
			],

			// Behavioral correctness.
			eqeqeq: ['error', 'always'],
			'prefer-const': 'error',
			'no-var': 'error',

			// Console: warn, allow warn/error (info/log are noise in libraries).
			'no-console': ['warn', { allow: ['warn', 'error'] }],
		},
	},
	// Test files: relax the unsafe-* rules and a few idiomatic-for-tests patterns.
	// Mocks, fire-and-forget promises (vi awaits via fake timers), and async-without-await
	// (async mocks matching async type signatures) are part of the testing toolkit.
	{
		files: ['**/test/**/*.ts', '**/*.test.ts'],
		rules: {
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
			'@typescript-eslint/require-await': 'off',
			'@typescript-eslint/array-type': 'off',
		},
	},
	// Example apps: aspirational integration code, not library. Looser rules —
	// `console.log` for demos, no-unsafe-* for env-var bridges, no-floating-promises
	// because UI handlers are inherently fire-and-forget.
	{
		files: ['examples/**/*.{ts,tsx,js,mjs}'],
		rules: {
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
			'no-console': 'off',
		},
	},
	// Build/utility scripts: console.log is the legitimate output channel.
	{
		files: ['scripts/**/*.{js,mjs,ts}'],
		rules: {
			'no-console': 'off',
		},
	},
	// JS/MJS/CJS files (configs, scripts): no type-checked rules.
	{
		files: ['**/*.{js,mjs,cjs}'],
		...tseslint.configs.disableTypeChecked,
	},
);
