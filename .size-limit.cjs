/**
 * Bundle-size budgets for the publishable client-side SDK packages.
 *
 * These limits guard against accidental regressions — a stray dependency
 * import or a tree-shaking-defeating pattern shows up here before users
 * notice. Initial values are intentionally generous; ratchet down as we
 * measure actual sizes during Phase 2 hardening.
 *
 * Server-side entries (the `server` package, plus each provider's `/server`
 * subpath export) are not size-budgeted — they run in Node where bundle
 * size doesn't matter the way it does for the browser SDK.
 */
module.exports = [
	{
		name: 'coin-moebius (main re-export)',
		path: 'packages/coin-moebius/dist/index.js',
		limit: '2 KB',
	},
	{
		name: 'coin-moebius-core',
		path: 'packages/core/dist/index.js',
		limit: '5 KB',
	},
	{
		name: 'coin-moebius-stripe (client)',
		path: 'packages/providers/stripe/dist/index.js',
		limit: '5 KB',
		ignore: ['@stripe/stripe-js'],
	},
	{
		name: 'coin-moebius-cryptomus (client)',
		path: 'packages/providers/cryptomus/dist/index.js',
		limit: '3 KB',
	},
	{
		name: 'coin-moebius-nowpayments (client)',
		path: 'packages/providers/nowpayments/dist/index.js',
		limit: '3 KB',
	},
	{
		name: 'coin-moebius-manual (client)',
		path: 'packages/providers/manual/dist/index.js',
		limit: '6 KB',
	},
	{
		name: 'coin-moebius-element (custom element + styles)',
		path: 'packages/element/dist/index.js',
		limit: '8 KB',
	},
];
