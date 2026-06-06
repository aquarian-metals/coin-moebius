#!/usr/bin/env node
/**
 * Set every PUBLIC package to a target version and update internal dependency
 * ranges to match. This is the canonical bumper, called by scripts/release.mjs;
 * it can also be run directly via `npm run bump <version>`. Keeps all public
 * packages on a single locked version (fixed versioning) so "the version" is
 * unambiguous across npm and git.
 *
 * Usage:  node scripts/bump-version.mjs <version>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.argv[2];
if (!TARGET || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(TARGET)) {
	console.error(`Usage: node scripts/bump-version.mjs <version>   (got: ${TARGET ?? '<none>'})`);
	process.exit(1);
}

const workspaces = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).workspaces;
const pkgPaths = workspaces
	.map((w) => resolve(root, w, 'package.json'))
	.filter((p) => existsSync(p));

// Bump set: public packages under packages/ (excludes private element, the
// private examples demo, and the private root).
const bumpNames = new Set();
for (const p of pkgPaths) {
	const j = JSON.parse(readFileSync(p, 'utf8'));
	if (j.private === true) continue;
	if (!p.includes(`${root}/packages/`)) continue;
	bumpNames.add(j.name);
}

const DEP_FIELDS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'];
let changed = 0;
for (const p of pkgPaths) {
	const j = JSON.parse(readFileSync(p, 'utf8'));
	let touched = false;

	if (bumpNames.has(j.name) && j.version !== TARGET) {
		j.version = TARGET;
		touched = true;
	}

	for (const field of DEP_FIELDS) {
		const deps = j[field];
		if (!deps) continue;
		for (const [name, range] of Object.entries(deps)) {
			if (!bumpNames.has(name)) continue; // don't touch deps on private pkgs (e.g. element "*")
			const op = range.startsWith('^') ? '^' : range.startsWith('~') ? '~' : '';
			const next = `${op}${TARGET}`;
			if (deps[name] !== next) {
				deps[name] = next;
				touched = true;
			}
		}
	}

	if (touched) {
		writeFileSync(p, JSON.stringify(j, null, '\t') + '\n');
		changed++;
		console.log(`  ${j.name} → ${bumpNames.has(j.name) ? TARGET : '(deps only)'}`);
	}
}
console.log(
	`✓ set ${bumpNames.size} public package(s) to ${TARGET}; rewrote ${changed} package.json file(s)`,
);
