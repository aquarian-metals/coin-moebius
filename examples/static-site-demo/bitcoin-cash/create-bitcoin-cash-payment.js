import { createBitcoinCashCreator } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { myStore } from './_store.js';

const PRODUCTS = {
	'jamstack-guide': { amount: 0.04, currency: 'BCH' },
};

const create = createBitcoinCashCreator({
	rpcUrl: process.env.BCH_RPC_URL,
	wallet: process.env.BCH_WALLET,
	rpcUser: process.env.BCH_RPC_USER,
	rpcPassword: process.env.BCH_RPC_PASSWORD,
	xpub: process.env.BCH_XPUB,
	store: myStore,
	expiryMinutes: 15,
	bchPerUnit: async (currency) => {
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
		console.error('[create-bitcoin-cash-payment] error:', err);
		return new Response(JSON.stringify({ error: 'Checkout is unavailable right now' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
};
