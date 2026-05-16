#!/usr/bin/env node
/**
 * Build the `sdk.global.js` bundle for `<script>`-tag CDN consumers.
 *
 * Outputs to TWO locations, identical content:
 *
 *   1. coin-moebius/dist-cdn/        — picked up by the release workflow and
 *                                      uploaded to cdn.coinmoebius.com/v1/.
 *   2. packages/element/dist/        — shipped inside the npm package so the
 *                                      published bundle is also reachable
 *                                      via jsDelivr / unpkg:
 *                                        https://cdn.jsdelivr.net/npm/
 *                                          @aquarian-metals/coin-moebius-element@1/
 *                                          dist/sdk.global.js
 *                                      Gives merchants a free fallback CDN
 *                                      if cdn.coinmoebius.com is ever down.
 *
 * Files written to each location:
 *   sdk.global.js     — full bundle: registers <coin-moebius-buy> and
 *                       exposes CoinMoebius.* on window.
 *   sdk.global.js.map — source map
 *   sdk.element.js    — element-only build (smaller).
 *   sdk.element.js.map
 *
 * The bundles are IIFE (Immediately Invoked Function Expression) format —
 * no module loader required. Drop into a `<script src="…">` and it works.
 *
 * Versioning happens at the CDN layer: cdn.coinmoebius.com/v1/sdk.global.js
 * (immutable for the v1 major) and cdn.coinmoebius.com/latest/sdk.global.js
 * (short-cached). jsDelivr automatically serves the same files at semver
 * paths once the npm package is published.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'dist-cdn');
const elementDistDir = resolve(root, 'packages/element/dist');
mkdirSync(outDir, { recursive: true });
mkdirSync(elementDistDir, { recursive: true });

const elementPkgPath = resolve(root, 'packages/element/package.json');
const elementPkg = JSON.parse(readFileSync(elementPkgPath, 'utf8'));
const version = elementPkg.version;
const banner = `/*! Coin Moebius SDK v${version} — https://coinmoebius.com — MIT */`;

// Build the global "everything" bundle. Importing the package's main entry
// triggers `customElements.define('coin-moebius-buy', ...)` automatically.
//
// `globalName` exposes the named exports on `window.CoinMoebius`, so consumers
// who want the class without auto-registration (e.g., for renaming) can still
// reach it.
await esbuild.build({
	entryPoints: [resolve(root, 'packages/element/src/index.ts')],
	bundle: true,
	format: 'iife',
	globalName: 'CoinMoebius',
	target: 'es2022',
	outfile: resolve(outDir, 'sdk.global.js'),
	minify: true,
	sourcemap: true,
	banner: { js: banner },
	legalComments: 'inline',
});

// Element-only bundle. Same source for now (the element package is the only
// browser-side surface), but reserved as a separate URL so we can split it
// later if we add more browser modules.
await esbuild.build({
	entryPoints: [resolve(root, 'packages/element/src/index.ts')],
	bundle: true,
	format: 'iife',
	target: 'es2022',
	outfile: resolve(outDir, 'sdk.element.js'),
	minify: true,
	sourcemap: true,
	banner: { js: banner },
	legalComments: 'inline',
});

// Drop a small manifest so the CDN upload step knows the version it just built
// without having to re-parse a package.json.
writeFileSync(
	resolve(outDir, 'manifest.json'),
	JSON.stringify(
		{
			version,
			builtAt: new Date().toISOString(),
			gitSha: safeGit('rev-parse HEAD'),
			files: ['sdk.global.js', 'sdk.element.js'],
		},
		null,
		2,
	),
);

// Mirror the bundles into the element package's dist/ so they ship with
// `npm publish`. This is what makes the jsDelivr / unpkg backup CDN work —
// once the npm package is published, the same bundles become reachable at
// cdn.jsdelivr.net/npm/@aquarian-metals/coin-moebius-element@1/dist/sdk.global.js
// without any extra publishing step.
for (const f of ['sdk.global.js', 'sdk.global.js.map', 'sdk.element.js', 'sdk.element.js.map']) {
	copyFileSync(resolve(outDir, f), resolve(elementDistDir, f));
}

console.log(`✓ CDN bundle v${version} written to ${outDir} and mirrored into ${elementDistDir}`);

function safeGit(args) {
	try {
		return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim();
	} catch {
		return null;
	}
}
