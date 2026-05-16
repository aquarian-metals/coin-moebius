import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import devApiPlugin from './vite-plugin-dev-api.js';

const demoRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoRoot, '../..');

export default defineConfig({
	root: demoRoot,
	server: {
		port: 5173,
	},
	plugins: [devApiPlugin()],
	resolve: {
		alias: {
			'@aquarian-metals/coin-moebius': path.join(repoRoot, 'packages/coin-moebius/src/index.ts'),
			'@aquarian-metals/coin-moebius-core': path.join(repoRoot, 'packages/core/src/index.ts'),
			'@aquarian-metals/coin-moebius-cryptomus': path.join(
				repoRoot,
				'packages/providers/cryptomus/src/index.ts',
			),
			'@aquarian-metals/coin-moebius-monero': path.join(
				repoRoot,
				'packages/providers/monero/src/index.ts',
			),
			'@aquarian-metals/coin-moebius-stripe': path.join(
				repoRoot,
				'packages/providers/stripe/src/index.ts',
			),
		},
	},
});
