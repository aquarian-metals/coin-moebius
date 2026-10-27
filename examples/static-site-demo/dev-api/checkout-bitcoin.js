/**
 * `POST /api/checkout/bitcoin`: mint a fresh address from the node's
 * watch-only wallet and return the buyer-facing payment instructions.
 *
 * Required env:
 *   - `BITCOIN_RPC_URL` (e.g., `http://127.0.0.1:8332`), or
 *     `BITCOIN_REGTEST=true` for a regtest node on its default port
 *   - `BITCOIN_WALLET` (defaults to `shop`)
 *   - `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASSWORD` (the node's rpcuser and
 *     rpcpassword)
 */

import { createBitcoinCreator } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { getBitcoinRpcConfig, getStore } from './_shared.js';

/** The price is the server's to set. A buyer controls everything the browser sends. */
const PRODUCTS = {
	'jamstack-guide': { amount: 0.0002, currency: 'BTC' },
};

let creator = null;

function getCreator() {
	if (creator) return creator;
	const rpc = getBitcoinRpcConfig();
	if (!rpc) return null;

	creator = createBitcoinCreator({
		...rpc,
		store: getStore(),
		expiryMinutes: 15,
		btcPerUnit: async (currency) => {
			throw new Error(`No price configured for ${currency}`);
		},
	});
	return creator;
}

export async function handleBitcoinCheckout(req, res) {
	const create = getCreator();
	if (!create) {
		res.statusCode = 503;
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify({
				error:
					'Bitcoin is not configured. Set BITCOIN_REGTEST=true for a local regtest node, or BITCOIN_RPC_URL for any other node.',
			}),
		);
		return;
	}

	const body = await readJson(req);
	const productId = String(body.productId ?? '');
	const price = Object.hasOwn(PRODUCTS, productId) ? PRODUCTS[productId] : undefined;
	if (!price) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'Unknown product' }));
		return;
	}
	const result = await create({ productId, ...price, metadata: body.metadata ?? {} });

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	res.end(JSON.stringify(result));
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
}
