// Exercise the consumer-facing modules from real npm tarballs in an isolated project.
// Run after the workspace build. Only the test runner and simulated DOM are shared.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'moebius-consumer-'));
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const modules = join(temp, 'node_modules');
try {
	const tarballs = [];
	const entries = [];
	writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
	for (const ws of json(join(root, 'package.json')).workspaces) {
		const dir = join(root, ws);
		const pkg = json(join(dir, 'package.json'));
		if (!ws.startsWith('packages/') || pkg.private) continue;
		const [packed] = JSON.parse(
			execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
				cwd: dir,
				encoding: 'utf8',
			}),
		);
		tarballs.push(join(temp, packed.filename));
		for (const key of Object.keys(pkg.exports)) {
			if (key !== './package.json') entries.push(key === '.' ? pkg.name : pkg.name + key.slice(1));
		}
		const testDir = join(temp, ws, 'test');
		mkdirSync(testDir, { recursive: true });
		const files = readdirSync(join(dir, 'test')).filter((f) => f.endsWith('.test.ts'));
		assert.ok(files.length, 'Missing consumer tests for ' + pkg.name);
		for (const file of files) {
			const source = readFileSync(join(dir, 'test', file), 'utf8');
			const consumer = source.replace(/(['"])\.\.\/src\/(\w+)(?:\.js)?\1/g, (_, quote, entry) => {
				const subpath = entry === 'types' || entry === 'index' ? '' : '/' + entry;
				return quote + pkg.name + subpath + quote;
			});
			writeFileSync(join(testDir, file), consumer);
		}
	}
	const lock = json(join(root, 'package-lock.json')).packages;
	execFileSync(
		'npm',
		[
			'install',
			'--no-audit',
			'--no-fund',
			'--ignore-scripts',
			...tarballs,
			lock['node_modules/stripe'].resolved,
			lock['node_modules/@bitauth/libauth'].resolved,
		],
		{ cwd: temp, stdio: 'inherit' },
	);
	for (const name of ['vitest', 'happy-dom'])
		symlinkSync(resolve(root, 'node_modules', name), join(modules, name), 'dir');
	writeFileSync(
		join(temp, 'vitest.config.mjs'),
		'export default {test: {clearMocks: true, restoreMocks: true}};',
	);
	const probe = entries.map((entry) => 'await import(' + JSON.stringify(entry) + ');').join('\n');
	writeFileSync(join(temp, 'imports.mjs'), probe);
	execFileSync(process.execPath, ['imports.mjs'], { cwd: temp, stdio: 'inherit' });
	console.log(
		'Loaded ' + entries.length + ' entry points from ' + tarballs.length + ' installed packages.',
	);
	execFileSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run'], {
		cwd: temp,
		stdio: 'inherit',
	});
} finally {
	rmSync(temp, { recursive: true, force: true });
}
