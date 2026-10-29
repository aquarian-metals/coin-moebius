import { describe, it, expect, vi } from 'vitest';
import { asPayment } from '@aquarian-metals/coin-moebius-core';
import { createMemoryStore } from '@aquarian-metals/coin-moebius-server';
import type { PaymentStore } from '@aquarian-metals/coin-moebius-server';
import {
	createBitcoinCreator,
	createBitcoinVerifier,
	createBitcoinIndexer,
	computeBitcoinSignature,
	toAtomic,
	fromAtomic,
	formatAtomic,
	roundQuoteUp,
	type BitcoinWebhookPayload,
	type BitcoinLogger,
} from '../src/server.js';

const RPC_URL = 'http://bitcoind.test:8332';
const WALLET = 'shop';
const WEBHOOK_URL = 'http://webhook.test/api/payment-webhook';
const SECRET = 'hmac_secret_unit_tests_only';
const WEBHOOK_TS = 1_700_000_000_000;

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

function txid(seed: string): string {
	return Buffer.from(seed).toString('hex').padEnd(64, '0');
}

interface NodeTx {
	txid: string;
	vout: number;
	address: string;
	/** BTC, the way the node writes it. */
	amount: number;
	/** 0 while in the mempool. */
	height: number;
	category?: string;
	conflicted?: boolean;
}

/**
 * In-process stand-in for `bitcoind` serving one watch-only wallet: labeled
 * addresses from `getnewaddress`, the chain tip, and `listsinceblock`, which
 * returns everything mined after the given block plus the mempool, with
 * confirmation counts the node computes itself.
 */
