/**
 * /api/checkout/zano: receives the browser's checkout POST, asks your
 * simplewallet for an integrated address, persists a pending record to
 * your payment store, and returns the buyer instructions.
 *
 * This handler needs network access to the wallet RPC. If your serverless
 * functions can't reach a private wallet, deploy this file as a tiny
 * Express/Hono server on the same VPS as the wallet instead, and have the
 * browser POST there.
 */
import {
	createZanoCreator,
	FREEDOM_DOLLAR_ASSET_ID,
} from '@aquarian-metals/coin-moebius-zano/server';
import { myStore } from './_store.js';

const PRODUCTS = {
	'jamstack-guide': { amount: 19.99, currency: 'USD', assetId: FREEDOM_DOLLAR_ASSET_ID },
};

const create = createZanoCreator({
	walletRpcUrl: process.env.ZANO_WALLET_RPC_URL,
	jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
	store: myStore,
	expiryMinutes: 15,
	rate: async (currency, asset) => {
		if (asset.assetId === FREEDOM_DOLLAR_ASSET_ID && currency === 'USD') return 1;
		// ZANO floats. Replace with your price feed of choice: CoinGecko, an
		// exchange ticker, a pinned constant. Coin Moebius calls no oracle.
		throw new Error(`No price configured for ${currency} in ${asset.ticker}`);
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
		console.error('[create-zano-payment] error:', err);
		return new Response(
			JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
			{ status: 500, headers: { 'Content-Type': 'application/json' } },
		);
	}
};
