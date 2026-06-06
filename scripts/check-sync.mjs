#!/usr/bin/env node
/**
 * Version-sync guard. Asserts a single source of truth across three systems:
 *
 *   1. every PUBLIC workspace's package.json version (must all match), and
 *   2. the local git tag `v<version>` (must exist and point at HEAD), and
 *   3. the npm `latest` dist-tag for every public package.
 *
 * Exits non-zero with a diff table on any mismatch. This is the mechanism that
 * keeps npm and GitHub 100% in sync: `release.mjs` runs it as the final step,
 * and you can run it any time with `npm run check:sync`.
 *
 * Flags:
 *   --skip-npm   skip the registry comparison (offline / pre-publish check)
 *   --skip-git   skip the git-tag comparison
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const skipNpm = args.has('--skip-npm');
const skipGit = args.has('--skip-git');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sh = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();

// Collect public packages from the workspace list (mirrors bump-version.mjs).
const workspaces = read(resolve(root, 'package.json')).workspaces ?? [];
const publicPkgs = workspaces
	.map((w) => resolve(root, w, 'package.json'))
	.filter((p) => existsSync(p))
	.map((p) => read(p))
	.filter((j) => j.private !== true && j.name?.startsWith('@aquarian-metals/'))
	.map((j) => ({ name: j.name, version: j.version }));

if (publicPkgs.length === 0) {
	console.error('check-sync: no public packages found.');
	process.exit(1);
}

const problems = [];

// 1. Intra-repo uniformity: every public package shares one version.
const canonical = publicPkgs[0].version;
for (const p of publicPkgs) {
	if (p.version !== canonical) {
		problems.push(`package.json mismatch: ${p.name}@${p.version} (expected ${canonical})`);
	}
}
const expectedTag = `v${canonical}`;

// 2. Git tag exists and points at the current commit.
let gitState = 'skipped';
if (!skipGit) {
	const head = sh('git rev-parse HEAD');
	const tagExists = sh(`git tag -l ${expectedTag}`) === expectedTag;
	if (!tagExists) {
		gitState = 'MISSING';
		problems.push(`git tag ${expectedTag} does not exist`);
	} else {
		const tagCommit = sh(`git rev-list -n 1 ${expectedTag}`);
		gitState = tagCommit === head ? expectedTag : `${expectedTag} (off HEAD)`;
		if (tagCommit !== head) {
			problems.push(`git tag ${expectedTag} does not point at HEAD (${head.slice(0, 7)})`);
		}
	}
}

// 3. npm `latest` dist-tag matches, per package. Registry reads can lag a few
// seconds after publish, so retry a couple of times before declaring a miss.
const EXPECTED = canonical;
const npmVersion = (name) => {
	let last = null;
	// The `latest` dist-tag can take 20s+ to propagate to reads after a publish,
	// so poll until it matches the expected version (or we run out of patience)
	// rather than declaring drift on the first stale read.
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const v = execSync(`npm view ${name} version`, { encoding: 'utf8' }).trim();
			if (v) {
				last = v;
				if (v === EXPECTED) return v;
			}
		} catch {
			/* not published yet, or transient registry error */
		}
		if (attempt < 9) execSync('sleep 3');
	}
	return last;
};

const rows = [];
for (const p of publicPkgs) {
	const onNpm = skipNpm ? 'skipped' : (npmVersion(p.name) ?? 'absent');
	if (!skipNpm && onNpm !== canonical) {
		problems.push(`npm latest mismatch: ${p.name} is ${onNpm} (expected ${canonical})`);
	}
	rows.push({ pkg: p.name.replace('@aquarian-metals/', ''), local: p.version, npm: onNpm });
}

// Report.
const w = Math.max(...rows.map((r) => r.pkg.length), 8);
console.log(`\nVersion sync check  (canonical: ${canonical})`);
console.log(`git tag: ${gitState}\n`);
console.log(`${'package'.padEnd(w)}  ${'local'.padEnd(8)}  npm latest`);
console.log(`${'-'.repeat(w)}  ${'-'.repeat(8)}  ----------`);
for (const r of rows) {
	console.log(`${r.pkg.padEnd(w)}  ${r.local.padEnd(8)}  ${r.npm}`);
}

if (problems.length > 0) {
	console.error(`\n✗ OUT OF SYNC (${problems.length}):`);
	for (const m of problems) console.error(`  - ${m}`);
	process.exit(1);
}
console.log('\n✓ npm, git, and package.json are in sync.');
