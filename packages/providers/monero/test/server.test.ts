import { describe, it, expect, vi } from 'vitest';
import { asPayment } from '@aquarian-metals/coin-moebius-core';
import { createMemoryStore } from '@aquarian-metals/coin-moebius-server';
import type { PaymentStore } from '@aquarian-metals/coin-moebius-server';
import {
	createMoneroCreator,
	createMoneroVerifier,
	createMoneroIndexer,
	computeMoneroSignature,
	type MoneroWebhookPayload,
} from '../src/server.js';

const WALLET_URL = 'http://wallet-rpc.test';
const WEBHOOK_URL = 'http://webhook.test/api/payment-webhook';
const SECRET = 'hmac_secret_unit_tests_only';

/**
 * Normalize a fetch `RequestInfo | URL` input down to a plain URL
 * string for dispatch. `Request#toString` falls back to the default
 * object stringification — handle each branch explicitly instead.
 */
function urlOf(input: RequestInfo | URL): string {
	if (typeof input === 'string') return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function bodyString(init?: RequestInit): string {
	const body = init?.body;
	return typeof body === 'string' ? body : '';
}

/**
 * Builds a wallet-RPC fetcher backed by a dispatch table keyed on the
 * JSON-RPC method name. Lets each test stub only the methods it cares
 * about and assert on the calls made.
 */
function makeWalletFetcher(
	handlers: Record<string, (params: unknown) => unknown>,
	calls?: Array<{ method: string; params: unknown }>,
): typeof fetch {
	const impl: typeof fetch = async (input, init) => {
		const url = urlOf(input);
		if (url.endsWith('/json_rpc')) {
			const body = JSON.parse(bodyString(init)) as {
				method: string;
				params: unknown;
			};
			calls?.push({ method: body.method, params: body.params });
			const handler = handlers[body.method];
			if (!handler) {
				return new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: '0',
						error: { code: -1, message: `no handler for ${body.method}` },
					}),
					{ status: 200 },
				);
			}
			const result = handler(body.params);
			return new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		// Webhook delivery — default OK
		return new Response('', { status: 200 });
	};
	return impl;
}

describe('computeMoneroSignature', () => {
	it('produces a hex SHA-256 (64 chars)', async () => {
		const sig = await computeMoneroSignature('{"hello":"world"}', SECRET);
		expect(sig).toMatch(/^[0-9a-f]{64}$/);
	});

	it('is deterministic for the same body + key', async () => {
		const a = await computeMoneroSignature('{"x":1}', SECRET);
		const b = await computeMoneroSignature('{"x":1}', SECRET);
		expect(a).toBe(b);
	});

	it('changes when the body changes', async () => {
		const a = await computeMoneroSignature('{"x":1}', SECRET);
		const b = await computeMoneroSignature('{"x":2}', SECRET);
		expect(a).not.toBe(b);
	});

	it('changes when the key changes', async () => {
		const a = await computeMoneroSignature('{"x":1}', SECRET);
		const b = await computeMoneroSignature('{"x":1}', 'other_secret');
		expect(a).not.toBe(b);
	});
});

