import { describe, it, expect, vi } from 'vitest';
import { asPayment } from '@aquarian-metals/coin-moebius-core';
import { createMemoryStore } from '@aquarian-metals/coin-moebius-server';
import type { PaymentStore } from '@aquarian-metals/coin-moebius-server';
import {
	createZanoCreator,
	createZanoVerifier,
	createZanoIndexer,
	computeZanoSignature,
	zanoAccessToken,
	toAtomic,
	fromAtomic,
	formatAtomic,
	FREEDOM_DOLLAR_ASSET_ID,
	ZANO_ASSET_ID,
	type ZanoWebhookPayload,
	type ZanoLogger,
} from '../src/server.js';

const WALLET_URL = 'http://wallet-rpc.test:11212';
const WEBHOOK_URL = 'http://webhook.test/api/payment-webhook';
const SECRET = 'hmac_secret_unit_tests_only';
const JWT_SECRET = 'jwt_secret_unit_tests_only';
const WEBHOOK_TS = 1_700_000_000_000;
const STANDARD_ADDRESS =
	'ZxBvJDuQjMG9R2j4WnYUhBYNrwZPwuyXrC7FHdVmWqaESgowDvgfWtiXeNGu8Px9B24pkmjsA39fzSSiEQG1ekB225ZnrMTBp';
const FUSD_DESCRIPTOR = {
	ticker: 'fUSD',
	full_name: 'Freedom Dollar',
	decimal_point: 4,
	current_supply: 120000000000,
	total_max_supply: '10000000000000000000',
	owner: '497d6b7acd06401c59b2d52a3967968e8ca507a25f80e44d2bb4b5f8a348c7c1',
	meta_info: '',
	hidden_supply: false,
};

