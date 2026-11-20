/**
 * Process-wide singletons for the demo's in-process API.
 *
 * In production each handler would be its own serverless function and they
 * would share state through a real {@link PaymentStore} (Postgres, D1, etc.).
 * Here, every handler in `dev-api/*.js` runs inside the same Vite dev server
 * process, so a single in-memory store + verifier registry is enough to make
 * the whole flow observable end-to-end on `npm run dev`.
 *
 * The Stripe + Cryptomus verifiers register lazily so a developer without
 * those keys can still poke the Monero flow.
 */

import { randomBytes } from 'node:crypto';
import { createMemoryStore, createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';

let storeInstance = null;
let registryInstance = null;
const registeredProviders = new Set();

export function getStore() {
	if (!storeInstance) storeInstance = createMemoryStore();
	return storeInstance;
}

export function getRegistry() {
	if (!registryInstance) registryInstance = createVerifierRegistry();
	return registryInstance;
}

export function registerVerifierOnce(providerId, factory) {
	if (registeredProviders.has(providerId)) return;
	getRegistry().register(providerId, factory());
	registeredProviders.add(providerId);
}

export function isMoneroMockEnabled() {
	return process.env.MONERO_MOCK === 'true';
}

const localKeys = new Map();

function indexerSecret(name, localMode) {
	const configured = process.env[name];
	if (configured?.trim()) return configured;
	if (!localMode) return undefined;
	if (!localKeys.has(name)) localKeys.set(name, randomBytes(32).toString('hex'));
	return localKeys.get(name);
}

export function getMoneroHmacSecret() {
	return indexerSecret('MONERO_HMAC_SECRET', isMoneroMockEnabled());
}

export function isZanoMockEnabled() {
	return process.env.ZANO_MOCK === 'true';
}

export function getZanoHmacSecret() {
	return indexerSecret('ZANO_HMAC_SECRET', isZanoMockEnabled());
}

/**
 * Bitcoin needs no simulator: Bitcoin Core's regtest mode is a private,
 * empty chain on this machine, so the demo talks to a real node and real
 * transactions. `BITCOIN_REGTEST=true` fills in regtest's default port and
 * turns on the `/api/regtest/pay-bitcoin` helper.
 */
export function isBitcoinRegtestEnabled() {
	return process.env.BITCOIN_REGTEST === 'true';
}

export function getBitcoinRpcConfig() {
	const fallbackUrl = isBitcoinRegtestEnabled() ? 'http://127.0.0.1:18443' : '';
	const rpcUrl = process.env.BITCOIN_RPC_URL ?? fallbackUrl;
	if (!rpcUrl) return null;
	return {
		rpcUrl,
		wallet: process.env.BITCOIN_WALLET ?? 'shop',
		rpcUser: process.env.BITCOIN_RPC_USER,
		rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
	};
}

export function getBitcoinHmacSecret() {
	return indexerSecret('BITCOIN_HMAC_SECRET', isBitcoinRegtestEnabled());
}

export function isBitcoinCashRegtestEnabled() {
	return process.env.BCH_REGTEST === 'true';
}

const REGTEST_XPUB =
	'xpub6BgCeqf74freGvJ7zV1o7jpQFnrCbbmS5vuMmUcscejL7wVoCGjkwpFPQ7baLNqiRcSszfiQyrj8aNdnxpG8GpFDNFw1K3vF1YHK8kXxeFn';

export function getBitcoinCashConfig() {
	const regtest = isBitcoinCashRegtestEnabled();
	const rpcUrl = process.env.BCH_RPC_URL ?? (regtest ? 'http://127.0.0.1:18443' : '');
	const xpub = process.env.BCH_XPUB ?? (regtest ? REGTEST_XPUB : '');
	if (!rpcUrl || !xpub) return null;
	return {
		rpcUrl,
		wallet: process.env.BCH_WALLET ?? 'shop',
		rpcUser: process.env.BCH_RPC_USER,
		rpcPassword: process.env.BCH_RPC_PASSWORD,
		xpub,
		testKey: xpub === REGTEST_XPUB,
	};
}

export async function bitcoinCashNodeChain(config) {
	const headers = { 'Content-Type': 'application/json' };
	if (config.rpcUser !== undefined) {
		const credentials = `${config.rpcUser}:${config.rpcPassword ?? ''}`;
		headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
	}
	const response = await fetch(`${config.rpcUrl.replace(/\/+$/, '')}/wallet/${config.wallet}`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'getblockchaininfo', params: [] }),
	});
	const reply = await response.json();
	if (reply.error) throw new Error(`getblockchaininfo: ${reply.error.message}`);
	return reply.result.chain;
}

export function getBitcoinCashHmacSecret() {
	return indexerSecret('BCH_HMAC_SECRET', isBitcoinCashRegtestEnabled());
}
