import { createBitcoinCashIndexer } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import {
	getBitcoinCashConfig,
	getBitcoinCashHmacSecret,
	getStore,
	isBitcoinCashRegtestEnabled,
} from './_shared.js';

let indexer = null;
let stop = null;

function buildIndexer() {
	const config = getBitcoinCashConfig();
	if (!config) return null;

	return createBitcoinCashIndexer({
		rpcUrl: config.rpcUrl,
		wallet: config.wallet,
		rpcUser: config.rpcUser,
		rpcPassword: config.rpcPassword,
		store: getStore(),
		webhookUrl:
			process.env.BCH_WEBHOOK_URL ?? 'http://localhost:5173/api/payment-webhook/bitcoin-cash',
		hmacSecret: getBitcoinCashHmacSecret(),
		requiredConfirmations: 6,
		pollIntervalMs: 1000,
	});
}

export function ensureBitcoinCashIndexerRunning() {
	if (indexer) return;
	indexer = buildIndexer();
	if (!indexer) return;
	stop = indexer.start();
	process.once('SIGTERM', () => stop?.());
	process.once('SIGINT', () => stop?.());
}

export async function handleBitcoinCashRegtestPay(req, res) {
	if (!isBitcoinCashRegtestEnabled()) {
		res.statusCode = 404;
		res.end('regtest mode is disabled');
		return;
	}
	if (!indexer) ensureBitcoinCashIndexerRunning();

	const body = await readJson(req);
	const paymentId = String(body.paymentId ?? '');
	const record = await getStore().get(paymentId);
	if (!record) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'unknown paymentId' }));
		return;
	}

	const buyer = process.env.BCH_BUYER_WALLET ?? 'buyer';
	const chain = await buyerRpc(buyer, 'getblockchaininfo', {});
	if (chain.chain !== 'regtest') {
		res.statusCode = 409;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: `node is on ${chain.chain}, not regtest; refusing to spend` }));
		return;
	}
	await buyerRpc(buyer, 'sendtoaddress', {
		address: String(record.metadata.address),
		amount: Number(record.metadata.bchAmount),
	});
	await indexer.tick();
	const minerAddress = await buyerRpc(buyer, 'getnewaddress', {});
	await buyerRpc(buyer, 'generatetoaddress', { nblocks: 6, address: minerAddress });
	await indexer.tick();

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	res.end(JSON.stringify({ ok: true }));
}

async function buyerRpc(wallet, method, params) {
	const config = getBitcoinCashConfig();
	const headers = { 'Content-Type': 'application/json' };
	if (config.rpcUser !== undefined) {
		const credentials = `${config.rpcUser}:${config.rpcPassword ?? ''}`;
		headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
	}
	const response = await fetch(`${config.rpcUrl.replace(/\/+$/, '')}/wallet/${wallet}`, {
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
