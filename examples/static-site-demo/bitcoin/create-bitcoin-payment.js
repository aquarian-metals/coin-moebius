/**
 * /api/checkout/bitcoin: receives the browser's checkout POST, asks your
 * Bitcoin Core wallet for a fresh address, persists a pending record to
 * your payment store, and returns the buyer instructions.
 *
 * The price comes from your own product list, never from the request. The
 * browser is the buyer's computer, and a buyer can send any amount they
 * like; trusting it would sell the product for one satoshi.
 *
 * This handler needs network access to the node's RPC. If your serverless
 * functions can't reach a private node, deploy this file as a tiny
 * Express/Hono server on the same VPS as the node instead, and have the
 * browser POST there.
 */
import { createBitcoinCreator } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myStore } from './_store.js';

// Replace with your real catalog: a database, a CMS, a JSON file.
const PRODUCTS = {
	'jamstack-guide': { amount: 0.0002, currency: 'BTC' },
};

const create = createBitcoinCreator({
	rpcUrl: process.env.BITCOIN_RPC_URL,
	wallet: process.env.BITCOIN_WALLET,
	rpcUser: process.env.BITCOIN_RPC_USER,
	rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
	store: myStore,
	expiryMinutes: 15,
	btcPerUnit: async (currency) => {
		// Replace with your price feed of choice: CoinGecko, an exchange
		// ticker, a pinned constant. Coin Moebius calls no oracle.
		throw new Error(`No price configured for ${currency}`);
	},
});

export default async (req) => {
	if (req.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	try {
		const { productId, metadata } = await req.json();
		const product = Object.hasOwn(PRODUCTS, productId) ? PRODUCTS[productId] : undefined;
		if (!product) {
			return new Response(JSON.stringify({ error: 'Unknown product' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		const instructions = await create({ productId, ...product, metadata });
		return new Response(JSON.stringify(instructions), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		// Details go to your logs, not to the buyer: node errors can name your
		// wallet and say what is wrong with your setup.
		console.error('[create-bitcoin-payment] error:', err);
		return new Response(JSON.stringify({ error: 'Checkout is unavailable right now' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
};
