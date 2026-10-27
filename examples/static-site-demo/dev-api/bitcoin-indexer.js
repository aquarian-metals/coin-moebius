/**
 * In-process Bitcoin indexer ticker.
 *
 * Boots {@link createBitcoinIndexer} pointed at the same node the checkout
 * uses, with the shared store. Runs continuously inside the Vite dev server
 * so a webhook fires the moment the indexer sees a payment.
 *
 * Demo settings are tuned for fast feedback (1s poll). Production
 * deployments should leave the poll at its package default (30s); see
 * `docs/self-hosted-bitcoin.md`.
 */

import { createBitcoinIndexer } from '@aquarian-metals/coin-moebius-bitcoin/server';
import {
	getBitcoinHmacSecret,
	getBitcoinRpcConfig,
	getStore,
	isBitcoinRegtestEnabled,
} from './_shared.js';

let indexer = null;
let stop = null;

function buildIndexer() {
	const rpc = getBitcoinRpcConfig();
	if (!rpc) return null;

	return createBitcoinIndexer({
		...rpc,
		store: getStore(),
		webhookUrl:
			process.env.BITCOIN_WEBHOOK_URL ?? 'http://localhost:5173/api/payment-webhook/bitcoin',
		hmacSecret: getBitcoinHmacSecret(),
		requiredConfirmations: 1,
		pollIntervalMs: 1000,
	});
}

export function ensureBitcoinIndexerRunning() {
	if (indexer) return;
	indexer = buildIndexer();
	if (!indexer) return;
	stop = indexer.start();
	process.once('SIGTERM', () => stop?.());
	process.once('SIGINT', () => stop?.());
}

/**
 * Dev-only handler: `POST /api/regtest/pay-bitcoin` with `{ paymentId }`.
 * Pays the invoice for real from the regtest wallet named by
 * `BITCOIN_BUYER_WALLET` (defaults to `buyer`), mines one block so the
 * payment confirms, then ticks the indexer immediately so the buyer-side UI
 * observes the transition without waiting on the next poll.
 */
export async function handleBitcoinRegtestPay(req, res) {
	if (!isBitcoinRegtestEnabled()) {
		res.statusCode = 404;
		res.end('regtest mode is disabled');
		return;
	}
	if (!indexer) ensureBitcoinIndexerRunning();

	const body = await readJson(req);
	const paymentId = String(body.paymentId ?? '');
	const record = await getStore().get(paymentId);
	if (!record) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'unknown paymentId' }));
		return;
	}

	const buyer = process.env.BITCOIN_BUYER_WALLET ?? 'buyer';
	const chain = await buyerRpc(buyer, 'getblockchaininfo', {});
	if (chain.chain !== 'regtest') {
		res.statusCode = 409;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: `node is on ${chain.chain}, not regtest; refusing to spend` }));
		return;
	}
	await buyerRpc(buyer, 'sendtoaddress', {
		address: String(record.metadata.address),
		amount: Number(record.metadata.btcAmount),
	});
	const minerAddress = await buyerRpc(buyer, 'getnewaddress', {});
	await buyerRpc(buyer, 'generatetoaddress', { nblocks: 1, address: minerAddress });
	await indexer.tick();

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	res.end(JSON.stringify({ ok: true }));
}

async function buyerRpc(wallet, method, params) {
	const rpc = getBitcoinRpcConfig();
	const headers = { 'Content-Type': 'application/json' };
	if (rpc.rpcUser !== undefined) {
		const credentials = `${rpc.rpcUser}:${rpc.rpcPassword ?? ''}`;
		headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
	}
	const response = await fetch(`${rpc.rpcUrl.replace(/\/+$/, '')}/wallet/${wallet}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
	});
	const reply = await response.json();
	if (reply.error) throw new Error(`regtest ${method}: ${reply.error.message}`);
	return reply.result;
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
}
