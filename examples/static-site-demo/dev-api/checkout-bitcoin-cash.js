import { createBitcoinCashCreator } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { bitcoinCashNodeChain, getBitcoinCashConfig, getStore } from './_shared.js';

const PRODUCTS = {
	'jamstack-guide': { amount: 0.04, currency: 'BCH' },
};

let creator = null;

async function getCreator() {
	if (creator) return creator;
	const config = getBitcoinCashConfig();
	if (!config) return null;
	if (config.testKey && (await bitcoinCashNodeChain(config)) !== 'regtest') {
		throw new Error('The built-in test key is only for regtest. Set BCH_XPUB for any other node.');
	}

	creator = createBitcoinCashCreator({
		rpcUrl: config.rpcUrl,
		wallet: config.wallet,
		rpcUser: config.rpcUser,
		rpcPassword: config.rpcPassword,
		xpub: config.xpub,
		store: getStore(),
		expiryMinutes: 15,
		bchPerUnit: async (currency) => {
			throw new Error(`No price configured for ${currency}`);
		},
	});
	return creator;
}

export async function handleBitcoinCashCheckout(req, res) {
	const create = await getCreator();
	if (!create) {
		res.statusCode = 503;
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify({
				error:
					'Bitcoin Cash is not configured. Set BCH_REGTEST=true for a local regtest node, or BCH_RPC_URL and BCH_XPUB for any other node.',
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
