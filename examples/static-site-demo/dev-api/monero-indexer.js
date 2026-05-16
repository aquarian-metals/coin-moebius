/**
 * In-process Monero indexer ticker.
 *
 * Boots {@link createMoneroIndexer} pointed at the same wallet RPC (mock
 * or real) the checkout uses, with the shared store. Runs continuously
 * inside the Vite dev server so a webhook fires the moment the indexer
 * sees an incoming transfer with enough confirmations.
 *
 * Demo settings are tuned for fast feedback (1s poll, 1 confirmation
 * required). Production deployments should leave these at their package
 * defaults (30s poll, 10 confirmations) — see `packages/providers/monero/README.md`.
 */

import { createMoneroIndexer } from '@aquarian-metals/coin-moebius-monero/server';
import { getMoneroHmacSecret, getStore, isMoneroMockEnabled } from './_shared.js';
import { handleWalletRpc, simulateBuyerPayment } from './mock-wallet-rpc.js';

let indexer = null;
let stop = null;

function buildIndexer() {
	const hmacSecret = getMoneroHmacSecret();
	const webhookUrl = process.env.MONERO_WEBHOOK_URL ?? 'http://localhost:5173/api/payment-webhook';

	const fetcher = isMoneroMockEnabled() ? makeMockFetcher() : globalThis.fetch.bind(globalThis);

	const walletRpcUrl = isMoneroMockEnabled()
		? 'http://mock-wallet-rpc/json_rpc'
		: (process.env.MONERO_WALLET_RPC_URL ?? '');
	if (!walletRpcUrl) return null;

	return createMoneroIndexer({
		walletRpcUrl,
		store: getStore(),
		webhookUrl,
		hmacSecret,
		requiredConfirmations: 1,
		pollIntervalMs: 1000,
		fetcher,
	});
}

function makeMockFetcher() {
	return async function mockFetch(url, init) {
		const target = String(url);
		if (target.includes('mock-wallet-rpc')) {
			const body = JSON.parse(String(init?.body ?? '{}'));
			const result = await handleWalletRpc(body.method, body.params ?? {});
			return new Response(JSON.stringify({ id: body.id ?? '0', jsonrpc: '2.0', result }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return globalThis.fetch(url, init);
	};
}

export function ensureIndexerRunning() {
	if (indexer) return;
	indexer = buildIndexer();
	if (!indexer) return;
	stop = indexer.start();
	process.once('SIGTERM', () => stop?.());
	process.once('SIGINT', () => stop?.());
}

/**
 * Dev-only handler: `POST /api/mock/pay-monero` with `{ paymentId }`.
 * Injects a transfer into the mock wallet RPC equal to the invoice amount,
 * then triggers the indexer to tick immediately so the buyer-side UI
 * observes the transition without waiting on the next poll.
 */
export async function handleMockPay(req, res) {
	if (!isMoneroMockEnabled()) {
		res.statusCode = 404;
		res.end('mock mode is disabled');
		return;
	}
	if (!indexer) ensureIndexerRunning();

	const body = await readJson(req);
	const paymentId = String(body.paymentId ?? '');
	const record = await getStore().get(paymentId);
	if (!record) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'unknown paymentId' }));
		return;
	}

	const addressIndex = Number(record.metadata.addressIndex);
	const accountIndex = Number(record.metadata.accountIndex ?? 0);
	const atomicAmount = String(record.metadata.atomicAmount);

	simulateBuyerPayment({ addressIndex, accountIndex, atomicAmount });
	await indexer.tick();

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	res.end(JSON.stringify({ ok: true }));
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
}
