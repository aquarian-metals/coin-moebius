/**
 * `POST /api/checkout/monero` — mint a per-payment subaddress via
 * `monero-wallet-rpc` (real or mocked) and return the buyer-facing
 * payment instructions.
 *
 * Required env (real mode):
 *   - `MONERO_WALLET_RPC_URL` (e.g., `http://localhost:18083/json_rpc`)
 *
 * Mock mode (default for the demo):
 *   - Set `MONERO_MOCK=true`. The wallet RPC is simulated in-process —
 *     no `monerod` / `monero-wallet-rpc` required.
 */

import { createMoneroCreator } from '@aquarian-metals/coin-moebius-monero/server';
import { getStore, isMoneroMockEnabled } from './_shared.js';
import { handleWalletRpc } from './mock-wallet-rpc.js';

let creator = null;

function getCreator() {
	if (creator) return creator;

	const fetcher = isMoneroMockEnabled() ? makeMockFetcher() : globalThis.fetch.bind(globalThis);

	const walletRpcUrl = isMoneroMockEnabled()
		? 'http://mock-wallet-rpc/json_rpc'
		: (process.env.MONERO_WALLET_RPC_URL ?? '');

	if (!walletRpcUrl) return null;

	creator = createMoneroCreator({
		walletRpcUrl,
		store: getStore(),
		fetcher,
		expiryMinutes: 15,
	});
	return creator;
}

function makeMockFetcher() {
	return async function mockFetch(_url, init) {
		const body = JSON.parse(String(init?.body ?? '{}'));
		const result = await handleWalletRpc(body.method, body.params ?? {});
		const response = { id: body.id ?? '0', jsonrpc: '2.0', result };
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};
}

export async function handleMoneroCheckout(req, res) {
	const create = getCreator();
	if (!create) {
		res.statusCode = 503;
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify({
				error:
					'Monero is not configured. Set MONERO_MOCK=true to run the in-process simulator, or MONERO_WALLET_RPC_URL for a real wallet.',
			}),
		);
		return;
	}

	const body = await readJson(req);
	const result = await create({
		productId: String(body.productId ?? 'demo'),
		amount: Number(body.amount),
		currency: String(body.currency ?? 'XMR'),
		metadata: body.metadata ?? {},
	});

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