function makeNode() {
	const state = {
		height: 900_000,
		labels: new Map<string, string>(),
		txs: [] as NodeTx[],
		calls: [] as {
			url: string;
			method: string;
			params: unknown;
			headers: Record<string, string>;
		}[],
	};

	const hashAt = (height: number) => `${height.toString(16).padStart(8, '0')}`.padEnd(64, 'a');
	const heightOf = (hash: string) => parseInt(hash.slice(0, 8), 16);
	const confirmationsOf = (tx: NodeTx) => {
		if (tx.conflicted) return -1;
		return tx.height === 0 ? 0 : state.height - tx.height + 1;
	};

	function handle(method: string, params: unknown): unknown {
		const named = (params ?? {}) as Record<string, unknown>;
		switch (method) {
			case 'getnewaddress': {
				const address = `bcrt1qtest${state.labels.size.toString().padStart(30, '0')}`;
				state.labels.set(address, typeof named.label === 'string' ? named.label : '');
				return address;
			}
			case 'getblockcount':
				return state.height;
			case 'getblockhash':
				return hashAt((params as number[])[0]);
			case 'listsinceblock': {
				const from = heightOf(String(named.blockhash));
				const transactions = state.txs
					.filter((tx) => tx.height === 0 || tx.height > from)
					.map((tx) => ({
						address: tx.address,
						category: tx.category ?? 'receive',
						amount: tx.amount,
						label: state.labels.get(tx.address) ?? '',
						vout: tx.vout,
						confirmations: confirmationsOf(tx),
						...(tx.height > 0
							? { blockhash: hashAt(tx.height), blockheight: tx.height }
							: { trusted: false }),
						txid: tx.txid,
					}));
				return { transactions, removed: [], lastblock: hashAt(state.height) };
			}
			case 'getreceivedbyaddress':
				return state.txs
					.filter((tx) => tx.address === named.address && !tx.conflicted)
					.reduce((sum, tx) => sum + tx.amount, 0);
			default:
				return { __error: `Method not found` };
		}
	}

	const fetcher: typeof fetch = async (input, init) => {
		const url = urlOf(input);
		if (!url.startsWith(RPC_URL)) return new Response('', { status: 404 });
		const request = JSON.parse(bodyString(init)) as { method: string; params: unknown };
		state.calls.push({
			url,
			method: request.method,
			params: request.params,
			headers: headersOf(init),
		});
		const result = handle(request.method, request.params);
		if (typeof result === 'object' && result !== null && '__error' in result) {
			return new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: '0',
					error: { code: -32601, message: String(result.__error) },
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	return { state, fetcher };
}

function withWebhookCapture(
	nodeFetcher: typeof fetch,
	webhookCalls: { body: string; headers: Record<string, string> }[],
	respond: () => Response = () => new Response('', { status: 200 }),
): typeof fetch {
	return async (input, init) => {
		if (urlOf(input) === WEBHOOK_URL) {
			const response = respond();
			if (response.ok) webhookCalls.push({ body: bodyString(init), headers: headersOf(init) });
			return response;
		}
		return nodeFetcher(input, init);
	};
}

function silentLogger(): BitcoinLogger & { warnings: string[] } {
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

describe('computeBitcoinSignature', () => {
	it('produces a hex SHA-256 (64 chars)', async () => {
		expect(await computeBitcoinSignature('{"hello":"world"}', SECRET)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic for the same body + key', async () => {
		expect(await computeBitcoinSignature('{"x":1}', SECRET)).toBe(
			await computeBitcoinSignature('{"x":1}', SECRET),
		);
	});

	it('changes when the body changes', async () => {
		expect(await computeBitcoinSignature('{"x":1}', SECRET)).not.toBe(
			await computeBitcoinSignature('{"x":2}', SECRET),
		);
	});

	it('changes when the key changes', async () => {
		expect(await computeBitcoinSignature('{"x":1}', SECRET)).not.toBe(
			await computeBitcoinSignature('{"x":1}', 'other_secret'),
		);
	});
});

describe('amount conversion', () => {
	it('converts BTC to satoshis', () => {
		expect(toAtomic(1)).toBe('100000000');
		expect(toAtomic(0.00012345)).toBe('12345');
		expect(toAtomic(21_000_000)).toBe('2100000000000000');
	});

	it('rounds anything finer than a satoshi up, never down', () => {
		expect(toAtomic(0.000000001)).toBe('1');
		expect(toAtomic(0.123456781)).toBe('12345679');
	});

	it('reads binary float noise as the number the caller meant', () => {
		expect(toAtomic(0.1 + 0.2)).toBe('30000000');
	});

	it('rejects zero, negative, and non-finite amounts', () => {
		expect(() => toAtomic(0)).toThrow(/must be positive/);
		expect(() => toAtomic(-1)).toThrow(/must be positive/);
		expect(() => toAtomic(Number.NaN)).toThrow(/must be positive/);
	});

	it('formats satoshis as an exact BTC string with no trailing zeros', () => {
		expect(formatAtomic(100_000_000n)).toBe('1');
		expect(formatAtomic(1n)).toBe('0.00000001');
		expect(formatAtomic(12_340_000n)).toBe('0.1234');
		expect(formatAtomic(2_100_000_000_000_000n)).toBe('21000000');
	});

	it('converts satoshis back to a display number', () => {
		expect(fromAtomic(12_345n)).toBe(0.00012345);
	});
});

describe('a quote is rounded to something a buyer can read', () => {
	it('cuts an exact conversion down to six significant digits', () => {
		expect(roundQuoteUp(0.123456789)).toBe(0.123457);
		expect(roundQuoteUp(1.23456789)).toBe(1.23457);
	});

	it('never goes finer than one satoshi', () => {
		expect(roundQuoteUp(1 / 97_123.45)).toBe(0.0000103);
		expect(roundQuoteUp(0.000012345678)).toBe(0.00001235);
		expect(roundQuoteUp(0.000000001)).toBe(0.00000001);
	});

	it('always rounds up, so the merchant is never short', () => {
		for (const amount of [0.000123456789, 0.0004999999, 1.23456789, 0.07777777]) {
			expect(roundQuoteUp(amount)).toBeGreaterThanOrEqual(amount);
		}
	});

	it('leaves an amount that is already readable alone', () => {
		expect(roundQuoteUp(0.001)).toBe(0.001);
		expect(roundQuoteUp(2)).toBe(2);
	});

	it('hands back a nonsense quote untouched rather than throwing', () => {
		expect(roundQuoteUp(0)).toBe(0);
		expect(roundQuoteUp(Number.NaN)).toBeNaN();
	});
});

describe('createBitcoinCreator', () => {
	function setup(btcPerUnit?: (currency: string) => Promise<number>) {
		const node = makeNode();
		const store = createMemoryStore();
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			rpcUser: 'shop',
			rpcPassword: 'pässword',
			store,
			fetcher: node.fetcher,
			btcPerUnit,
		});
		return { node, store, create };
	}

	it('mints a labeled address, persists a pending record, and returns instructions', async () => {
		const ctx = setup();
		const result = await ctx.create({ productId: 'ebook', amount: 0.0015, currency: 'BTC' });

		expect(result.paymentId).toMatch(/^btc_[0-9a-f]{16}$/);
		expect(ctx.node.state.labels.get(result.address)).toBe(result.paymentId);
		expect(result.atomicAmount).toBe('150000');
		expect(result.btcAmount).toBe(0.0015);
		expect(result.uri).toBe(`bitcoin:${result.address}?amount=0.0015`);
		expect(result.expiresAt).toBeGreaterThan(Date.now());

		const record = await ctx.store.get(result.paymentId);
		expect(record?.status).toBe('pending');
		expect(record?.provider).toBe('bitcoin');
		expect(record?.metadata).toMatchObject({
			productId: 'ebook',
			address: result.address,
			atomicAmount: '150000',
		});
	});

	it('keeps checkout metadata but never lets it seed the fields the indexer owns', async () => {
		const ctx = setup();
		const result = await ctx.create({
			productId: 'ebook',
			amount: 0.001,
			currency: 'BTC',
			metadata: {
				email: 'buyer@example.com',
				confirmations: 999,
				txHash: 'forged',
				receivedAtomic: '100000',
				failureReason: 'forged',
				atomicAmount: '1',
				address: 'bc1qattacker',
			},
		});

		const record = await ctx.store.get(result.paymentId);
		expect(record?.metadata.email).toBe('buyer@example.com');
		expect(record?.metadata.atomicAmount).toBe('100000');
		expect(record?.metadata.address).toBe(result.address);
		for (const key of ['confirmations', 'txHash', 'receivedAtomic', 'failureReason']) {
			expect(record?.metadata).not.toHaveProperty(key);
		}
	});

	it('mints a different address and payment id for every checkout', async () => {
		const ctx = setup();
		const a = await ctx.create({ productId: 'p', amount: 0.001, currency: 'BTC' });
		const b = await ctx.create({ productId: 'p', amount: 0.001, currency: 'BTC' });
		expect(a.address).not.toBe(b.address);
		expect(a.paymentId).not.toBe(b.paymentId);
	});

	it('calls the wallet endpoint with HTTP Basic auth', async () => {
		const ctx = setup();
		await ctx.create({ productId: 'p', amount: 0.001, currency: 'BTC' });
		const call = ctx.node.state.calls[0];
		expect(call.url).toBe(`${RPC_URL}/wallet/shop`);
		expect(call.method).toBe('getnewaddress');
		const encoded = call.headers.Authorization.replace('Basic ', '');
		expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('shop:pässword');
	});

	it('sends no Authorization header when no rpcUser is configured', async () => {
		const node = makeNode();
		const create = createBitcoinCreator({
			rpcUrl: `${RPC_URL}/`,
			wallet: 'my shop',
			store: createMemoryStore(),
			fetcher: node.fetcher,
		});
		await create({ productId: 'p', amount: 0.001, currency: 'BTC' });
		expect(node.state.calls[0].url).toBe(`${RPC_URL}/wallet/my%20shop`);
		expect(node.state.calls[0].headers.Authorization).toBeUndefined();
	});

	it('converts a USD invoice through btcPerUnit and quotes the rounded figure', async () => {
		const ctx = setup(async () => 1 / 97_123.45);
		const result = await ctx.create({ productId: 'p', amount: 19.99, currency: 'USD' });
		expect(result.btcAmount).toBe(0.00020583);
		expect(result.atomicAmount).toBe('20583');
		expect(Number(result.atomicAmount)).toBeGreaterThanOrEqual(19.99 / 97_123.45 / 1e-8);
		expect(result.uri.endsWith(`amount=${formatAtomic(BigInt(result.atomicAmount))}`)).toBe(true);
	});

	it('throws when the invoice needs a rate and none was supplied', async () => {
		const ctx = setup();
		await expect(ctx.create({ productId: 'p', amount: 10, currency: 'USD' })).rejects.toThrow(
			/requires btcPerUnit/,
		);
	});

	it('throws when the rate is not positive', async () => {
		const ctx = setup(async () => 0);
		await expect(ctx.create({ productId: 'p', amount: 10, currency: 'USD' })).rejects.toThrow(
			/must be positive/,
		);
	});

	it('propagates node errors with their message', async () => {
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: createMemoryStore(),
			fetcher: async () =>
				new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: '0',
						error: { code: -18, message: 'Requested wallet does not exist or is not loaded' },
					}),
					{ status: 200 },
				),
		});
		await expect(create({ productId: 'p', amount: 0.001, currency: 'BTC' })).rejects.toThrow(
			/getnewaddress error: Requested wallet does not exist/,
		);
	});

	it('reads the error body an older node sends with a 500', async () => {
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: createMemoryStore(),
			fetcher: async () =>
				new Response(
					JSON.stringify({ result: null, error: { code: -4, message: 'Error: No addresses' } }),
					{ status: 500 },
				),
		});
		await expect(create({ productId: 'p', amount: 0.001, currency: 'BTC' })).rejects.toThrow(
			/error: Error: No addresses/,
		);
	});

	it('explains a 401 as a credentials problem', async () => {
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: createMemoryStore(),
			fetcher: async () => new Response('', { status: 401 }),
		});
		await expect(create({ productId: 'p', amount: 0.001, currency: 'BTC' })).rejects.toThrow(
			/refused getnewaddress \(401\)\. Check rpcUser and rpcPassword/,
		);
	});

	it('reports other HTTP failures and empty results plainly', async () => {
		const failing = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: createMemoryStore(),
			fetcher: async () => new Response('Service Unavailable', { status: 503 }),
		});
		await expect(failing({ productId: 'p', amount: 0.001, currency: 'BTC' })).rejects.toThrow(
			/HTTP 503/,
		);

		const empty = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: createMemoryStore(),
			fetcher: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: '0' })),
		});
		await expect(empty({ productId: 'p', amount: 0.001, currency: 'BTC' })).rejects.toThrow(
			/returned no result/,
		);
	});

	it('throws when the wallet returns no address', async () => {
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: createMemoryStore(),
			fetcher: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result: '' })),
		});
		await expect(create({ productId: 'p', amount: 0.001, currency: 'BTC' })).rejects.toThrow(
			/no address/,
		);
	});
});

