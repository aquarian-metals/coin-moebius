// Run the same built storefront scenarios with a simulated DOM or Playwright.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInContext } from 'node:vm';
import { setTimeout as wait } from 'node:timers/promises';
import { Window } from 'happy-dom';
const dist = new URL('../examples/static-site-demo/dist/', import.meta.url);
const assets = new URL('assets/', dist);
const files = readdirSync(assets).filter((name) => name.endsWith('.js'));
assert.equal(files.length, 1);
const bundle = readFileSync(new URL(files[0], assets), 'utf8');
const html = readFileSync(new URL('index.html', dist), 'utf8').replace(
	/<script\b[^>]*src=[^>]*><\/script>/g,
	'',
);
const origin = 'https://merchant.invalid';
const id = 'fixture-order';
const cases = [
	['Pending, unrelated order, paid', ['pending', 'other', 'success'], true],
	['Interrupted poll, partial, paid', ['offline', 'partial', 'success'], true],
	['Delayed failure', ['pending', 'failed'], false],
	['Refunded order', ['refunded'], false],
	['Disputed order', ['disputed'], false],
];
async function simulated(respond) {
	const w = new Window({ url: origin });
	w.document.write(html);
	w.fetch = async (url) =>
		Response.json(respond(new URL(url, origin).pathname + new URL(url, origin).search));
	runInContext(bundle, w);
	return {
		click: () => w.document.querySelector('#cryptomus-tile').click(),
		text: () => w.document.querySelector('#status').textContent,
		literal: () => !w.document.querySelector('#status counter'),
		close: () => w.happyDOM.close(),
	};
}
async function chromiumPage(browser, respond) {
	const page = await browser.newPage();
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (url.origin !== origin) return route.abort();
		if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
		try {
			await route.fulfill({ json: respond(url.pathname + url.search) });
		} catch {
			await route.abort();
		}
	});
	await page.goto(origin);
	await page.addScriptTag({ content: bundle });
	return {
		click: () => page.locator('#cryptomus-tile').click(),
		text: () => page.locator('#status').innerText(),
		literal: () =>
			page
				.locator('#status counter')
				.count()
				.then((n) => n === 0),
		close: () => page.close(),
	};
}
let browser;
if (process.argv.includes('--playwright')) {
	const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON ?? import.meta.url);
	browser = await require('playwright').chromium.launch();
}
try {
	for (const [name, sequence, granted] of cases) {
		let polls = 0;
		const respond = (url) => {
			if (url === '/api/checkout/cryptomus') return { uuid: id, address: 'Store <counter> 12' };
			assert.equal(url, '/api/payment-status?paymentId=' + id);
			const state = sequence[polls++];
			assert.ok(state);
			if (state === 'offline') throw new Error('Simulated connection loss');
			return {
				paymentId: state === 'other' ? 'another-order' : id,
				status: state === 'other' ? 'success' : state,
				metadata: {},
				provider: 'cryptomus',
				currency: 'USD',
				amount: 19.99,
			};
		};
		const ui = browser ? await chromiumPage(browser, respond) : await simulated(respond);
		try {
			await ui.click();
			const deadline = Date.now() + 12000;
			while (!(await ui.text()).includes('Store <counter> 12') && Date.now() < deadline)
				await wait(20);
			assert.ok((await ui.text()).includes('Store <counter> 12'));
			assert.ok(await ui.literal());
			while (polls < sequence.length && Date.now() < deadline) {
				const visible = await ui.text();
				if (polls < sequence.length) assert.ok(!visible.includes('Download your guide'));
				await wait(30);
			}
			const expected = granted ? 'Download your guide' : 'Payment did not complete.';
			while (!(await ui.text()).includes(expected) && Date.now() < deadline) await wait(20);
			assert.equal(polls, sequence.length);
			assert.ok((await ui.text()).includes(expected));
			console.log('PASS ' + name);
		} finally {
			await ui.close();
		}
	}
} finally {
	await browser?.close();
}
