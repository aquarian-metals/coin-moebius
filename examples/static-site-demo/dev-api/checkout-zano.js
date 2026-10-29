/**
 * `POST /api/checkout/zano`: mint an integrated address via `simplewallet`
 * (real or mocked) and return the buyer-facing payment instructions, in
 * ZANO or in Freedom Dollar depending on the `assetId` the browser sent.
 *
 * Required env (real mode):
 *   - `ZANO_WALLET_RPC_URL` (e.g., `http://127.0.0.1:11212`)
 *   - `ZANO_WALLET_JWT_SECRET` (the value the wallet was started with)
 *
 * Mock mode (default for the demo):
 *   - Set `ZANO_MOCK=true`. The wallet RPC is simulated in-process; no
 *     `zanod` / `simplewallet` required.
 */

import {
	createZanoCreator,
	FREEDOM_DOLLAR_ASSET_ID,
	ZANO_ASSET_ID,
} from '@aquarian-metals/coin-moebius-zano/server';
import { getStore, isZanoMockEnabled } from './_shared.js';
import { handleZanoWalletRpc } from './mock-zano-wallet-rpc.js';

const PRODUCTS = {
	'jamstack-guide': {
		[ZANO_ASSET_ID]: { amount: 0.5, currency: 'ZANO' },
		[FREEDOM_DOLLAR_ASSET_ID]: { amount: 19.99, currency: 'USD' },
	},
};

let creator = null;

function getCreator() {
	if (creator) return creator;

	const fetcher = isZanoMockEnabled() ? makeMockFetcher() : globalThis.fetch.bind(globalThis);

	const walletRpcUrl = isZanoMockEnabled()
		? 'http://mock-zano-wallet-rpc'
		: (process.env.ZANO_WALLET_RPC_URL ?? '');

	if (!walletRpcUrl) return null;

	creator = createZanoCreator({
		walletRpcUrl,
		jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
		store: getStore(),
		fetcher,
		expiryMinutes: 15,
		rate: async (currency, asset) => {
			if (asset.assetId === FREEDOM_DOLLAR_ASSET_ID && currency === 'USD') return 1;
			throw new Error(`No price configured for ${currency} in ${asset.ticker}`);
		},
	});
	return creator;
}

function makeMockFetcher() {
	return async function mockFetch(_url, init) {
		const body = JSON.parse(String(init?.body ?? '{}'));
		const result = await handleZanoWalletRpc(body.method, body.params ?? {});
		const response = { id: body.id ?? '0', jsonrpc: '2.0', result };
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
}

export async function handleZanoCheckout(req, res) {
	const create = getCreator();
	if (!create) {
		res.statusCode = 503;
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify({
				error:
					'Zano is not configured. Set ZANO_MOCK=true to run the in-process simulator, or ZANO_WALLET_RPC_URL for a real wallet.',
			}),
		);
		return;
	}

	const body = await readJson(req);
	const productId = String(body.productId ?? '');
	const assetId = typeof body.assetId === 'string' ? body.assetId.toLowerCase() : ZANO_ASSET_ID;
	const price = Object.hasOwn(PRODUCTS, productId) ? PRODUCTS[productId][assetId] : undefined;
	if (!price) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'Unknown product' }));
		return;
	}
	const result = await create({ productId, ...price, assetId, metadata: body.metadata ?? {} });

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
