import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, '../..');

export default defineConfig({
	root: demoRoot,
	server: {
		port: 5173,
	},
	resolve: {
		alias: {
			'@aquarian-metals/coin-moebius': path.join(
				repoRoot,
				'packages/coin-moebius/src/index.ts'
			),
			'@aquarian-metals/coin-moebius-core': path.join(
				repoRoot,
				'packages/core/src/index.ts'
			),
			'@aquarian-metals/coin-moebius-monero-cryptomus': path.join(
				repoRoot,
				'packages/providers/monero-cryptomus/src/index.ts'
			),
			'@aquarian-metals/coin-moebius-stripe': path.join(
				repoRoot,
				'packages/providers/stripe/src/index.ts'
			),
		},
	},
});
