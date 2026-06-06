/**
 * /api/checkout/monero — receives the browser's checkout POST, mints a
 * Monero subaddress via wallet RPC, persists a pending record to your
 * payment store, and returns the buyer instructions.
 *
 * This handler needs network access to `monero-wallet-rpc`. If your
 * serverless functions can't reach a private wallet RPC, deploy this
 * file as a tiny Express/Hono server on the same VPS as the wallet RPC
 * instead, and have the browser POST there.
 */
import { createMoneroCreator } from '@aquarian-metals/coin-moebius-monero/server';
import { myStore } from './_store.js';

const create = createMoneroCreator({
	walletRpcUrl: process.env.MONERO_WALLET_RPC_URL,
	store: myStore,
	requiredConfirmations: 10,
	expiryMinutes: 15,
	xmrPerUnit: async (currency) => {
		if (currency === 'XMR') return 1;
		// Replace with your price feed of choice — CoinGecko, Kraken
		// public ticker, pinned constant. Coin Moebius does not call any
		// oracle directly.
		throw new Error(`No price provider configured for currency: ${currency}`);
	},
});

export default async (req) => {
	if (req.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	try {
		const { productId, amount, currency, metadata } = await req.json();
		if (!productId || !amount || !currency) {
			throw new Error('Missing required fields: productId, amount, currency');
		}
		const instructions = await create({ productId, amount, currency, metadata });
		return new Response(JSON.stringify(instructions), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (err) {
		console.error('[create-monero-payment] error:', err);
		return new Response(
			JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
			{ status: 500, headers: { 'Content-Type': 'application/json' } },
		);
	}
};