describe('createBitcoinVerifier', () => {
	function makeWebhookPayload(
		overrides: Partial<BitcoinWebhookPayload> = {},
	): BitcoinWebhookPayload {
		return {
			provider: 'bitcoin',
			paymentId: 'btc_1dfe5a88ff9effb3',
			status: 'success',
			txHash: txid('aabbccdd'),
			address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
			invoiceCurrency: 'USD',
			invoiceAmount: 20,
			expectedAmountAtomic: '20000',
			receivedAmountAtomic: '20000',
			expectedAmountBtc: 0.0002,
			receivedAmountBtc: 0.0002,
			confirmations: 1,
			requiredConfirmations: 1,
			blockHeight: 900_000,
			timestamp: WEBHOOK_TS,
			...overrides,
		};
	}

	const makeVerifier = () => createBitcoinVerifier({ hmacSecret: SECRET, now: () => WEBHOOK_TS });

	it('throws at construction when hmacSecret is missing', () => {
		expect(() => createBitcoinVerifier({ hmacSecret: '' })).toThrow(/hmacSecret missing/);
	});

	it('accepts a correctly-signed success payload and maps it to a payment event', async () => {
		const payload = makeWebhookPayload();
		const sig = await computeBitcoinSignature(JSON.stringify(payload), SECRET);

		const result = asPayment(await makeVerifier().verify(payload, { 'x-bitcoin-sig': sig }));
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe(payload.paymentId);
		expect(result!.provider).toBe('bitcoin');
		expect(result!.amount).toBe(20);
		expect(result!.currency).toBe('USD');
		expect(result!.metadata).toMatchObject({
			address: payload.address,
			txHash: payload.txHash,
			confirmations: 1,
			requiredConfirmations: 1,
			blockHeight: 900_000,
			receivedAmountAtomic: '20000',
		});
	});

	it('maps partial payments to a prorated invoice amount', async () => {
		const payload = makeWebhookPayload({
			status: 'partial',
			invoiceAmount: 100,
			expectedAmountAtomic: '100000',
			receivedAmountAtomic: '60000',
			receivedAmountBtc: 0.0006,
		});
		const sig = await computeBitcoinSignature(JSON.stringify(payload), SECRET);
		const result = asPayment(await makeVerifier().verify(payload, { 'x-bitcoin-sig': sig }));
		expect(result!.status).toBe('partial');
		expect(result!.amount).toBeCloseTo(60, 6);
	});

	it('maps failed payments to amount 0', async () => {
		const payload = makeWebhookPayload({
			status: 'failed',
			txHash: null,
			receivedAmountAtomic: '0',
			receivedAmountBtc: 0,
			confirmations: 0,
			blockHeight: null,
		});
		const sig = await computeBitcoinSignature(JSON.stringify(payload), SECRET);
		const result = asPayment(await makeVerifier().verify(payload, { 'x-bitcoin-sig': sig }));
		expect(result!.status).toBe('failed');
		expect(result!.amount).toBe(0);
	});

	it('rejects a payload with no signature header', async () => {
		await expect(makeVerifier().verify(makeWebhookPayload(), {})).rejects.toThrow(
			/missing x-bitcoin-sig/,
		);
	});

	it('rejects a payload with an invalid signature', async () => {
		const payload = makeWebhookPayload();
		const wrongSig = await computeBitcoinSignature(JSON.stringify(payload), 'wrong_key');
		await expect(makeVerifier().verify(payload, { 'x-bitcoin-sig': wrongSig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a tampered body even with the original signature', async () => {
		const sig = await computeBitcoinSignature(JSON.stringify(makeWebhookPayload()), SECRET);
		const tampered = makeWebhookPayload({ invoiceAmount: 999999 });
		await expect(makeVerifier().verify(tampered, { 'x-bitcoin-sig': sig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a replayed webhook whose signed timestamp is stale', async () => {
		const payload = makeWebhookPayload();
		const sig = await computeBitcoinSignature(JSON.stringify(payload), SECRET);
		const stale = createBitcoinVerifier({
			hmacSecret: SECRET,
			now: () => WEBHOOK_TS + 60 * 60 * 1000,
		});
		await expect(stale.verify(payload, { 'x-bitcoin-sig': sig })).rejects.toThrow(
			/freshness window/,
		);
	});

	it('accepts the body as a raw JSON string identically to a parsed object', async () => {
		const payload = makeWebhookPayload();
		const body = JSON.stringify(payload);
		const sig = await computeBitcoinSignature(body, SECRET);
		const fromObject = asPayment(await makeVerifier().verify(payload, { 'X-Bitcoin-Sig': sig }));
		const fromString = asPayment(await makeVerifier().verify(body, { 'x-bitcoin-sig': sig }));
		expect(fromObject!.paymentId).toBe(fromString!.paymentId);
	});

	it('rejects non-JSON strings and non-object bodies', async () => {
		const sig = await computeBitcoinSignature('not json', SECRET);
		await expect(makeVerifier().verify('not json', { 'x-bitcoin-sig': sig })).rejects.toThrow(
			/not valid JSON/,
		);
		await expect(makeVerifier().verify(42, { 'x-bitcoin-sig': sig })).rejects.toThrow(
			/unsupported body type/,
		);
	});

	it("rejects another provider's message signed with a reused secret", async () => {
		const foreign = { ...makeWebhookPayload(), provider: 'zano' };
		const sig = await computeBitcoinSignature(JSON.stringify(foreign), SECRET);
		await expect(makeVerifier().verify(foreign, { 'x-bitcoin-sig': sig })).rejects.toThrow(
			/not a bitcoin payment/,
		);
	});

	it('passes the product id through to fulfillment', async () => {
		const payload = makeWebhookPayload({ productId: 'ebook-42' });
		const sig = await computeBitcoinSignature(JSON.stringify(payload), SECRET);
		const result = asPayment(await makeVerifier().verify(payload, { 'x-bitcoin-sig': sig }));
		expect(result!.metadata.productId).toBe('ebook-42');
	});
});

describe('createBitcoinIndexer', () => {
	async function setup(opts: { now?: () => number; requiredConfirmations?: number } = {}) {
		const node = makeNode();
		const store = createMemoryStore();
		const webhookCalls: { body: string; headers: Record<string, string> }[] = [];
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			fetcher: node.fetcher,
		});

		const first = await create({ productId: 'p1', amount: 0.001, currency: 'BTC' });
		const second = await create({ productId: 'p2', amount: 0.0025, currency: 'BTC' });

		const logger = silentLogger();
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: opts.requiredConfirmations ?? 3,
			fetcher: withWebhookCapture(node.fetcher, webhookCalls),
			logger,
			now: opts.now,
		});

		let counter = 0;
		function pay(
			invoice: { address: string },
			input: { amount: number; height?: number; hash?: string; vout?: number } = {
				amount: 0.001,
			},
		) {
			counter += 1;
			const tx: NodeTx = {
				txid: txid(input.hash ?? `tx${counter}`),
				vout: input.vout ?? 0,
				address: invoice.address,
				amount: input.amount,
				height: input.height ?? node.state.height - 2,
			};
			node.state.txs.push(tx);
			return tx;
		}

		return { node, store, webhookCalls, indexer, logger, first, second, pay };
	}

	function lastPayload(ctx: { webhookCalls: { body: string }[] }): BitcoinWebhookPayload {
		return JSON.parse(ctx.webhookCalls.at(-1)!.body) as BitcoinWebhookPayload;
	}

	it('tick(): settles a fully-confirmed payment and POSTs a signed webhook', async () => {
		const ctx = await setup();
		ctx.pay(ctx.first, { amount: 0.001 });

		const result = await ctx.indexer.tick();
		expect(result.walletHeight).toBe(ctx.node.state.height);
		expect(result.transfersInspected).toBe(1);
		expect(result.webhooksSent).toBe(1);
		expect(result.errors).toEqual([]);

		const payload = lastPayload(ctx);
		expect(payload.status).toBe('success');
		expect(payload.paymentId).toBe(ctx.first.paymentId);
		expect(payload.address).toBe(ctx.first.address);
		expect(payload.confirmations).toBe(3);
		expect(payload.requiredConfirmations).toBe(3);
		expect(payload.blockHeight).toBe(ctx.node.state.height - 2);
		expect(payload.receivedAmountAtomic).toBe('100000');
		expect(payload.receivedAmountBtc).toBe(0.001);

		expect(ctx.webhookCalls[0].headers['x-bitcoin-sig']).toBe(
			await computeBitcoinSignature(ctx.webhookCalls[0].body, SECRET),
		);
		expect(ctx.webhookCalls[0].headers['x-provider']).toBe('bitcoin');
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('success');
		expect((await ctx.store.get(ctx.second.paymentId))?.status).toBe('pending');
	});

	it('tick(): settles on one confirmation by default', async () => {
		const node = makeNode();
		const store = createMemoryStore();
		const webhookCalls: { body: string; headers: Record<string, string> }[] = [];
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			fetcher: node.fetcher,
		});
		const invoice = await create({ productId: 'p', amount: 0.001, currency: 'BTC' });
		node.state.txs.push({
			txid: txid('one'),
			vout: 0,
			address: invoice.address,
			amount: 0.001,
			height: node.state.height,
		});
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(node.fetcher, webhookCalls),
		});

		await indexer.tick();
		expect(lastPayload({ webhookCalls }).status).toBe('success');
		expect(lastPayload({ webhookCalls }).requiredConfirmations).toBe(1);
	});

	it('tick(): reports a payment in the mempool as seen with zero confirmations', async () => {
		const ctx = await setup();
		ctx.pay(ctx.first, { amount: 0.001, height: 0 });

		await ctx.indexer.tick();
		const payload = lastPayload(ctx);
		expect(payload.status).toBe('pending');
		expect(payload.confirmations).toBe(0);
		expect(payload.blockHeight).toBeNull();
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('pending');
	});

	it('tick(): reports an under-confirmed payment without settling it, then only when the count moves', async () => {
		const ctx = await setup();
		ctx.pay(ctx.first, { amount: 0.001, height: ctx.node.state.height });

		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('pending');
		expect(lastPayload(ctx).confirmations).toBe(1);

		await ctx.indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(1);

		ctx.node.state.height += 1;
		await ctx.indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(2);
		expect(lastPayload(ctx).confirmations).toBe(2);

		ctx.node.state.height += 1;
		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('success');
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('success');
	});

	it('tick(): marks an underpaid confirmed payment as partial', async () => {
		const ctx = await setup();
		ctx.pay(ctx.second, { amount: 0.001 });

		await ctx.indexer.tick();
		const payload = lastPayload(ctx);
		expect(payload.status).toBe('partial');
		expect(payload.expectedAmountAtomic).toBe('250000');
		expect(payload.receivedAmountAtomic).toBe('100000');
		const record = await ctx.store.get(ctx.second.paymentId);
		expect(record?.status).toBe('partial');
		expect(record?.amount).toBeCloseTo(0.001, 10);
	});

	it('tick(): settles a partial order once the rest arrives and confirms', async () => {
		const ctx = await setup();
		ctx.pay(ctx.second, { amount: 0.001 });
		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('partial');

		ctx.pay(ctx.second, { amount: 0.0015, hash: 'rest' });
		await ctx.indexer.tick();
		const payload = lastPayload(ctx);
		expect(payload.status).toBe('success');
		expect(payload.receivedAmountAtomic).toBe('250000');
		const record = await ctx.store.get(ctx.second.paymentId);
		expect(record?.status).toBe('success');
		expect(record?.amount).toBeCloseTo(0.0025, 10);
	});

	it('tick(): sums several payments to one address and gates on the slowest', async () => {
		const ctx = await setup();
		ctx.pay(ctx.second, { amount: 0.0015, height: ctx.node.state.height - 5 });
		ctx.pay(ctx.second, { amount: 0.001, height: ctx.node.state.height });

		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('pending');
		expect(lastPayload(ctx).confirmations).toBe(1);
		expect(lastPayload(ctx).receivedAmountAtomic).toBe('250000');
		expect(lastPayload(ctx).blockHeight).toBe(ctx.node.state.height - 5);

		ctx.node.state.height += 2;
		await ctx.indexer.tick();
		expect(lastPayload(ctx).status).toBe('success');
	});

	it('tick(): counts two outputs of one transaction to the same address separately', async () => {
		const ctx = await setup();
		ctx.pay(ctx.second, { amount: 0.002, hash: 'split', vout: 0 });
		ctx.pay(ctx.second, { amount: 0.0005, hash: 'split', vout: 1 });

		const result = await ctx.indexer.tick();
		expect(result.transfersInspected).toBe(2);
		expect(lastPayload(ctx).status).toBe('success');
		expect(lastPayload(ctx).receivedAmountAtomic).toBe('250000');
	});

	it('tick(): reads every amount up to the full supply exactly', async () => {
		const ctx = await setup();
		ctx.pay(ctx.first, { amount: 20_999_999.99999999 });

		await ctx.indexer.tick();
		expect(lastPayload(ctx).receivedAmountAtomic).toBe('2099999999999999');
	});

	it('tick(): never counts a conflicted (double-spent) transaction', async () => {
		const ctx = await setup();
		const tx = ctx.pay(ctx.first, { amount: 0.001, height: 0 });
		tx.conflicted = true;

		const result = await ctx.indexer.tick();
		expect(result.transfersInspected).toBe(0);
		expect(ctx.webhookCalls).toHaveLength(0);
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('pending');
	});

	it('tick(): ignores mined coins, unlabeled addresses, and labels the store does not know', async () => {
		const ctx = await setup();
		const mined = ctx.pay(ctx.first, { amount: 0.001 });
		mined.category = 'generate';
		ctx.node.state.txs.push({
			txid: txid('stranger'),
			vout: 0,
			address: 'bcrt1qsomeoneelse',
			amount: 1,
			height: ctx.node.state.height - 2,
		});
		ctx.node.state.labels.set('bcrt1qunknown', 'btc_0000000000000000');
		ctx.node.state.txs.push({
			txid: txid('unknown'),
			vout: 0,
			address: 'bcrt1qunknown',
			amount: 1,
			height: ctx.node.state.height - 2,
		});

		const result = await ctx.indexer.tick();
		expect(result.transfersInspected).toBe(1);
		expect(result.webhooksSent).toBe(0);
		expect(result.errors).toEqual([]);
	});

	it('tick(): ignores money on a labeled address that is not the address the invoice holds', async () => {
		const ctx = await setup();
		ctx.node.state.labels.set('bcrt1qrelabeled', ctx.first.paymentId);
		ctx.node.state.txs.push({
			txid: txid('relabeled'),
			vout: 0,
			address: 'bcrt1qrelabeled',
			amount: 0.001,
			height: ctx.node.state.height - 2,
		});

		await ctx.indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(0);
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('pending');
	});

	it('tick(): reads history from the lookback depth below the tip', async () => {
		const ctx = await setup();
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 3,
			scanLookbackBlocks: 10,
			fetcher: withWebhookCapture(ctx.node.fetcher, ctx.webhookCalls),
		});

		await indexer.tick();
		const hashCall = ctx.node.state.calls.find((c) => c.method === 'getblockhash');
		expect(hashCall?.params).toEqual([ctx.node.state.height - 13]);
	});

	it('tick(): expiry sweep marks unpaid expired invoices as failed through listPending', async () => {
		let currentTime = 1_700_000_000_000;
		const ctx = await setup({ now: () => currentTime });
		ctx.pay(ctx.second, { amount: 0.0025, height: 0 });

		currentTime = Math.max(ctx.first.expiresAt, ctx.second.expiresAt) + 1000;
		const result = await ctx.indexer.tick();

		const payloads = ctx.webhookCalls.map((c) => JSON.parse(c.body) as BitcoinWebhookPayload);
		expect(payloads.map((p) => p.status).sort()).toEqual(['failed', 'pending']);
		expect(result.webhooksSent).toBe(2);

		const failed = payloads.find((p) => p.status === 'failed')!;
		expect(failed.paymentId).toBe(ctx.first.paymentId);
		expect(failed.txHash).toBeNull();
		expect(failed.receivedAmountAtomic).toBe('0');
		const record = await ctx.store.get(ctx.first.paymentId);
		expect(record?.status).toBe('failed');
		expect(record?.metadata.failureReason).toBe('expired');
		expect((await ctx.store.get(ctx.second.paymentId))?.status).toBe('pending');
		expect(ctx.indexer.status().pendingPaymentCount).toBe(1);
	});

	it('tick(): never fails an invoice whose money landed outside the lookback window', async () => {
		let currentTime = 1_700_000_000_000;
		const ctx = await setup({ now: () => currentTime });
		ctx.pay(ctx.first, { amount: 0.001, height: ctx.node.state.height - 1000 });

		currentTime = ctx.first.expiresAt + 1000;
		await ctx.indexer.tick();

		expect(
			ctx.webhookCalls.map((c) => (JSON.parse(c.body) as BitcoinWebhookPayload).paymentId),
		).not.toContain(ctx.first.paymentId);
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('pending');
		expect(ctx.logger.warnings.some((w) => w.includes('raise scanLookbackBlocks'))).toBe(true);
	});

	it('tick(): settles an expired invoice whose money turns up later', async () => {
		let currentTime = 1_700_000_000_000;
		const ctx = await setup({ now: () => currentTime });

		currentTime = ctx.first.expiresAt + 1000;
		await ctx.indexer.tick();
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('failed');

		ctx.pay(ctx.first, { amount: 0.001, height: ctx.node.state.height - 5 });
		currentTime += 2 * 24 * 60 * 60 * 1000;
		await ctx.indexer.tick();

		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('success');
		const settled = ctx.webhookCalls
			.map((c) => JSON.parse(c.body) as BitcoinWebhookPayload)
			.filter((pl) => pl.paymentId === ctx.first.paymentId && pl.status === 'success');
		expect(settled).toHaveLength(1);
	});

	it('tick(): leaves unpaid invoices pending and warns once when the store cannot list them', async () => {
		let currentTime = 1_700_000_000_000;
		const ctx = await setup({ now: () => currentTime });
		const noListStore: PaymentStore = {
			upsert: ctx.store.upsert.bind(ctx.store),
			get: ctx.store.get.bind(ctx.store),
		};
		const logger = silentLogger();
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: noListStore,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(ctx.node.fetcher, ctx.webhookCalls),
			logger,
			now: () => currentTime,
		});

		currentTime = ctx.first.expiresAt + 1000;
		await indexer.tick();
		await indexer.tick();

		expect(ctx.webhookCalls).toHaveLength(0);
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('pending');
		expect(logger.warnings.filter((w) => w.includes('listPending'))).toHaveLength(1);
	});

	it('tick(): does not re-emit webhooks for already-announced payments (uses markStatusAnnounced)', async () => {
		const ctx = await setup();
		ctx.pay(ctx.first, { amount: 0.001 });

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
		ctx.pay(ctx.first, { amount: 0.001 });
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: plainStore,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 3,
			fetcher: withWebhookCapture(ctx.node.fetcher, ctx.webhookCalls),
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

	it('tick(): retries webhook delivery on transient failures', async () => {
		const ctx = await setup();
		ctx.pay(ctx.first, { amount: 0.001 });
		let attempts = 0;
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(ctx.node.fetcher, ctx.webhookCalls, () => {
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
		ctx.pay(ctx.first, { amount: 0.001 });
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(
				ctx.node.fetcher,
				ctx.webhookCalls,
				() => new Response('', { status: 500 }),
			),
			logger: silentLogger(),
			webhookRetry: { maxAttempts: 2, initialBackoffMs: 1 },
		});

		const result = await indexer.tick();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(indexer.status().webhookErrorCount).toBe(1);
		expect(indexer.status().lastError?.message).toContain('webhook responded 500');
	});

	it('tick(): records lastError when the node itself fails', async () => {
		const ctx = await setup();
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
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

	it('tick(): fails plainly when the node reports no height', async () => {
		const ctx = await setup();
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: async () =>
				new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result: 'tip' }), { status: 200 }),
		});
		const result = await indexer.tick();
		expect(result.errors[0]).toContain('no block height');
	});

	it('start()/stop(): polls on the configured interval and stops cleanly', async () => {
		vi.useFakeTimers();
		try {
			const ctx = await setup();
			const indexer = createBitcoinIndexer({
				rpcUrl: RPC_URL,
				wallet: WALLET,
				store: ctx.store,
				webhookUrl: WEBHOOK_URL,
				hmacSecret: SECRET,
				fetcher: withWebhookCapture(ctx.node.fetcher, ctx.webhookCalls),
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
			createBitcoinIndexer({
				rpcUrl: RPC_URL,
				wallet: WALLET,
				store: createMemoryStore(),
				webhookUrl: WEBHOOK_URL,
				hmacSecret: '',
			}),
		).toThrow(/hmacSecret missing/);
	});

	it('refuses to settle payments that are still in the mempool', () => {
		for (const requiredConfirmations of [0, -1, 0.5, Number.NaN]) {
			expect(() =>
				createBitcoinIndexer({
					rpcUrl: RPC_URL,
					wallet: WALLET,
					store: createMemoryStore(),
					webhookUrl: WEBHOOK_URL,
					hmacSecret: SECRET,
					requiredConfirmations,
				}),
			).toThrow(/at least 1/);
		}
	});

	it('tick(): settles a late payment on an expired invoice even when the store cannot claim announcements', async () => {
		let currentTime = 1_700_000_000_000;
		const ctx = await setup({ now: () => currentTime });
		const plainStore: PaymentStore = {
			upsert: ctx.store.upsert.bind(ctx.store),
			get: ctx.store.get.bind(ctx.store),
			listPending: ctx.store.listPending!.bind(ctx.store),
		};
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: plainStore,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(ctx.node.fetcher, ctx.webhookCalls),
			logger: silentLogger(),
			now: () => currentTime,
		});

		currentTime = ctx.first.expiresAt + 1000;
		await indexer.tick();
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('failed');
		await indexer.tick();
		const failures = ctx.webhookCalls
			.map((c) => JSON.parse(c.body) as BitcoinWebhookPayload)
			.filter((pl) => pl.paymentId === ctx.first.paymentId && pl.status === 'failed');
		expect(failures).toHaveLength(1);

		ctx.pay(ctx.first, { amount: 0.001 });
		await indexer.tick();
		expect((await ctx.store.get(ctx.first.paymentId))?.status).toBe('success');
		await indexer.tick();
		const settled = ctx.webhookCalls
			.map((c) => JSON.parse(c.body) as BitcoinWebhookPayload)
			.filter((pl) => pl.paymentId === ctx.first.paymentId && pl.status === 'success');
		expect(settled).toHaveLength(1);
	});
});