describe('createMoneroCreator', () => {
	it('mints a subaddress via wallet RPC, persists a pending record, and returns instructions', async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const fetcher = makeWalletFetcher(
			{
				create_address: () => ({
					address: '8AVAR4iVqEKZApGAMRpMNNDg9wnH2ANEvgyKBcGcqWy',
					address_index: 7,
				}),
			},
			calls,
		);
		const store = createMemoryStore();

		const create = createMoneroCreator({
			walletRpcUrl: WALLET_URL,
			store,
			fetcher,
		});

		const result = await create({
			productId: 'pro',
			amount: 0.1,
			currency: 'XMR',
		});

		expect(result.address).toBe('8AVAR4iVqEKZApGAMRpMNNDg9wnH2ANEvgyKBcGcqWy');
		expect(result.addressIndex).toBe(7);
		expect(result.atomicAmount).toBe('100000000000');
		expect(result.xmrAmount).toBe(0.1);
		expect(result.uri).toBe('monero:8AVAR4iVqEKZApGAMRpMNNDg9wnH2ANEvgyKBcGcqWy?tx_amount=0.1');
		expect(result.expiresAt).toBeGreaterThan(Date.now());

		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe('create_address');
		expect(calls[0].params).toMatchObject({ account_index: 0 });
		expect((calls[0].params as { label: string }).label).toBe(result.paymentId);

		const record = await store.get(result.paymentId);
		expect(record).not.toBeNull();
		expect(record?.status).toBe('pending');
		expect(record?.metadata.address).toBe(result.address);
		expect(record?.metadata.atomicAmount).toBe('100000000000');
		expect(record?.metadata.addressIndex).toBe(7);
	});

	it('honors a custom accountIndex', async () => {
		const calls: Array<{ method: string; params: unknown }> = [];
		const fetcher = makeWalletFetcher(
			{
				create_address: () => ({ address: 'addr', address_index: 1 }),
			},
			calls,
		);
		const create = createMoneroCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			accountIndex: 3,
			fetcher,
		});

		await create({ productId: 'p', amount: 0.5, currency: 'XMR' });
		expect((calls[0].params as { account_index: number }).account_index).toBe(3);
	});

	it('converts a non-XMR invoice using xmrPerUnit', async () => {
		const fetcher = makeWalletFetcher({
			create_address: () => ({ address: 'addr', address_index: 0 }),
		});
		const create = createMoneroCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher,
			xmrPerUnit: async (cur) => {
				// 1 USD = 0.00625 XMR (XMR price = $160)
				if (cur === 'USD') return 0.00625;
				return 0;
			},
		});

		const result = await create({ productId: 'p', amount: 16, currency: 'USD' });
		expect(result.xmrAmount).toBe(0.1);
		expect(result.atomicAmount).toBe('100000000000');
	});

	it('throws when invoice is non-XMR but xmrPerUnit was not supplied', async () => {
		const fetcher = makeWalletFetcher({
			create_address: () => ({ address: 'addr', address_index: 0 }),
		});
		const create = createMoneroCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher,
		});

		await expect(create({ productId: 'p', amount: 16, currency: 'USD' })).rejects.toThrow(
			/requires xmrPerUnit/,
		);
	});

	it('throws when xmrPerUnit returns a non-positive rate', async () => {
		const fetcher = makeWalletFetcher({
			create_address: () => ({ address: 'addr', address_index: 0 }),
		});
		const create = createMoneroCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher,
			xmrPerUnit: async () => 0,
		});

		await expect(create({ productId: 'p', amount: 16, currency: 'USD' })).rejects.toThrow(
			/must be positive/,
		);
	});

	it('propagates wallet-rpc errors', async () => {
		const fetcher: typeof fetch = async () =>
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: '0',
					error: { code: -1, message: 'wallet locked' },
				}),
				{ status: 200 },
			);

		const create = createMoneroCreator({
			walletRpcUrl: WALLET_URL,
			store: createMemoryStore(),
			fetcher,
		});

		await expect(create({ productId: 'p', amount: 0.1, currency: 'XMR' })).rejects.toThrow(
			/wallet locked/,
		);
	});
});

