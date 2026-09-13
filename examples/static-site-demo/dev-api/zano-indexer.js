/**
 * In-process Zano indexer ticker.
 *
 * Boots {@link createZanoIndexer} pointed at the same wallet RPC (mock or
 * real) the checkout uses, with the shared store. Runs continuously inside
 * the Vite dev server so a webhook fires the moment the indexer sees a
 * payment with enough confirmations.
 *
 * Demo settings are tuned for fast feedback (1s poll, 1 confirmation
 * required). Production deployments should leave these at their package
 * defaults (30s poll, 10 confirmations); see `docs/self-hosted-zano.md`.
 */

import { createZanoIndexer } from '@aquarian-metals/coin-moebius-zano/server';
import { getStore, getZanoHmacSecret, isZanoMockEnabled } from './_shared.js';
import { handleZanoWalletRpc, simulateBuyerPayment } from './mock-zano-wallet-rpc.js';

let indexer = null;
let stop = null;

function buildIndexer() {
	const hmacSecret = getZanoHmacSecret();
	const webhookUrl =
		process.env.ZANO_WEBHOOK_URL ?? 'http://localhost:5173/api/payment-webhook/zano';

	const fetcher = isZanoMockEnabled() ? makeMockFetcher() : globalThis.fetch.bind(globalThis);

	const walletRpcUrl = isZanoMockEnabled()
		? 'http://mock-zano-wallet-rpc'
		: (process.env.ZANO_WALLET_RPC_URL ?? '');
	if (!walletRpcUrl) return null;

	return createZanoIndexer({
		walletRpcUrl,
		jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
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
		if (target.includes('mock-zano-wallet-rpc')) {
			const body = JSON.parse(String(init?.body ?? '{}'));
			const result = await handleZanoWalletRpc(body.method, body.params ?? {});
			return new Response(JSON.stringify({ id: body.id ?? '0', jsonrpc: '2.0', result }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		return globalThis.fetch(url, init);
	};
}

export function ensureZanoIndexerRunning() {
	if (indexer) return;
	indexer = buildIndexer();
	if (!indexer) return;
	stop = indexer.start();
	process.once('SIGTERM', () => stop?.());
	process.once('SIGINT', () => stop?.());
}

/**
 * Dev-only handler: `POST /api/mock/pay-zano` with `{ paymentId }`.
 * Injects a transfer on the invoice's payment id, in the invoice's asset,
 * for the invoice amount, then ticks the indexer immediately so the
 * buyer-side UI observes the transition without waiting on the next poll.
 */
export async function handleZanoMockPay(req, res) {
	if (!isZanoMockEnabled()) {
		res.statusCode = 404;
		res.end('mock mode is disabled');
		return;
	}
	if (!indexer) ensureZanoIndexerRunning();

	const body = await readJson(req);
	const paymentId = String(body.paymentId ?? '');
	const record = await getStore().get(paymentId);
	if (!record) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'unknown paymentId' }));
		return;
	}

	simulateBuyerPayment({
		paymentReference: String(record.metadata.paymentReference),
		assetId: String(record.metadata.assetId),
		atomicAmount: String(record.metadata.atomicAmount),
	});
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