/**
 * Attacks found in review, held down here so they cannot come back.
 */
describe('adversarial review findings', () => {
	async function shop(opts: { requiredConfirmations?: number } = {}) {
		const node = makeNode();
		const store = createMemoryStore();
		const webhookCalls: { body: string; headers: Record<string, string> }[] = [];
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			fetcher: node.fetcher,
		});
		const invoice = await create({ productId: 'ebook-42', amount: 0.0002, currency: 'BTC' });
		const logger = silentLogger();
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: opts.requiredConfirmations ?? 1,
			fetcher: withWebhookCapture(node.fetcher, webhookCalls),
			logger,
		});
		const pay = (amount: number, height: number, hash: string) =>
			node.state.txs.push({ txid: txid(hash), vout: 0, address: invoice.address, amount, height });
		return { node, store, webhookCalls, invoice, indexer, pay };
	}

	it('settles an order whose store hands the amount back as a number', async () => {
		const ctx = await shop();
		const record = (await ctx.store.get(ctx.invoice.paymentId))!;
		await ctx.store.upsert({ ...record, metadata: { ...record.metadata, atomicAmount: 20000 } });
		ctx.pay(0.0002, ctx.node.state.height, 'full');

		await ctx.indexer.tick();
		expect((await ctx.store.get(ctx.invoice.paymentId))?.status).toBe('success');
	});

	it('keeps the invoice amount when a failed event wrote 0 over the record', async () => {
		const ctx = await shop();
		const record = (await ctx.store.get(ctx.invoice.paymentId))!;
		await ctx.store.upsert({ ...record, status: 'failed', amount: 0 });
		ctx.pay(0.0002, ctx.node.state.height, 'late');

		await ctx.indexer.tick();
		const settled = JSON.parse(ctx.webhookCalls.at(-1)!.body) as BitcoinWebhookPayload;
		expect(settled.status).toBe('success');
		expect(settled.invoiceAmount).toBe(0.0002);
		expect((await ctx.store.get(ctx.invoice.paymentId))?.amount).toBe(0.0002);
	});

	it('never settles dust as paid when the stored invoice amount was overwritten', async () => {
		const ctx = await shop();
		const record = (await ctx.store.get(ctx.invoice.paymentId))!;
		await ctx.store.upsert({
			...record,
			metadata: { address: ctx.invoice.address, txHash: null, confirmations: 0 },
		});
		ctx.pay(0.00001, ctx.node.state.height, 'dust');

		const result = await ctx.indexer.tick();

		expect((await ctx.store.get(ctx.invoice.paymentId))?.status).toBe('pending');
		expect(
			ctx.webhookCalls.map((c) => (JSON.parse(c.body) as BitcoinWebhookPayload).status),
		).not.toContain('success');
		expect(result.errors.join(' ')).toContain('no atomicAmount');
	});

	it('settles a confirmed full payment even while a later output is still unconfirmed', async () => {
		const ctx = await shop();
		ctx.pay(0.0002, ctx.node.state.height, 'full');
		ctx.pay(0.0000033, 0, 'stuck-dust');

		await ctx.indexer.tick();

		expect((await ctx.store.get(ctx.invoice.paymentId))?.status).toBe('success');
		const settled = JSON.parse(ctx.webhookCalls.at(-1)!.body) as BitcoinWebhookPayload;
		expect(settled.status).toBe('success');
		expect(settled.receivedAmountAtomic).toBe('20000');
		expect(settled.confirmations).toBe(1);
	});

	it('still waits on an unconfirmed output before calling a short payment partial', async () => {
		const ctx = await shop();
		ctx.pay(0.0001, ctx.node.state.height, 'half');
		ctx.pay(0.0001, 0, 'other-half');

		await ctx.indexer.tick();
		expect((await ctx.store.get(ctx.invoice.paymentId))?.status).toBe('pending');

		ctx.node.state.txs[1].height = ctx.node.state.height + 1;
		ctx.node.state.height += 1;
		await ctx.indexer.tick();
		expect((await ctx.store.get(ctx.invoice.paymentId))?.status).toBe('success');
	});

	it('names the product on every webhook it sends', async () => {
		const ctx = await shop();
		ctx.pay(0.0002, ctx.node.state.height, 'full');
		await ctx.indexer.tick();
		const payload = JSON.parse(ctx.webhookCalls.at(-1)!.body) as BitcoinWebhookPayload;
		expect(payload.productId).toBe('ebook-42');
	});

	it('gives up on a webhook endpoint that never answers instead of stalling the tick', async () => {
		const ctx = await shop();
		ctx.pay(0.0002, ctx.node.state.height, 'full');
		const hanging: typeof fetch = async (input, init) => {
			if (urlOf(input) !== WEBHOOK_URL) return ctx.node.fetcher(input, init);
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
			});
		};
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: hanging,
			requestTimeoutMs: 20,
			webhookRetry: { maxAttempts: 1, initialBackoffMs: 0 },
			logger: silentLogger(),
		});

		const result = await indexer.tick();
		expect(result.errors.length).toBe(1);
		expect((await ctx.store.get(ctx.invoice.paymentId))?.status).toBe('pending');
	});
});

describe('announcement survives a failed webhook delivery', () => {
	async function settleWith(respond: () => Response) {
		const node = makeNode();
		const store = createMemoryStore();
		const webhookCalls: { body: string; headers: Record<string, string> }[] = [];
		const create = createBitcoinCreator({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			fetcher: node.fetcher,
		});
		const invoice = await create({ productId: 'p1', amount: 0.001, currency: 'BTC' });
		const indexer = createBitcoinIndexer({
			rpcUrl: RPC_URL,
			wallet: WALLET,
			store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher: withWebhookCapture(node.fetcher, webhookCalls, respond),
			logger: silentLogger(),
			webhookRetry: { maxAttempts: 1, initialBackoffMs: 0 },
		});
		node.state.txs.push({
			txid: txid('tx1'),
			vout: 0,
			address: invoice.address,
			amount: 0.001,
			height: node.state.height - 2,
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
		const payload = JSON.parse(ctx.webhookCalls[0].body) as BitcoinWebhookPayload;
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