describe('createMoneroVerifier', () => {
	function makeWebhookPayload(overrides: Partial<MoneroWebhookPayload> = {}): MoneroWebhookPayload {
		return {
			provider: 'monero',
			paymentId: 'xmr_pro_1700000000000_abcd1234',
			status: 'success',
			txHash: 'aabbccddee112233',
			address: '8AVAR4iVqEKZApGAMRpMNNDg9wnH2ANEvgyKBcGcqWy',
			invoiceCurrency: 'USD',
			invoiceAmount: 16,
			expectedAmountAtomic: '100000000000',
			receivedAmountAtomic: '100000000000',
			expectedAmountXmr: 0.1,
			receivedAmountXmr: 0.1,
			confirmations: 10,
			blockHeight: 3000000,
			timestamp: 1_700_000_000_000,
			...overrides,
		};
	}

	it('throws at construction when hmacSecret is missing', () => {
		expect(() => createMoneroVerifier({ hmacSecret: '' })).toThrow(/hmacSecret missing/);
	});

	it('accepts a correctly-signed success payload and maps it to PaymentResult', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		const payload = makeWebhookPayload();
		const sig = await computeMoneroSignature(JSON.stringify(payload), SECRET);

		const result = asPayment(await verifier.verify(payload, { 'x-monero-sig': sig }));
		expect(result!.status).toBe('success');
		expect(result!.paymentId).toBe(payload.paymentId);
		expect(result!.provider).toBe('monero');
		expect(result!.amount).toBe(16);
		expect(result!.currency).toBe('USD');
		expect(result!.metadata).toMatchObject({
			address: payload.address,
			txHash: payload.txHash,
			confirmations: 10,
		});
	});

	it('maps partial payments to a prorated invoice amount', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		const payload = makeWebhookPayload({
			status: 'partial',
			invoiceAmount: 100,
			expectedAmountAtomic: '100000000000',
			receivedAmountAtomic: '60000000000',
			receivedAmountXmr: 0.06,
		});
		const sig = await computeMoneroSignature(JSON.stringify(payload), SECRET);

		const result = asPayment(await verifier.verify(payload, { 'x-monero-sig': sig }));
		expect(result!.status).toBe('partial');
		expect(result!.amount).toBeCloseTo(60, 6);
	});

	it('maps failed payments to amount 0', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		const payload = makeWebhookPayload({
			status: 'failed',
			txHash: null,
			receivedAmountAtomic: '0',
			receivedAmountXmr: 0,
			confirmations: 0,
			blockHeight: null,
		});
		const sig = await computeMoneroSignature(JSON.stringify(payload), SECRET);

		const result = asPayment(await verifier.verify(payload, { 'x-monero-sig': sig }));
		expect(result!.status).toBe('failed');
		expect(result!.amount).toBe(0);
	});

	it('rejects a payload with no signature header', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		await expect(verifier.verify(makeWebhookPayload(), {})).rejects.toThrow(/missing x-monero-sig/);
	});

	it('rejects a payload with an invalid signature', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		const payload = makeWebhookPayload();
		const wrongSig = await computeMoneroSignature(JSON.stringify(payload), 'wrong_key');
		await expect(verifier.verify(payload, { 'x-monero-sig': wrongSig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a tampered body even with the original signature', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		const sig = await computeMoneroSignature(JSON.stringify(makeWebhookPayload()), SECRET);
		const tampered = makeWebhookPayload({ invoiceAmount: 999999 });
		await expect(verifier.verify(tampered, { 'x-monero-sig': sig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('accepts the body as a raw JSON string identically to a parsed object', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		const payload = makeWebhookPayload();
		const bodyString = JSON.stringify(payload);
		const sig = await computeMoneroSignature(bodyString, SECRET);

		const fromObject = asPayment(await verifier.verify(payload, { 'x-monero-sig': sig }));
		const fromString = asPayment(await verifier.verify(bodyString, { 'x-monero-sig': sig }));
		expect(fromObject!.paymentId).toBe(fromString!.paymentId);
	});

	it('rejects non-JSON, non-object bodies', async () => {
		const verifier = createMoneroVerifier({ hmacSecret: SECRET });
		const sig = await computeMoneroSignature('not json', SECRET);
		await expect(verifier.verify('not json', { 'x-monero-sig': sig })).rejects.toThrow(
			/not valid JSON/,
		);
	});
});

describe('createMoneroIndexer', () => {
	/**
	 * Build a fully-seeded indexer + store + creator with two pending
	 * payments — one that we'll confirm, one that we'll leave to expire.
	 * Returns the bits each test needs to assert against.
	 */
	async function setupTwoPayments(
		opts: { now: () => number; xmrPerUnit?: (c: string) => Promise<number> } = {
			now: () => 1_700_000_000_000,
		},
	) {
		const store = createMemoryStore();
		const calls: Array<{ method: string; params: unknown }> = [];
		const webhookCalls: Array<{ body: string; headers: Record<string, string> }> = [];

		let nextAddressIndex = 0;
		const createdAddresses = new Map<number, { address: string; label: string }>();

		const walletFetcher = makeWalletFetcher(
			{
				create_address: (params: unknown) => {
					const p = params as { account_index: number; label: string };
					const idx = nextAddressIndex++;
					const address = `8addr_${idx}`;
					createdAddresses.set(idx, { address, label: p.label });
					return { address, address_index: idx };
				},
			},
			calls,
		);
		const create = createMoneroCreator({
			walletRpcUrl: WALLET_URL,
			store,
			fetcher: walletFetcher,
			...(opts.xmrPerUnit ? { xmrPerUnit: opts.xmrPerUnit } : {}),
		});

		const payment1 = await create({ productId: 'p1', amount: 0.1, currency: 'XMR' });
		const payment2 = await create({ productId: 'p2', amount: 0.2, currency: 'XMR' });

		const indexerFetcher: typeof fetch = async (input, init) => {
			const url = urlOf(input);
			if (url === WEBHOOK_URL) {
				webhookCalls.push({
					body: bodyString(init),
					headers: (init?.headers as Record<string, string>) ?? {},
				});
				return new Response('', { status: 200 });
			}
			return walletFetcher(input, init);
		};

		return {
			store,
			payment1,
			payment2,
			createdAddresses,
			calls,
			webhookCalls,
			walletFetcher,
			indexerFetcher,
		};
	}

	function withWalletHandlers(
		baseFetcher: typeof fetch,
		handlers: Record<string, (params: unknown) => unknown>,
		walletCalls?: Array<{ method: string; params: unknown }>,
	): typeof fetch {
		return async (input, init) => {
			const url = urlOf(input);
			if (url.endsWith('/json_rpc')) {
				const body = JSON.parse(bodyString(init)) as {
					method: string;
					params: unknown;
				};
				walletCalls?.push({ method: body.method, params: body.params });
				const handler = handlers[body.method];
				if (handler) {
					const result = handler(body.params);
					return new Response(JSON.stringify({ jsonrpc: '2.0', id: '0', result }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					});
				}
			}
			return baseFetcher(input, init);
		};
	}

	it('tick(): marks a fully-confirmed payment as success and POSTs a signed webhook', async () => {
		const ctx = await setupTwoPayments();
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_transfers: () => ({
				in: [
					{
						txid: 'tx_abc',
						amount: 100_000_000_000,
						confirmations: 10,
						height: 3_000_000,
						subaddr_index: { major: 0, minor: 0 },
					},
				],
			}),
			get_address: () => ({
				addresses: [
					{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId },
					{ address: '8addr_1', address_index: 1, label: ctx.payment2.paymentId },
				],
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
		});

		const result = await indexer.tick();
		expect(result.transfersInspected).toBe(1);
		expect(result.webhooksSent).toBe(1);
		expect(result.errors).toEqual([]);

		expect(ctx.webhookCalls).toHaveLength(1);
		const sentBody = JSON.parse(ctx.webhookCalls[0].body) as MoneroWebhookPayload;
		expect(sentBody.status).toBe('success');
		expect(sentBody.paymentId).toBe(ctx.payment1.paymentId);

		// Signature is correct
		const expectedSig = await computeMoneroSignature(ctx.webhookCalls[0].body, SECRET);
		expect(ctx.webhookCalls[0].headers['x-monero-sig']).toBe(expectedSig);
		expect(ctx.webhookCalls[0].headers['x-provider']).toBe('monero');

		// Store updated to success
		const updated = await ctx.store.get(ctx.payment1.paymentId);
		expect(updated?.status).toBe('success');
	});

	it('tick(): leaves an under-confirmed payment alone', async () => {
		const ctx = await setupTwoPayments();
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_005 }),
			get_transfers: () => ({
				in: [
					{
						txid: 'tx_abc',
						amount: 100_000_000_000,
						confirmations: 5,
						height: 3_000_000,
						subaddr_index: { major: 0, minor: 0 },
					},
				],
			}),
			get_address: () => ({
				addresses: [
					{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId },
					{ address: '8addr_1', address_index: 1, label: ctx.payment2.paymentId },
				],
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
		});

		const result = await indexer.tick();
		expect(result.webhooksSent).toBe(0);
		expect(ctx.webhookCalls).toHaveLength(0);
		const record = await ctx.store.get(ctx.payment1.paymentId);
		expect(record?.status).toBe('pending');
	});

	it('tick(): marks an underpaid confirmed payment as partial', async () => {
		const ctx = await setupTwoPayments();
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_transfers: () => ({
				in: [
					{
						txid: 'tx_partial',
						amount: 60_000_000_000,
						confirmations: 10,
						height: 3_000_000,
						subaddr_index: { major: 0, minor: 0 },
					},
				],
			}),
			get_address: () => ({
				addresses: [{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId }],
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
		});

		await indexer.tick();
		const sentBody = JSON.parse(ctx.webhookCalls[0].body) as MoneroWebhookPayload;
		expect(sentBody.status).toBe('partial');
		expect(sentBody.receivedAmountAtomic).toBe('60000000000');
		expect(sentBody.expectedAmountAtomic).toBe('100000000000');
	});

	it('tick(): expiry sweep marks unpaid expired payments as failed', async () => {
		// Use a fake "now" that's after the default 15-minute expiry.
		let currentTime = 1_700_000_000_000;
		const ctx = await setupTwoPayments({ now: () => currentTime });
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_transfers: () => ({ in: [] }),
			get_address: () => ({
				addresses: [{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId }],
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher,
			now: () => currentTime,
		});

		// Advance past expiry (default expiryMinutes = 15)
		currentTime = ctx.payment1.expiresAt + 1000;

		await indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(1);
		const sentBody = JSON.parse(ctx.webhookCalls[0].body) as MoneroWebhookPayload;
		expect(sentBody.status).toBe('failed');
		expect(sentBody.txHash).toBeNull();

		const updated = await ctx.store.get(ctx.payment1.paymentId);
		expect(updated?.status).toBe('failed');
		expect(updated?.metadata.failureReason).toBe('expired');
	});

	it('tick(): does not re-emit webhooks for already-announced payments (uses markStatusAnnounced)', async () => {
		const ctx = await setupTwoPayments();
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_transfers: () => ({
				in: [
					{
						txid: 'tx_abc',
						amount: 100_000_000_000,
						confirmations: 10,
						height: 3_000_000,
						subaddr_index: { major: 0, minor: 0 },
					},
				],
			}),
			get_address: () => ({
				addresses: [{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId }],
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
		});

		await indexer.tick();
		await indexer.tick();
		await indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(1);
	});

	it('tick(): falls back to status-read idempotency when markStatusAnnounced is absent', async () => {
		const ctx = await setupTwoPayments();
		// Wrap the store to omit markStatusAnnounced
		const noClaimStore: PaymentStore = {
			upsert: ctx.store.upsert.bind(ctx.store),
			get: ctx.store.get.bind(ctx.store),
		};

		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_transfers: () => ({
				in: [
					{
						txid: 'tx_abc',
						amount: 100_000_000_000,
						confirmations: 10,
						height: 3_000_000,
						subaddr_index: { major: 0, minor: 0 },
					},
				],
			}),
			get_address: () => ({
				addresses: [{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId }],
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: noClaimStore,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
		});

		await indexer.tick();
		await indexer.tick();
		expect(ctx.webhookCalls).toHaveLength(1);
	});

	it('tick(): re-entrant calls share the same in-flight promise', async () => {
		const ctx = await setupTwoPayments();
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_transfers: () => ({ in: [] }),
			get_address: () => ({ addresses: [] }),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher,
		});

		const a = indexer.tick();
		const b = indexer.tick();
		expect(a).toBe(b);
		await a;
		expect(indexer.status().totalTicks).toBe(1);
	});

	it('tick(): retries webhook delivery on transient failures', async () => {
		const ctx = await setupTwoPayments();
		let webhookAttempts = 0;
		const fetcher: typeof fetch = (input, init) => {
			const url = urlOf(input);
			if (url === WEBHOOK_URL) {
				webhookAttempts += 1;
				if (webhookAttempts < 3) {
					return Promise.resolve(new Response('', { status: 503 }));
				}
				ctx.webhookCalls.push({
					body: bodyString(init),
					headers: (init?.headers as Record<string, string>) ?? {},
				});
				return Promise.resolve(new Response('', { status: 200 }));
			}
			return withWalletHandlers(ctx.indexerFetcher, {
				get_height: () => ({ height: 3_000_010 }),
				get_transfers: () => ({
					in: [
						{
							txid: 'tx_abc',
							amount: 100_000_000_000,
							confirmations: 10,
							height: 3_000_000,
							subaddr_index: { major: 0, minor: 0 },
						},
					],
				}),
				get_address: () => ({
					addresses: [{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId }],
				}),
			})(input, init);
		};

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
			webhookRetry: { maxAttempts: 3, initialBackoffMs: 1 },
		});

		await indexer.tick();
		expect(webhookAttempts).toBe(3);
		expect(ctx.webhookCalls).toHaveLength(1);
		expect(indexer.status().webhookErrorCount).toBe(0);
	});

	it('tick(): increments webhookErrorCount when all retries are exhausted', async () => {
		const ctx = await setupTwoPayments();
		const fetcher: typeof fetch = (input, init) => {
			const url = urlOf(input);
			if (url === WEBHOOK_URL) {
				return Promise.resolve(new Response('', { status: 500 }));
			}
			return withWalletHandlers(ctx.indexerFetcher, {
				get_height: () => ({ height: 3_000_010 }),
				get_transfers: () => ({
					in: [
						{
							txid: 'tx_abc',
							amount: 100_000_000_000,
							confirmations: 10,
							height: 3_000_000,
							subaddr_index: { major: 0, minor: 0 },
						},
					],
				}),
				get_address: () => ({
					addresses: [{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId }],
				}),
			})(input, init);
		};

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
			webhookRetry: { maxAttempts: 2, initialBackoffMs: 1 },
		});

		const result = await indexer.tick();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(indexer.status().webhookErrorCount).toBe(1);
	});

	it('tick(): records lastError when wallet RPC itself fails', async () => {
		const ctx = await setupTwoPayments();
		const fetcher: typeof fetch = async (input) => {
			const url = urlOf(input);
			if (url.endsWith('/json_rpc')) {
				return new Response('boom', { status: 500 });
			}
			return ctx.indexerFetcher(input);
		};

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher,
		});

		await indexer.tick();
		expect(indexer.status().lastError).not.toBeNull();
	});

	it('processTx(): emits a webhook for a confirmed tx (tx-notify flow)', async () => {
		const ctx = await setupTwoPayments();
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_address: () => ({
				addresses: [{ address: '8addr_0', address_index: 0, label: ctx.payment1.paymentId }],
			}),
			get_transfer_by_txid: () => ({
				transfer: {
					txid: 'tx_notify_abc',
					amount: 100_000_000_000,
					confirmations: 10,
					height: 3_000_000,
					subaddr_index: { major: 0, minor: 0 },
				},
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			requiredConfirmations: 10,
			fetcher,
		});

		await indexer.processTx('tx_notify_abc');
		expect(ctx.webhookCalls).toHaveLength(1);
		const body = JSON.parse(ctx.webhookCalls[0].body) as MoneroWebhookPayload;
		expect(body.txHash).toBe('tx_notify_abc');
	});

	it('processTx(): ignores transfers for unknown subaddresses', async () => {
		const ctx = await setupTwoPayments();
		const fetcher = withWalletHandlers(ctx.indexerFetcher, {
			get_height: () => ({ height: 3_000_010 }),
			get_address: () => ({ addresses: [] }),
			get_transfer_by_txid: () => ({
				transfer: {
					txid: 'tx_unknown',
					amount: 50_000_000_000,
					confirmations: 10,
					height: 3_000_000,
					subaddr_index: { major: 0, minor: 99 },
				},
			}),
		});

		const indexer = createMoneroIndexer({
			walletRpcUrl: WALLET_URL,
			store: ctx.store,
			webhookUrl: WEBHOOK_URL,
			hmacSecret: SECRET,
			fetcher,
		});

		await indexer.processTx('tx_unknown');
		expect(ctx.webhookCalls).toHaveLength(0);
	});

	it('start()/stop(): polls on the configured interval and stops cleanly', async () => {
		vi.useFakeTimers();
		try {
			const ctx = await setupTwoPayments();
			const fetcher = withWalletHandlers(ctx.indexerFetcher, {
				get_height: () => ({ height: 3_000_010 }),
				get_transfers: () => ({ in: [] }),
				get_address: () => ({ addresses: [] }),
			});

			const indexer = createMoneroIndexer({
				walletRpcUrl: WALLET_URL,
				store: ctx.store,
				webhookUrl: WEBHOOK_URL,
				hmacSecret: SECRET,
				fetcher,
				pollIntervalMs: 1000,
			});

			const stop = indexer.start();
			vi.advanceTimersByTime(2500);
			await vi.runOnlyPendingTimersAsync();
			stop();
			vi.advanceTimersByTime(5000);
			await vi.runOnlyPendingTimersAsync();

			// Two ticks while running, none after stop.
			expect(indexer.status().totalTicks).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('throws at construction when hmacSecret is missing', () => {
		expect(() =>
			createMoneroIndexer({
				walletRpcUrl: WALLET_URL,
				store: createMemoryStore(),
				webhookUrl: WEBHOOK_URL,
				hmacSecret: '',
			}),
		).toThrow(/hmacSecret missing/);
	});
});
