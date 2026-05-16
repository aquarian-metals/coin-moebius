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

/**
 * Shared HMAC secret used by the Monero verifier (receiver) and indexer
 * (sender). Reads from env when set; falls back to a fixed dev-only value
 * so `MONERO_MOCK=true` runs out-of-the-box without per-secret setup.
 */
export function getMoneroHmacSecret() {
	return process.env.MONERO_HMAC_SECRET ?? 'demo-hmac-secret-not-for-production';
}