function urlOf(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function bodyString(init?: RequestInit): string {
	const body = init?.body;
	return typeof body === 'string' ? body : '';
}

function headersOf(init?: RequestInit): Record<string, string> {
	return (init?.headers as Record<string, string> | undefined) ?? {};
}

function txHash(seed: string): string {
	return Buffer.from(seed).toString('hex').padEnd(64, '0');
}

interface WalletSubtransfer {
	amount: bigint | number;
	is_income: boolean;
	asset_id?: string;
}

interface WalletTx {
	tx_hash: string;
	height: number;
	subtransfers_by_pid: { payment_id: string; subtransfers: WalletSubtransfer[] }[];
}

/**
 * In-process stand-in for `simplewallet` in RPC mode: integrated addresses,
 * the asset whitelist, and a transfer history served newest first with
 * offset paging exactly the way `get_recent_txs_and_info3` does.
 */
function makeWallet() {
	const state = {
		height: 3_000_010,
		transfers: [] as WalletTx[],
		minted: [] as string[],
		calls: [] as {
			method: string;
			params: Record<string, unknown>;
			headers: Record<string, string>;
			body: string;
		}[],
		knownAssets: new Map<string, typeof FUSD_DESCRIPTOR>([
			[FREEDOM_DOLLAR_ASSET_ID, FUSD_DESCRIPTOR],
		]),
	};

	function handle(method: string, params: Record<string, unknown>): unknown {
		switch (method) {
			case 'make_integrated_address': {
				const paymentId = typeof params.payment_id === 'string' ? params.payment_id : '';
				state.minted.push(paymentId);
				return { integrated_address: `iZ${paymentId}${STANDARD_ADDRESS}`, payment_id: paymentId };
			}
			case 'assets_whitelist_add': {
				const descriptor = state.knownAssets.get(String(params.asset_id));
				if (!descriptor) return { status: 'NOT_FOUND', asset_descriptor: {} };
				return { status: 'OK', asset_descriptor: descriptor };
			}
			case 'get_recent_txs_and_info3': {
				const offset = Number(params.offset ?? 0);
				const count = Number(params.count ?? 50);
				const ordered = [...state.transfers].sort((a, b) => {
					if (a.height === 0 && b.height !== 0) return -1;
					if (b.height === 0 && a.height !== 0) return 1;
					return b.height - a.height;
				});
				return {
					pi: { curent_height: state.height, balance: 0, unlocked_balance: 0 },
					total_transfers: ordered.length,
					last_item_index: Math.min(ordered.length, offset + count),
					transfers: ordered.slice(offset, offset + count),
				};
			}
			default:
				return { __error: `no handler for ${method}` };
		}
	}

	function serialize(value: unknown): string {
		return JSON.stringify(value, (_key, v: unknown) =>
			typeof v === 'bigint' ? `__BIG_${v.toString()}__` : v,
		).replace(/"__BIG_(\d+)__"/g, '$1');
	}

	const fetcher: typeof fetch = async (input, init) => {
		if (!urlOf(input).endsWith('/json_rpc')) return new Response('', { status: 404 });
		const body = bodyString(init);
		const request = JSON.parse(body) as { method: string; params: Record<string, unknown> };
		state.calls.push({
			method: request.method,
			params: request.params,
			headers: headersOf(init),
			body,
		});
		const result = handle(request.method, request.params ?? {});
		if (typeof result === 'object' && result !== null && '__error' in result) {
			return new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: '0',
					error: { code: -1, message: String(result.__error) },
				}),
				{ status: 200 },
			);
		}
		return new Response(serialize({ jsonrpc: '2.0', id: '0', result }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	return { state, fetcher };
}

function withWebhookCapture(
	walletFetcher: typeof fetch,
	webhookCalls: { body: string; headers: Record<string, string> }[],
	respond: () => Response = () => new Response('', { status: 200 }),
): typeof fetch {
	return async (input, init) => {
		if (urlOf(input) === WEBHOOK_URL) {
			const response = respond();
			if (response.ok) webhookCalls.push({ body: bodyString(init), headers: headersOf(init) });
			return response;
		}
		return walletFetcher(input, init);
	};
}

function silentLogger(): ZanoLogger & { warnings: string[] } {
	const warnings: string[] = [];
	return {
		warnings,
		info: () => undefined,
		warn: (message) => {
			warnings.push(message);
		},
		error: () => undefined,
	};
}

describe('computeZanoSignature', () => {
	it('produces a hex SHA-256 (64 chars)', async () => {
		expect(await computeZanoSignature('{"hello":"world"}', SECRET)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic for the same body + key', async () => {
		expect(await computeZanoSignature('{"x":1}', SECRET)).toBe(
			await computeZanoSignature('{"x":1}', SECRET),
		);
	});

	it('changes when the body changes', async () => {
		expect(await computeZanoSignature('{"x":1}', SECRET)).not.toBe(
			await computeZanoSignature('{"x":2}', SECRET),
		);
	});

	it('changes when the key changes', async () => {
		expect(await computeZanoSignature('{"x":1}', SECRET)).not.toBe(
			await computeZanoSignature('{"x":1}', 'other_secret'),
		);
	});
});

describe('zanoAccessToken', () => {
	function decodePart(part: string): unknown {
		const padded = part
			.replace(/-/g, '+')
			.replace(/_/g, '/')
			.padEnd(Math.ceil(part.length / 4) * 4, '=');
		return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
	}

	it('is an HS256 JWT over the body hash, a fresh salt, and a one-minute expiry', async () => {
		const body = '{"jsonrpc":"2.0","id":"0","method":"getbalance","params":{}}';
		const token = await zanoAccessToken(body, JWT_SECRET, () => WEBHOOK_TS);
		const [header, payload, signature] = token.split('.');

		expect(decodePart(header)).toEqual({ alg: 'HS256', typ: 'JWT' });
		const claims = decodePart(payload) as { body_hash: string; salt: string; exp: number };
		const expectedHash = Buffer.from(
			await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)),
		).toString('hex');
		expect(claims.body_hash).toBe(expectedHash);
		expect(claims.salt).toMatch(/^[0-9a-f]{64}$/);
		expect(claims.exp).toBe(Math.floor(WEBHOOK_TS / 1000) + 60);

		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(JWT_SECRET),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const expectedSig = Buffer.from(
			await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`)),
		)
			.toString('base64')
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(signature).toBe(expectedSig);
	});

	it('never reuses a salt', async () => {
		const a = await zanoAccessToken('{}', JWT_SECRET);
		const b = await zanoAccessToken('{}', JWT_SECRET);
		expect(a).not.toBe(b);
	});
});

describe('amount conversion', () => {
	it('converts whole units to atomic at the asset precision', () => {
		expect(toAtomic(0.1, 12)).toBe('100000000000');
		expect(toAtomic(19.99, 4)).toBe('199900');
		expect(toAtomic(1, 0)).toBe('1');
	});

	it('rounds anything finer than the asset carries up, never down', () => {
		expect(toAtomic(0.00001, 4)).toBe('1');
		expect(toAtomic(1.00005, 4)).toBe('10001');
		expect(toAtomic(1e-7, 4)).toBe('1');
		expect(toAtomic(1.5e-7, 12)).toBe('150000');
	});

	it('reads binary float noise as the number the caller meant', () => {
		expect(toAtomic(0.1 + 0.2, 12)).toBe('300000000000');
		expect(toAtomic(19.99 * 1.0000000000000002, 4)).toBe('199900');
		expect(toAtomic(16 * 0.00625, 12)).toBe('100000000000');
	});

	it('rejects zero, negative, and non-finite amounts', () => {
		expect(() => toAtomic(0, 12)).toThrow(/positive/);
		expect(() => toAtomic(-1, 12)).toThrow(/positive/);
		expect(() => toAtomic(Number.NaN, 12)).toThrow(/positive/);
	});

	it('formats atomic units as an exact decimal string with no trailing zeros', () => {
		expect(formatAtomic(100000000000n, 12)).toBe('0.1');
		expect(formatAtomic(1n, 4)).toBe('0.0001');
		expect(formatAtomic(1234500n, 4)).toBe('123.45');
		expect(formatAtomic(5n, 0)).toBe('5');
		expect(formatAtomic(2000000000000n, 12)).toBe('2');
	});

	it('converts atomic units back to a display number', () => {
		expect(fromAtomic(199900n, 4)).toBe(19.99);
	});
});

describe('createZanoCreator', () => {
	it('mints an integrated address with a fresh 8-byte payment id, persists a pending record, and returns instructions', async () => {
		const wallet = makeWallet();
		const store = createMemoryStore();
		const create = createZanoCreator({ walletRpcUrl: WALLET_URL, store, fetcher: wallet.fetcher });

		const result = await create({ productId: 'pro', amount: 0.1, currency: 'ZANO' });

		expect(wallet.state.calls.map((c) => c.method)).toEqual(['make_integrated_address']);
		const paymentReference = wallet.state.minted[0];
		expect(paymentReference).toMatch(/^[0-9a-f]{16}$/);
		expect(result.paymentReference).toBe(paymentReference);
		expect(result.paymentId).toBe(`zano_${paymentReference}`);
		expect(result.address).toBe(`iZ${paymentReference}${STANDARD_ADDRESS}`);
		expect(result.assetId).toBe(ZANO_ASSET_ID);
		expect(result.ticker).toBe('ZANO');
		expect(result.decimalPoint).toBe(12);
		expect(result.atomicAmount).toBe('100000000000');
		expect(result.assetAmount).toBe(0.1);
		expect(result.uri).toBe(
			`zano:action=send&address=${result.address}&amount=0.1&asset_id=${ZANO_ASSET_ID}`,
		);
		expect(result.expiresAt).toBeGreaterThan(Date.now());

		const record = await store.get(result.paymentId);
		expect(record?.status).toBe('pending');
		expect(record?.provider).toBe('zano');
		expect(record?.metadata).toMatchObject({
			productId: 'pro',
			address: result.address,
			paymentReference,
			assetId: ZANO_ASSET_ID,
			ticker: 'ZANO',
			decimalPoint: 12,
			atomicAmount: '100000000000',
		});
	});

	it('charges a USD invoice in Freedom Dollar using the decimals the wallet reports', async () => {
		const wallet = makeWallet();
		const rate = vi.fn(async () => 1);
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
			rate,
		});

		const result = await create({
			productId: 'pro',
			amount: 19.99,
			currency: 'USD',
			assetId: FREEDOM_DOLLAR_ASSET_ID,
		});

		expect(wallet.state.calls.map((c) => c.method)).toEqual([
			'assets_whitelist_add',
			'make_integrated_address',
		]);
		expect(wallet.state.calls[0].params).toEqual({ asset_id: FREEDOM_DOLLAR_ASSET_ID });
		expect(rate).toHaveBeenCalledWith('USD', {
			assetId: FREEDOM_DOLLAR_ASSET_ID,
			ticker: 'fUSD',
			decimalPoint: 4,
		});
		expect(result.ticker).toBe('fUSD');
		expect(result.decimalPoint).toBe(4);
		expect(result.atomicAmount).toBe('199900');
		expect(result.assetAmount).toBe(19.99);
		expect(result.uri).toContain(`&amount=19.99&asset_id=${FREEDOM_DOLLAR_ASSET_ID}`);
	});

	it('needs no rate when the invoice currency is the asset itself', async () => {
		const wallet = makeWallet();
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
		});

		const fusd = await create({
			productId: 'p',
			amount: 5,
			currency: 'fusd',
			assetId: FREEDOM_DOLLAR_ASSET_ID.toUpperCase(),
		});
		expect(fusd.atomicAmount).toBe('50000');
		expect(fusd.assetId).toBe(FREEDOM_DOLLAR_ASSET_ID);

		const zano = await create({
			productId: 'p',
			amount: 2,
			currency: 'zano',
			assetId: ZANO_ASSET_ID,
		});
		expect(zano.atomicAmount).toBe('2000000000000');
	});

	it('converts a USD invoice into ZANO through the rate callback', async () => {
		const wallet = makeWallet();
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
			rate: async (currency, asset) => (currency === 'USD' && asset.ticker === 'ZANO' ? 0.125 : 0),
		});

		const result = await create({ productId: 'p', amount: 8, currency: 'USD' });
		expect(result.assetAmount).toBe(1);
		expect(result.atomicAmount).toBe('1000000000000');
	});

	it('throws when the invoice needs a rate and none was supplied', async () => {
		const wallet = makeWallet();
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
		});
		await expect(create({ productId: 'p', amount: 16, currency: 'USD' })).rejects.toThrow(
			/requires rate/,
		);
	});

	it('throws when the rate is not positive', async () => {
		const wallet = makeWallet();
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
			rate: async () => 0,
		});
		await expect(create({ productId: 'p', amount: 16, currency: 'USD' })).rejects.toThrow(
			/must be positive/,
		);
	});

	it('refuses an asset the chain does not know', async () => {
		const wallet = makeWallet();
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
		});
		await expect(
			create({ productId: 'p', amount: 1, currency: 'X', assetId: 'ab'.repeat(32) }),
		).rejects.toThrow(/not on the chain/);
	});

	it('refuses a malformed asset id before touching the wallet', async () => {
		const wallet = makeWallet();
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
		});
		await expect(
			create({ productId: 'p', amount: 1, currency: 'X', assetId: 'nope' }),
		).rejects.toThrow(/not a Zano asset id/);
		expect(wallet.state.calls).toHaveLength(0);
	});

	it('refuses a descriptor with no usable ticker or decimals', async () => {
		const wallet = makeWallet();
		wallet.state.knownAssets.set('cd'.repeat(32), { ...FUSD_DESCRIPTOR, ticker: '' });
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
		});
		await expect(
			create({ productId: 'p', amount: 1, currency: 'X', assetId: 'cd'.repeat(32) }),
		).rejects.toThrow(/no usable descriptor/);
	});

	it('propagates wallet-rpc errors', async () => {
		const fetcher: typeof fetch = async () =>
			new Response(
				JSON.stringify({ jsonrpc: '2.0', id: '0', error: { code: -1, message: 'wallet locked' } }),
				{ status: 200 },
			);
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher,
		});
		await expect(create({ productId: 'p', amount: 0.1, currency: 'ZANO' })).rejects.toThrow(
			/wallet locked/,
		);
	});

	it('explains a 401 from a wallet that wants its JWT secret', async () => {
		const fetcher: typeof fetch = async () => new Response('Unauthorized', { status: 401 });
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher,
		});
		await expect(create({ productId: 'p', amount: 0.1, currency: 'ZANO' })).rejects.toThrow(
			/--jwt-secret/,
		);
	});

	it('reports other HTTP failures and empty results plainly', async () => {
		const failing: typeof fetch = async () => new Response('boom', { status: 503 });
		await expect(
			createZanoCreator({ walletRpcUrl: WALLET_URL, store: createMemoryStore(), fetcher: failing })(
				{
					productId: 'p',
					amount: 0.1,
					currency: 'ZANO',
				},
			),
		).rejects.toThrow(/HTTP 503/);

		const empty: typeof fetch = async () =>
			new Response(JSON.stringify({ jsonrpc: '2.0', id: '0' }), { status: 200 });
		await expect(
			createZanoCreator({ walletRpcUrl: WALLET_URL, store: createMemoryStore(), fetcher: empty })({
				productId: 'p',
				amount: 0.1,
				currency: 'ZANO',
			}),
		).rejects.toThrow(/no result/);
	});

	it('throws when the wallet returns no integrated address', async () => {
		const fetcher: typeof fetch = async () =>
			new Response(
				JSON.stringify({ jsonrpc: '2.0', id: '0', result: { integrated_address: '' } }),
				{
					status: 200,
				},
			);
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher,
		});
		await expect(create({ productId: 'p', amount: 0.1, currency: 'ZANO' })).rejects.toThrow(
			/no integrated address/,
		);
	});

	it('sends a one-time Zano-Access-Token on every call when jwtSecret is set, and none otherwise', async () => {
		const wallet = makeWallet();
		const withJwt = createZanoCreator({
			walletRpcUrl: `${WALLET_URL}/json_rpc`,
			jwtSecret: JWT_SECRET,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
		});
		await withJwt({ productId: 'p', amount: 0.1, currency: 'ZANO' });

		const call = wallet.state.calls[0];
		const token = call.headers['Zano-Access-Token'];
		expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
		const claims = JSON.parse(
			Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
				'utf8',
			),
		) as { body_hash: string };
		expect(claims.body_hash).toBe(
			Buffer.from(
				await crypto.subtle.digest('SHA-256', new TextEncoder().encode(call.body)),
			).toString('hex'),
		);

		const withoutJwt = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
		});
		await withoutJwt({ productId: 'p', amount: 0.1, currency: 'ZANO' });
		expect(wallet.state.calls[1].headers['Zano-Access-Token']).toBeUndefined();
	});
});

describe('createZanoVerifier', () => {
	function makeWebhookPayload(overrides: Partial<ZanoWebhookPayload> = {}): ZanoWebhookPayload {
		return {
			provider: 'zano',
			paymentId: 'zano_1dfe5a88ff9effb3',
			status: 'success',
			txHash: txHash('aabbccdd'),
			address: `iZ1dfe5a88ff9effb3${STANDARD_ADDRESS}`,
			assetId: FREEDOM_DOLLAR_ASSET_ID,
			ticker: 'fUSD',
			decimalPoint: 4,
			invoiceCurrency: 'USD',
			invoiceAmount: 16,
			expectedAmountAtomic: '160000',
			receivedAmountAtomic: '160000',
			expectedAmount: 16,
			receivedAmount: 16,
			confirmations: 10,
			requiredConfirmations: 10,
			blockHeight: 3000000,
			timestamp: WEBHOOK_TS,
			...overrides,
		};
	}

	const makeVerifier = () => createZanoVerifier({ hmacSecret: SECRET, now: () => WEBHOOK_TS });

	it('throws at construction when hmacSecret is missing', () => {
		expect(() => createZanoVerifier({ hmacSecret: '' })).toThrow(/hmacSecret missing/);
	});

	it('accepts a correctly-signed success payload and maps it to a payment event', async () => {
		const payload = makeWebhookPayload();
		const sig = await computeZanoSignature(JSON.stringify(payload), SECRET);

		const result = asPayment(await makeVerifier().verify(payload, { 'x-zano-sig': sig }));
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe(payload.paymentId);
		expect(result!.provider).toBe('zano');
		expect(result!.amount).toBe(16);
		expect(result!.currency).toBe('USD');
		expect(result!.metadata).toMatchObject({
			address: payload.address,
			txHash: payload.txHash,
			assetId: FREEDOM_DOLLAR_ASSET_ID,
			ticker: 'fUSD',
			decimalPoint: 4,
			confirmations: 10,
			requiredConfirmations: 10,
		});
		expect(result!.metadata.otherAssets).toBeUndefined();
	});

	it('passes money received in other assets through on metadata', async () => {
		const payload = makeWebhookPayload({
			otherAssets: [{ assetId: ZANO_ASSET_ID, amountAtomic: '1000000000000' }],
		});
		const sig = await computeZanoSignature(JSON.stringify(payload), SECRET);
		const result = asPayment(await makeVerifier().verify(payload, { 'x-zano-sig': sig }));
		expect(result!.metadata.otherAssets).toEqual([
			{ assetId: ZANO_ASSET_ID, amountAtomic: '1000000000000' },
		]);
	});

	it('maps partial payments to a prorated invoice amount', async () => {
		const payload = makeWebhookPayload({
			status: 'partial',
			invoiceAmount: 100,
			expectedAmountAtomic: '1000000',
			receivedAmountAtomic: '600000',
			receivedAmount: 60,
		});
		const sig = await computeZanoSignature(JSON.stringify(payload), SECRET);
		const result = asPayment(await makeVerifier().verify(payload, { 'x-zano-sig': sig }));
		expect(result!.status).toBe('partial');
		expect(result!.amount).toBeCloseTo(60, 6);
	});

	it('maps failed payments to amount 0', async () => {
		const payload = makeWebhookPayload({
			status: 'failed',
			txHash: null,
			receivedAmountAtomic: '0',
			receivedAmount: 0,
			confirmations: 0,
			blockHeight: null,
		});
		const sig = await computeZanoSignature(JSON.stringify(payload), SECRET);
		const result = asPayment(await makeVerifier().verify(payload, { 'x-zano-sig': sig }));
		expect(result!.status).toBe('failed');
		expect(result!.amount).toBe(0);
	});

	it('rejects a payload with no signature header', async () => {
		await expect(makeVerifier().verify(makeWebhookPayload(), {})).rejects.toThrow(
			/missing x-zano-sig/,
		);
	});

	it('rejects a payload with an invalid signature', async () => {
		const payload = makeWebhookPayload();
		const wrongSig = await computeZanoSignature(JSON.stringify(payload), 'wrong_key');
		await expect(makeVerifier().verify(payload, { 'x-zano-sig': wrongSig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a tampered body even with the original signature', async () => {
		const sig = await computeZanoSignature(JSON.stringify(makeWebhookPayload()), SECRET);
		const tampered = makeWebhookPayload({ invoiceAmount: 999999 });
		await expect(makeVerifier().verify(tampered, { 'x-zano-sig': sig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a replayed webhook whose signed timestamp is stale', async () => {
		const payload = makeWebhookPayload();
		const sig = await computeZanoSignature(JSON.stringify(payload), SECRET);
		const stale = createZanoVerifier({
			hmacSecret: SECRET,
			now: () => WEBHOOK_TS + 60 * 60 * 1000,
		});
		await expect(stale.verify(payload, { 'x-zano-sig': sig })).rejects.toThrow(/freshness window/);
	});

	it('accepts the body as a raw JSON string identically to a parsed object', async () => {
		const payload = makeWebhookPayload();
		const body = JSON.stringify(payload);
		const sig = await computeZanoSignature(body, SECRET);
		const fromObject = asPayment(await makeVerifier().verify(payload, { 'X-Zano-Sig': sig }));
		const fromString = asPayment(await makeVerifier().verify(body, { 'x-zano-sig': sig }));
		expect(fromObject!.paymentId).toBe(fromString!.paymentId);
	});

	it('rejects non-JSON strings and non-object bodies', async () => {
		const sig = await computeZanoSignature('not json', SECRET);
		await expect(makeVerifier().verify('not json', { 'x-zano-sig': sig })).rejects.toThrow(
			/not valid JSON/,
		);
		await expect(makeVerifier().verify(42, { 'x-zano-sig': sig })).rejects.toThrow(
			/unsupported body type/,
		);
	});
});

describe('createZanoIndexer', () => {
	async function setup(opts: { now?: () => number; rate?: () => Promise<number> } = {}) {
		const wallet = makeWallet();
		const store = createMemoryStore();
		const webhookCalls: { body: string; headers: Record<string, string> }[] = [];
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store,
			fetcher: wallet.fetcher,
			rate: opts.rate ?? (async () => 1),
		});

		const zanoInvoice = await create({ productId: 'p1', amount: 0.1, currency: 'ZANO' });
		const fusdInvoice = await create({
			productId: 'p2',
			amount: 19.99,
			currency: 'USD',
			assetId: FREEDOM_DOLLAR_ASSET_ID,
		});

		const logger = silentLogger();
		const fetcher = withWebhookCapture(wallet.fetcher, webhookCalls);
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
			logger,
			now: opts.now,
		});

		function pay(
			invoice: { paymentReference: string },
			input: { amount: bigint | number; assetId?: string; height?: number; hash?: string },
		) {
			wallet.state.transfers.push({
				tx_hash: txHash(input.hash ?? `tx${wallet.state.transfers.length + 1}`),
				height: input.height ?? wallet.state.height - 10,
				subtransfers_by_pid: [
					{
						payment_id: invoice.paymentReference,
						subtransfers: [
							{
								amount: input.amount,
								is_income: true,
								...(input.assetId === undefined ? {} : { asset_id: input.assetId }),
							},
						],
					},
				],
			});
		}

		return { wallet, store, webhookCalls, indexer, logger, zanoInvoice, fusdInvoice, pay };
	}

	function lastPayload(ctx: { webhookCalls: { body: string }[] }): ZanoWebhookPayload {
		return JSON.parse(ctx.webhookCalls.at(-1)!.body) as ZanoWebhookPayload;
	}

	it('tick(): settles a fully-confirmed ZANO payment and POSTs a signed webhook', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000 });

		const result = await ctx.indexer.tick();
		expect(result.walletHeight).toBe(ctx.wallet.state.height);
		expect(result.transfersInspected).toBe(1);
		expect(result.webhooksSent).toBe(1);
		expect(result.errors).toEqual([]);

		const payload = lastPayload(ctx);
		expect(payload.status).toBe('success');
		expect(payload.paymentId).toBe(ctx.zanoInvoice.paymentId);
		expect(payload.assetId).toBe(ZANO_ASSET_ID);
		expect(payload.confirmations).toBe(10);
		expect(payload.requiredConfirmations).toBe(10);
		expect(payload.blockHeight).toBe(ctx.wallet.state.height - 10);
		expect(payload.receivedAmountAtomic).toBe('100000000000');
		expect(payload.otherAssets).toBeUndefined();

		expect(ctx.webhookCalls[0].headers['x-zano-sig']).toBe(
			await computeZanoSignature(ctx.webhookCalls[0].body, SECRET),
		);
		expect(ctx.webhookCalls[0].headers['x-provider']).toBe('zano');
		expect((await ctx.store.get(ctx.zanoInvoice.paymentId))?.status).toBe('success');
	});

	it('tick(): settles a Freedom Dollar payment matched by asset id', async () => {
		const ctx = await setup();
		ctx.pay(ctx.fusdInvoice, { amount: 199_900, assetId: FREEDOM_DOLLAR_ASSET_ID });

		await ctx.indexer.tick();

		const payload = lastPayload(ctx);
		expect(payload.status).toBe('success');
		expect(payload.paymentId).toBe(ctx.fusdInvoice.paymentId);
		expect(payload.ticker).toBe('fUSD');
		expect(payload.receivedAmount).toBe(19.99);
		expect((await ctx.store.get(ctx.fusdInvoice.paymentId))?.status).toBe('success');
		expect((await ctx.store.get(ctx.zanoInvoice.paymentId))?.status).toBe('pending');
	});

	it('tick(): reads amounts past 2^53 exactly', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 12345678901234567890n });

		await ctx.indexer.tick();
		expect(lastPayload(ctx).receivedAmountAtomic).toBe('12345678901234567890');
	});

	it('tick(): reports an under-confirmed payment without settling it, then only when the count moves', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000, height: ctx.wallet.state.height - 5 });

		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('pending');
		expect(lastPayload(ctx).confirmations).toBe(5);
		expect((await ctx.store.get(ctx.zanoInvoice.paymentId))?.status).toBe('pending');

		const quiet = await ctx.indexer.tick();
		expect(quiet.webhooksSent).toBe(0);
		expect(ctx.webhookCalls).toHaveLength(1);

		ctx.wallet.state.height += 3;
		await ctx.indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(2);
		expect(lastPayload(ctx).confirmations).toBe(8);

		ctx.wallet.state.height += 2;
		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('success');
		expect((await ctx.store.get(ctx.zanoInvoice.paymentId))?.status).toBe('success');
	});

	it('tick(): reports a payment still in the pool as seen with zero confirmations', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000, height: 0 });

		await ctx.indexer.tick();
		const payload = lastPayload(ctx);
		expect(payload.status).toBe('pending');
		expect(payload.confirmations).toBe(0);
		expect(payload.blockHeight).toBeNull();
	});

	it('tick(): marks an underpaid confirmed payment as partial', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 60_000_000_000 });

		await ctx.indexer.tick();
		const payload = lastPayload(ctx);
		expect(payload.status).toBe('partial');
		expect(payload.receivedAmountAtomic).toBe('60000000000');
		expect(payload.expectedAmountAtomic).toBe('100000000000');
		expect((await ctx.store.get(ctx.zanoInvoice.paymentId))?.amount).toBeCloseTo(0.06, 9);
	});

	it('tick(): sums several transfers on one payment id and gates on the slowest', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 50_000_000_000, height: ctx.wallet.state.height - 12 });
		ctx.pay(ctx.zanoInvoice, { amount: 50_000_000_000, height: ctx.wallet.state.height - 4 });

		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('pending');
		expect(lastPayload(ctx).confirmations).toBe(4);
		expect(lastPayload(ctx).receivedAmountAtomic).toBe('100000000000');
	});

	it('tick(): never counts money in the wrong asset, and names it on the webhook once the right asset arrives', async () => {
		const ctx = await setup();
		ctx.pay(ctx.fusdInvoice, { amount: 1_000_000_000_000 });

		const wrongOnly = await ctx.indexer.tick();
		expect(wrongOnly.webhooksSent).toBe(0);
		expect(ctx.logger.warnings).toContain(
			'zano: payment received in an asset that was not invoiced',
		);
		expect((await ctx.store.get(ctx.fusdInvoice.paymentId))?.status).toBe('pending');

		ctx.pay(ctx.fusdInvoice, { amount: 199_900, assetId: FREEDOM_DOLLAR_ASSET_ID });
		await ctx.indexer.tick();
		const payload = lastPayload(ctx);
		expect(payload.status).toBe('success');
		expect(payload.receivedAmountAtomic).toBe('199900');
		expect(payload.otherAssets).toEqual([
			{ assetId: ZANO_ASSET_ID, amountAtomic: '1000000000000' },
		]);
		expect((await ctx.store.get(ctx.fusdInvoice.paymentId))?.metadata.otherAssets).toEqual(
			payload.otherAssets,
		);
	});

	it('tick(): ignores payment ids the store does not know and transfers with no payment id', async () => {
		const ctx = await setup();
		ctx.wallet.state.transfers.push({
			tx_hash: txHash('stranger'),
			height: ctx.wallet.state.height - 10,
			subtransfers_by_pid: [
				{ payment_id: 'ffffffffffffffff', subtransfers: [{ amount: 5, is_income: true }] },
				{ payment_id: '', subtransfers: [{ amount: 5, is_income: true }] },
				{
					payment_id: ctx.zanoInvoice.paymentReference,
					subtransfers: [{ amount: 5, is_income: false }],
				},
			],
		});

		const result = await ctx.indexer.tick();
		expect(result.webhooksSent).toBe(0);
		expect(result.errors).toEqual([]);
	});

	it('tick(): expiry sweep marks unpaid expired invoices as failed through listPending', async () => {
		let currentTime = 1_700_000_000_000;
		const ctx = await setup({ now: () => currentTime });
		ctx.pay(ctx.fusdInvoice, {
			amount: 199_900,
			assetId: FREEDOM_DOLLAR_ASSET_ID,
			height: ctx.wallet.state.height - 2,
		});

		currentTime = Math.max(ctx.zanoInvoice.expiresAt, ctx.fusdInvoice.expiresAt) + 1000;
		const result = await ctx.indexer.tick();

		const statuses = ctx.webhookCalls.map((c) => (JSON.parse(c.body) as ZanoWebhookPayload).status);
		expect(statuses.sort()).toEqual(['failed', 'pending']);
		expect(result.webhooksSent).toBe(2);

		const failed = ctx.webhookCalls
			.map((c) => JSON.parse(c.body) as ZanoWebhookPayload)
			.find((p) => p.status === 'failed')!;
		expect(failed.paymentId).toBe(ctx.zanoInvoice.paymentId);
		expect(failed.txHash).toBeNull();
		expect(failed.receivedAmountAtomic).toBe('0');
		const record = await ctx.store.get(ctx.zanoInvoice.paymentId);
		expect(record?.status).toBe('failed');
		expect(record?.metadata.failureReason).toBe('expired');
		expect((await ctx.store.get(ctx.fusdInvoice.paymentId))?.status).toBe('pending');
		expect(ctx.indexer.status().pendingPaymentCount).toBe(1);
	});

	it('tick(): leaves unpaid invoices pending and warns once when the store cannot list them', async () => {
		let currentTime = 1_700_000_000_000;
		const ctx = await setup({ now: () => currentTime });
		const noListStore: PaymentStore = {
			upsert: ctx.store.upsert.bind(ctx.store),
			get: ctx.store.get.bind(ctx.store),
		};
		const logger = silentLogger();
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store: noListStore,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(ctx.wallet.fetcher, ctx.webhookCalls),
			logger,
			now: () => currentTime,
		});

		currentTime = ctx.zanoInvoice.expiresAt + 1000;
		await indexer.tick();
		await indexer.tick();

		expect(ctx.webhookCalls).toHaveLength(0);
		expect((await ctx.store.get(ctx.zanoInvoice.paymentId))?.status).toBe('pending');
		expect(logger.warnings.filter((w) => w.includes('listPending'))).toHaveLength(1);
	});

	it('tick(): does not re-emit webhooks for already-announced payments (uses markStatusAnnounced)', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000 });

		await ctx.indexer.tick();
		await ctx.indexer.tick();
		await ctx.indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(1);
	});

	it('tick(): falls back to status-read idempotency when markStatusAnnounced is absent', async () => {
		const ctx = await setup();
		const plainStore: PaymentStore = {
			upsert: ctx.store.upsert.bind(ctx.store),
			get: ctx.store.get.bind(ctx.store),
		};
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000 });
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store: plainStore,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(ctx.wallet.fetcher, ctx.webhookCalls),
		});

		await indexer.tick();
		await indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(1);
	});

	it('tick(): re-entrant calls share the same in-flight promise', async () => {
		const ctx = await setup();
		const a = ctx.indexer.tick();
		const b = ctx.indexer.tick();
		expect(a).toBe(b);
		await a;
		expect(ctx.indexer.status().totalTicks).toBe(1);
	});

	it('tick(): pages through history newest first and stops past the lookback depth', async () => {
		const ctx = await setup();
		const top = ctx.wallet.state.height;
		ctx.pay(ctx.zanoInvoice, { amount: 40_000_000_000, height: top - 1, hash: 'new' });
		ctx.pay(ctx.zanoInvoice, { amount: 60_000_000_000, height: top - 15, hash: 'mid' });
		ctx.pay(ctx.zanoInvoice, { amount: 1, height: top - 500, hash: 'ancient' });
		ctx.wallet.state.transfers.push({
			tx_hash: txHash('older'),
			height: top - 600,
			subtransfers_by_pid: [],
		});
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			scanLookbackBlocks: 20,
			pageSize: 2,
			fetcher: withWebhookCapture(ctx.wallet.fetcher, ctx.webhookCalls),
		});

		const result = await indexer.tick();

		const pages = ctx.wallet.state.calls.filter((c) => c.method === 'get_recent_txs_and_info3');
		expect(pages.map((c) => c.params.offset)).toEqual([0, 2]);
		expect(pages[0].params.update_provision_info).toBe(true);
		expect(pages[1].params.update_provision_info).toBe(false);
		expect(result.transfersInspected).toBe(4);
		expect(lastPayload(ctx).receivedAmountAtomic).toBe('100000000001');
	});

	it('tick(): prefers the confirmed copy when a transfer shows up both in the pool and in history', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000, height: 0, hash: 'same' });
		ctx.pay(ctx.zanoInvoice, {
			amount: 100_000_000_000,
			height: ctx.wallet.state.height - 10,
			hash: 'same',
		});

		const result = await ctx.indexer.tick();
		expect(result.transfersInspected).toBe(1);
		expect(lastPayload(ctx).status).toBe('success');
		expect(lastPayload(ctx).receivedAmountAtomic).toBe('100000000000');
	});

	it('tick(): retries webhook delivery on transient failures', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000 });
		let attempts = 0;
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(ctx.wallet.fetcher, ctx.webhookCalls, () => {
				attempts += 1;
				return new Response('', { status: attempts < 3 ? 503 : 200 });
			}),
			webhookRetry: { maxAttempts: 3, initialBackoffMs: 1 },
		});

		await indexer.tick();
		expect(attempts).toBe(3);
		expect(ctx.webhookCalls).toHaveLength(1);
		expect(indexer.status().webhookErrorCount).toBe(0);
	});

	it('tick(): counts a webhook error when every retry is exhausted', async () => {
		const ctx = await setup();
		ctx.pay(ctx.zanoInvoice, { amount: 100_000_000_000 });
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(
				ctx.wallet.fetcher,
				ctx.webhookCalls,
				() => new Response('', { status: 500 }),
			),
			webhookRetry: { maxAttempts: 2, initialBackoffMs: 1 },
		});

		const result = await indexer.tick();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(indexer.status().webhookErrorCount).toBe(1);
		expect(indexer.status().lastError?.message).toContain('webhook responded 500');
	});

	it('tick(): records lastError when wallet RPC itself fails', async () => {
		const ctx = await setup();
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: async () => new Response('boom', { status: 500 }),
		});

		const result = await indexer.tick();
		expect(result.errors[0]).toContain('HTTP 500');
		expect(indexer.status().lastError).not.toBeNull();
		expect(indexer.status().totalTicks).toBe(1);
	});

	it('tick(): fails plainly when the wallet reports no height', async () => {
		const ctx = await setup();
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: async () =>
				new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result: { transfers: [] } }), {
					status: 200,
				}),
		});
		const result = await indexer.tick();
		expect(result.errors[0]).toContain('no height');
	});

	it('start()/stop(): polls on the configured interval and stops cleanly', async () => {
		vi.useFakeTimers();
		try {
			const ctx = await setup();
			const indexer = createZanoIndexer({
				walletRpcUrl: WALLET_URL,
				store: ctx.store,
				webhookUrl: WEBHOOK_URL,
				hmacSecret: SECRET,
				fetcher: withWebhookCapture(ctx.wallet.fetcher, ctx.webhookCalls),
				pollIntervalMs: 1000,
			});

			const stop = indexer.start();
			vi.advanceTimersByTime(2500);
			await vi.runOnlyPendingTimersAsync();
			stop();
			vi.advanceTimersByTime(5000);
			await vi.runOnlyPendingTimersAsync();

			expect(indexer.status().totalTicks).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('throws at construction when hmacSecret is missing', () => {
		expect(() =>
			createZanoIndexer({
				walletRpcUrl: WALLET_URL,
				store: createMemoryStore(),
				webhookUrl: WEBHOOK_URL,
				hmacSecret: '',
			}),
		).toThrow(/hmacSecret missing/);
	});
});

/**
 * Two money bugs found in review, held down here so they cannot come back.
 *
 * The first is a lost payment: the indexer claims the right to announce a
 * settlement before it delivers the webhook, so a delivery that failed used to
 * burn the claim and leave real, confirmed money unannounced forever.
 *
 * The second is a short payment: the amount shown to the buyer came from the
 * pre-rounding quote while the invoice required the rounded-up atomic value, so
 * a buyer who sent exactly what the modal said came up an atomic unit short.
 */
describe('announcement survives a failed webhook delivery', () => {
	async function settleWith(respond: () => Response) {
		const wallet = makeWallet();
		const store = createMemoryStore();
		const webhookCalls: { body: string; headers: Record<string, string> }[] = [];
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store,
			fetcher: wallet.fetcher,
			rate: async () => 1,
		});
		const invoice = await create({ productId: 'p1', amount: 0.1, currency: 'ZANO' });
		const indexer = createZanoIndexer({
			walletRpcUrl: WALLET_URL,
			store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher: withWebhookCapture(wallet.fetcher, webhookCalls, respond),
			logger: silentLogger(),
			webhookRetry: { maxAttempts: 1, initialBackoffMs: 0 },
		});
		wallet.state.transfers.push({
			tx_hash: txHash('tx1'),
			height: wallet.state.height - 10,
			subtransfers_by_pid: [
				{
					payment_id: invoice.paymentReference,
					subtransfers: [{ amount: 100_000_000_000n, is_income: true }],
				},
			],
		});
		return { store, indexer, webhookCalls, invoice };
	}

	it('retries on the next tick after the endpoint refuses, and settles once it recovers', async () => {
		let healthy = false;
		const ctx = await settleWith(() =>
			healthy ? new Response('', { status: 200 }) : new Response('', { status: 500 }),
		);

		const first = await ctx.indexer.tick();
		expect(first.webhooksSent).toBe(0);
		expect(first.errors).toHaveLength(1);
		expect(ctx.webhookCalls).toHaveLength(0);
		expect((await ctx.store.get(ctx.invoice.paymentId))!.status).toBe('pending');

		healthy = true;
		const second = await ctx.indexer.tick();
		expect(second.webhooksSent).toBe(1);
		expect(second.errors).toEqual([]);
		const payload = JSON.parse(ctx.webhookCalls[0].body) as ZanoWebhookPayload;
		expect(payload.status).toBe('success');
		expect(payload.paymentId).toBe(ctx.invoice.paymentId);
		expect((await ctx.store.get(ctx.invoice.paymentId))!.status).toBe('success');
	});

	it('still announces a settlement only once when delivery works', async () => {
		const ctx = await settleWith(() => new Response('', { status: 200 }));
		expect((await ctx.indexer.tick()).webhooksSent).toBe(1);
		expect((await ctx.indexer.tick()).webhooksSent).toBe(0);
		expect(ctx.webhookCalls).toHaveLength(1);
	});
});

describe('the amount quoted to the buyer is the amount that settles', () => {
	async function quote(amount: number, currency: string, rate: number, assetId?: string) {
		const wallet = makeWallet();
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: wallet.fetcher,
			rate: async () => rate,
		});
		return await create({
			productId: 'p1',
			amount,
			currency,
			...(assetId === undefined ? {} : { assetId }),
		});
	}

	it('quotes ZANO at a rate that does not land on 12 decimals', async () => {
		// 19.99 USD at this rate needs rounding up past the 12th decimal.
		const invoice = await quote(19.99, 'USD', 1 / 2.87);
		expect(invoice.assetAmount).toBe(Number(formatAtomic(BigInt(invoice.atomicAmount), 12)));
		expect(toAtomic(invoice.assetAmount, 12)).toBe(invoice.atomicAmount);
	});

	it('quotes Freedom Dollar, whose four decimals round far more often', async () => {
		const invoice = await quote(19.99, 'USD', 1.00005, FREEDOM_DOLLAR_ASSET_ID);
		expect(invoice.decimalPoint).toBe(4);
		expect(invoice.assetAmount).toBe(Number(formatAtomic(BigInt(invoice.atomicAmount), 4)));
		expect(toAtomic(invoice.assetAmount, 4)).toBe(invoice.atomicAmount);
	});

	it('never quotes less than the invoice requires, across a spread of awkward rates', async () => {
		for (const rate of [1 / 3, 1 / 7, 0.123456789012345, 1.00005, 1 / 2.87]) {
			const invoice = await quote(19.99, 'USD', rate);
			expect(toAtomic(invoice.assetAmount, invoice.decimalPoint)).toBe(invoice.atomicAmount);
		}
	});

	it('never shows more decimal places than the asset can carry', async () => {
		// This is where the underpayment came from. A quote printed to more
		// places than the asset holds gets truncated by the buyer's wallet, or
		// by the buyer's own typing, and lands under the invoice.
		const decimalsOf = (n: number) => (n.toString().split('.')[1] ?? '').length;

		const zano = await quote(19.99, 'USD', 1 / 2.87);
		expect(decimalsOf(zano.assetAmount)).toBeLessThanOrEqual(12);

		const fusd = await quote(19.99, 'USD', 1.00005, FREEDOM_DOLLAR_ASSET_ID);
		expect(decimalsOf(fusd.assetAmount)).toBeLessThanOrEqual(4);
		expect(formatAtomic(BigInt(fusd.atomicAmount), 4)).toBe('19.991');
	});
});

/**
 * The wallet's replies are pre-scanned so 64-bit amounts survive JSON.parse.
 * A scanner that mistakes the tail of a decimal for a whole number writes
 * text JSON.parse rejects, and because every wallet call goes through it, the
 * indexer would then throw on every tick and never recover on its own.
 */
describe('wallet replies containing awkward numbers still parse', () => {
	function walletReturning(extra: string): typeof fetch {
		return async () =>
			new Response(
				`{"id":0,"jsonrpc":"2.0","result":{"integrated_address":"iZTestIntegratedAddress","payment_id":"a1b2c3d4e5f60718",${extra}}}`,
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
	}

	async function mintWith(extra: string) {
		const create = createZanoCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher: walletReturning(extra),
			rate: async () => 1,
		});
		return await create({ productId: 'p1', amount: 0.1, currency: 'ZANO' });
	}

	it('a float whose fraction runs 16 digits or longer', async () => {
		const invoice = await mintWith('"rate":1.2345678901234567');
		expect(invoice.paymentReference).toBe('a1b2c3d4e5f60718');
	});

	it('a large negative integer', async () => {
		const invoice = await mintWith('"offset":-1234567890123456');
		expect(invoice.paymentReference).toBe('a1b2c3d4e5f60718');
	});

	it('a number in exponent form', async () => {
		const invoice = await mintWith('"scaled":1.5e16');
		expect(invoice.paymentReference).toBe('a1b2c3d4e5f60718');
	});

	it('still keeps a bare 64-bit amount exact', async () => {
		const invoice = await mintWith('"balance":18446744073709551615');
		expect(invoice.paymentReference).toBe('a1b2c3d4e5f60718');
	});
});
