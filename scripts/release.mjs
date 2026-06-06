#!/usr/bin/env node
/**
 * The ONE release path. Keeps npm and GitHub byte-for-byte in sync on version.
 *
 * Order is deliberate: npm publishes BEFORE git pushes. npm is the unforgiving
 * system (versions can never be unpublished or reused), git is malleable. So we
 * make the irreversible commitment first; once npm has the version, the git
 * push is a near-certain follow-up. If anything before the push fails, GitHub
 * was never touched and you simply re-run (every step is idempotent).
 *
 * Usage:
 *   node scripts/release.mjs <version>     e.g. node scripts/release.mjs 4.0.0
 *   npm run release 4.0.0
 *
 * Pre-req: non-interactive npm auth (automation token in ~/.npmrc) and a clean
 * working tree on `main`. There is no CI publisher; this script is authoritative.
 */
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const cap = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8' }).trim();
const die = (msg) => {
	console.error(`\n✗ ${msg}`);
	process.exit(1);
};

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
	die(`Usage: node scripts/release.mjs <version>   (got: ${version ?? '<none>'})`);
}
const tag = `v${version}`;

console.log(`\n=== Releasing ${tag} ===\n`);

// 1. Preflight. Bail before any change if the environment is not release-ready.
const branch = cap('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') die(`Must release from main (currently on ${branch}).`);
if (cap('git status --porcelain')) die('Working tree is not clean. Commit or stash first.');
try {
	cap('npm whoami');
} catch {
	die('Not authenticated to npm (need an automation token in ~/.npmrc).');
}
const mainPkg = '@aquarian-metals/coin-moebius';
let alreadyPublished = '';
try {
	alreadyPublished = cap(`npm view ${mainPkg}@${version} version`);
} catch {
	/* not published — good */
}
if (alreadyPublished) {
	die(`${mainPkg}@${version} already exists on npm. npm version numbers can never be reused.`);
}

// 2. Bump every public package to the target version + rewrite internal ranges.
console.log('→ bumping versions');
run(`node scripts/bump-version.mjs ${version}`);
run('npm install --package-lock-only --silent');

// 3. Full verification (build, lint, types, tests, types-wrong, size budgets).
console.log('\n→ verifying');
run('npm run verify');

// 4. THE GATE: publish to npm first (idempotent — re-running skips published).
console.log('\n→ publishing to npm');
run('bash scripts/publish-all.sh');

// 5. npm is committed. Now record the same version in git and push.
console.log('\n→ committing + tagging + pushing git');
// --no-verify: `npm run verify` already ran above as the release gate. Skipping
// the husky pre-commit/pre-push re-run avoids redundant work and, critically,
// avoids a hook failure AFTER npm has already published (which would desync).
run('git add -A');
run(`git commit --no-verify -m "${tag}"`);
run(`git tag ${tag}`);
run('git push --no-verify origin main --follow-tags');

// 6. Prove all three systems agree.
console.log('\n→ verifying sync');
run('node scripts/check-sync.mjs');

console.log(`\n✓ Released ${tag}: npm and GitHub are in sync.`);
