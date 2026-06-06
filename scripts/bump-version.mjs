#!/usr/bin/env node
/**
 * One-off release helper: set every PUBLIC package to a target version and
 * update internal dependency ranges to match. Used instead of `changeset
 * version` for the v3 release because the fixed-group changesets resolve to a
 * version that already exists on npm. Delete after the release settles.
 *
 * Usage:  node scripts/bump-version.mjs <version>   (default 3.0.0)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = process.argv[2] || '3.0.0';

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
