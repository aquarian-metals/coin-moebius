#!/usr/bin/env node
/**
 * Run `@arethetypeswrong/cli` against every publishable package in this
 * monorepo. Catches dual-export breakage, missing type entries, and the
 * other ways TypeScript package exports can subtly go wrong.
 *
 * Run after `npm run build`. CI invokes this via `npm run attw`.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// fileURLToPath (not URL.pathname) so a checkout path containing spaces — which
// pathname would percent-encode into a non-existent directory, breaking the
// execSync cwd below — resolves to the real filesystem path. Matches
// scripts/bump-version.mjs and scripts/release.mjs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const workspaces = rootPkg.workspaces
	.filter((p) => p.startsWith('packages/'))
	// Exclude the provider-template package — it's a starter copy, never published.
	.filter((p) => !p.endsWith('/template'))
	// Exclude the buy package — it ships prebuilt `<script>` bundles only, no
	// types, so there's nothing for attw to resolve.
	.filter((p) => p !== 'packages/buy');

// The SDK packages are intentionally ESM-only — they target modern Node 18+,
// browsers, and bundlers. Two attw rules fire on legitimate ESM-only design
// choices and are explicitly ignored:
//   - `no-resolution`: Node 10's pre-`exports` resolution can't find the
//     `/server` subpath. We don't support Node 10.
//   - `cjs-resolves-to-esm`: CommonJS consumers need dynamic `import()` to
//     load an ESM module. Expected; documented as ESM-only in our README.
// If we ever decide to ship dual ESM/CJS builds (a Phase 6 stretch
// consideration), drop these from the ignore list.
const IGNORE_RULES = ['no-resolution', 'cjs-resolves-to-esm'];

let hadFailure = false;
for (const ws of workspaces) {
	console.log(`\n=== ${ws} ===`);
	try {
		execSync(`npx attw --pack --ignore-rules ${IGNORE_RULES.join(' ')}`, {
			cwd: resolve(root, ws),
			stdio: 'inherit',
		});
	} catch (err) {
		hadFailure = true;
		console.error(`attw failed for ${ws}: ${err.message}`);
	}
}

if (hadFailure) {
	process.exit(1);
}
