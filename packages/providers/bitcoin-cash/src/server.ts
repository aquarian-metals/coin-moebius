import {
	decodeHdPublicKey,
	deriveHdPathRelative,
	encodeCashAddress,
	hash160,
	type HdPublicNodeValid,
} from '@bitauth/libauth';
import type { PaymentStatus, WebhookEvent } from '@aquarian-metals/coin-moebius-core';
import type { PaymentRecord, PaymentStore } from '@aquarian-metals/coin-moebius-server';
import { BCH_DECIMALS, formatAtomic } from './amounts.js';

export { BCH_DECIMALS, formatAtomic } from './amounts.js';

export interface BitcoinCashLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

export interface BitcoinCashRpcConfig {
	rpcUrl: string;
	wallet: string;
	rpcUser?: string;
	rpcPassword?: string;
	fetcher?: typeof fetch;
	requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface BitcoinCashCreatorConfig extends BitcoinCashRpcConfig {
	xpub: string;
	store: PaymentStore;
	expiryMinutes?: number;
	bchPerUnit?: (invoiceCurrency: string) => Promise<number>;
	logger?: BitcoinCashLogger;
}

export interface BitcoinCashCreateInput {
	productId: string;
	amount: number;
	currency: string;
	metadata?: Record<string, unknown>;
}

export interface BitcoinCashCreateResult {
	paymentId: string;
	address: string;
	atomicAmount: string;
	bchAmount: number;
	uri: string;
	expiresAt: number;
}

export interface BitcoinCashVerifierConfig {
	hmacSecret: string;
	freshnessToleranceMs?: number;
	now?: () => number;
}

const DEFAULT_WEBHOOK_FRESHNESS_MS = 5 * 60 * 1000;

export interface BitcoinCashWebhookPayload {
	provider: 'bitcoin-cash';
	paymentId: string;
	status: Extract<PaymentStatus, 'pending' | 'success' | 'partial' | 'failed'>;
	txHash: string | null;
	address: string;
	productId?: string;
	invoiceCurrency: string;
	invoiceAmount: number;
	expectedAmountAtomic: string;
	receivedAmountAtomic: string;
	expectedAmountBch: number;
	receivedAmountBch: number;
	confirmations: number;
	requiredConfirmations: number;
	blockHeight: number | null;
	timestamp: number;
}

export interface BitcoinCashVerifier {
	verify(rawBody: unknown, headers: Record<string, string | undefined>): Promise<WebhookEvent>;
}

export interface BitcoinCashIndexerConfig extends BitcoinCashRpcConfig {
	store: PaymentStore;
	webhookUrl: string;
	hmacSecret: string;
	requiredConfirmations?: number;
	scanLookbackBlocks?: number;
	pollIntervalMs?: number;
	webhookRetry?: {
		maxAttempts?: number;
		initialBackoffMs?: number;
	};
	logger?: BitcoinCashLogger;
	now?: () => number;
}

export interface BitcoinCashIndexerStatus {
	lastTickAt: number | null;
	lastError: { message: string; at: number } | null;
	walletHeight: number | null;
	pendingPaymentCount: number;
	totalTicks: number;
	totalWebhooksSent: number;
	webhookErrorCount: number;
}

export interface BitcoinCashTickResult {
	walletHeight: number;
	transfersInspected: number;
	webhooksSent: number;
	errors: string[];
}

export interface BitcoinCashIndexer {
	tick(): Promise<BitcoinCashTickResult>;
	start(): () => void;
	status(): BitcoinCashIndexerStatus;
}

const PAYMENT_ID_PREFIX = 'bch_';

export function createBitcoinCashCreator(config: BitcoinCashCreatorConfig) {
	const expiryMinutes = config.expiryMinutes ?? 15;
	const logger = config.logger ?? noopLogger();
	const rpc = rpcCaller(config);
	const account = accountKey(config.xpub);
	const now = Date.now;

	let queue: Promise<unknown> = Promise.resolve();
	let prefix: CashAddrPrefix | null = null;
	let highestIndex: number | null = null;

	async function claimAddress(paymentId: string): Promise<string> {
		prefix ??= await cashAddrPrefix(rpc);
		highestIndex ??= await highestWatchedIndex(rpc);
		let index = highestIndex + 1;
		for (;;) {
			const address = receivingAddress(account, index, prefix);
			const label = `${paymentId}/${index}`;
			if (!(await isWatched(rpc, address))) {
				await rpc('importaddress', { address, label, rescan: false });
				if ((await labelOf(rpc, address)) === label) {
					highestIndex = index;
					return address;
				}
			}
			index += 1;
		}
	}

	return async function createBitcoinCashPayment(
		input: BitcoinCashCreateInput,
	): Promise<BitcoinCashCreateResult> {
		const rawQuote = await invoiceToBch(input.currency, input.amount, config.bchPerUnit);
		const quoted = roundQuoteUp(rawQuote);
		const atomicAmount = toAtomic(quoted);
		const bchAmount = fromAtomic(BigInt(atomicAmount));

		const paymentId = PAYMENT_ID_PREFIX + toHex(randomBytes(8));
		const claim = queue.then(() => claimAddress(paymentId));
		queue = claim.catch(() => undefined);
		const address = await claim;

		const expiresAt = now() + expiryMinutes * 60 * 1000;
		const uri = `${address}?amount=${formatAtomic(BigInt(atomicAmount))}`;

		const record: PaymentRecord = {
			status: 'pending',
			paymentId,
			provider: 'bitcoin-cash',
			amount: input.amount,
			currency: input.currency,
			metadata: {
				...withoutIndexerFields(input.metadata ?? {}),
				productId: input.productId,
				address,
				atomicAmount,
				bchAmount,
				invoiceAmount: input.amount,
				expiresAt,
			},
			timestamp: now(),
			createdAt: now(),
			updatedAt: now(),
		};
		await config.store.upsert(record);

		logger.info('bitcoin-cash: created payment', { paymentId, bchAmount });

		return { paymentId, address, atomicAmount, bchAmount, uri, expiresAt };
	};
}

export function createBitcoinCashVerifier(config: BitcoinCashVerifierConfig): BitcoinCashVerifier {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/bitcoin-cash: hmacSecret missing on verifier config');
	}

	return {
		async verify(rawBody, headers): Promise<WebhookEvent> {
			const sig = headerValue(headers, 'x-bitcoin-cash-sig');
			if (!sig) {
				throw new Error('coin-moebius/bitcoin-cash: missing x-bitcoin-cash-sig header');
			}

			let payload: BitcoinCashWebhookPayload;
			let canonical: string;
			if (typeof rawBody === 'string') {
				canonical = rawBody;
				try {
					payload = JSON.parse(rawBody) as BitcoinCashWebhookPayload;
				} catch {
					throw new Error('coin-moebius/bitcoin-cash: body is not valid JSON');
				}
			} else if (rawBody && typeof rawBody === 'object') {
				payload = rawBody as BitcoinCashWebhookPayload;
				canonical = JSON.stringify(payload);
			} else {
				throw new Error('coin-moebius/bitcoin-cash: unsupported body type');
			}

			const expected = await computeBitcoinCashSignature(canonical, config.hmacSecret);
			if (!timingSafeStringEqual(expected, sig)) {
				throw new Error('coin-moebius/bitcoin-cash: invalid signature');
			}

			const tolerance = config.freshnessToleranceMs ?? DEFAULT_WEBHOOK_FRESHNESS_MS;
			const nowMs = (config.now ?? Date.now)();
			if (
				typeof payload.timestamp !== 'number' ||
				Math.abs(nowMs - payload.timestamp) > tolerance
			) {
				throw new Error(
					'coin-moebius/bitcoin-cash: webhook timestamp outside the freshness window',
				);
			}
			if (payload.provider !== 'bitcoin-cash') {
				throw new Error('coin-moebius/bitcoin-cash: webhook is not a bitcoin cash payment');
			}

			return toPaymentResult(payload);
		},
	};
}

export function createBitcoinCashIndexer(config: BitcoinCashIndexerConfig): BitcoinCashIndexer {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/bitcoin-cash: hmacSecret missing on indexer config');
	}

	const requiredConfirmations = config.requiredConfirmations ?? 6;
	if (!Number.isInteger(requiredConfirmations) || requiredConfirmations < 1) {
		throw new Error(
			`coin-moebius/bitcoin-cash: requiredConfirmations must be a whole number of at least 1, got ${requiredConfirmations}`,
		);
	}
	const scanLookback = config.scanLookbackBlocks ?? 144;
	const pollIntervalMs = config.pollIntervalMs ?? 30_000;
	const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const logger = config.logger ?? noopLogger();
	const now = config.now ?? Date.now;
	const rpc = rpcCaller(config);
	const retryConfig = {
		maxAttempts: config.webhookRetry?.maxAttempts ?? 3,
		initialBackoffMs: config.webhookRetry?.initialBackoffMs ?? 500,
	};

	const state: BitcoinCashIndexerStatus = {
		lastTickAt: null,
		lastError: null,
		walletHeight: null,
		pendingPaymentCount: 0,
		totalTicks: 0,
		totalWebhooksSent: 0,
		webhookErrorCount: 0,
	};

	let ticking: Promise<BitcoinCashTickResult> | null = null;
	let warnedAboutExpiry = false;

	async function tickInternal(): Promise<BitcoinCashTickResult> {
		const tickStartedAt = now();
		const errors: string[] = [];
		let webhooksSent = 0;

		const { walletHeight, received } = await readRecentReceipts();
		state.walletHeight = walletHeight;

		const observed = groupByPaymentId(received);

		for (const [paymentId, receipts] of observed) {
			try {
				const sent = await processPaymentChainState(paymentId, receipts);
				if (sent) webhooksSent += 1;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`paymentId=${paymentId}: ${message}`);
				logger.error('bitcoin-cash: payment processing failed', { paymentId, message });
			}
		}

		webhooksSent += await sweepExpired(observed, errors);

		state.totalTicks += 1;
		state.totalWebhooksSent += webhooksSent;
		state.lastTickAt = tickStartedAt;
		state.lastError = errors.length === 0 ? null : { message: errors[0], at: tickStartedAt };

		return {
			walletHeight,
			transfersInspected: received.length,
			webhooksSent,
			errors,
		};
	}

	async function readRecentReceipts(): Promise<{ walletHeight: number; received: Receipt[] }> {
		const walletHeight = await rpc<unknown>('getblockcount', []);
		if (typeof walletHeight !== 'number' || !Number.isInteger(walletHeight) || walletHeight < 0) {
			throw new Error('coin-moebius/bitcoin-cash: node reported no block height');
		}
		const fromHeight = Math.max(0, walletHeight - requiredConfirmations - scanLookback);
		const fromHash = await rpc<unknown>('getblockhash', [fromHeight]);
		if (typeof fromHash !== 'string') {
			throw new Error(`coin-moebius/bitcoin-cash: node returned no hash for block ${fromHeight}`);
		}

		const reply = await rpc<unknown>('listsinceblock', {
			blockhash: fromHash,
			include_watchonly: true,
		});
		const byOutput = new Map<string, Receipt>();
		for (const entry of readArray(reply, 'transactions')) {
			const receipt = readReceipt(entry);
			if (receipt) byOutput.set(`${receipt.txid}:${receipt.vout}`, receipt);
		}
		return { walletHeight, received: [...byOutput.values()] };
	}

	async function processPaymentChainState(
		paymentId: string,
		receipts: Receipt[],
	): Promise<boolean> {
		const record = await config.store.get(paymentId);
		if (record?.provider !== 'bitcoin-cash') return false;
		if (record.status === 'success' || record.status === 'partial') {
			return false;
		}

		const address = readStringMetadata(record, 'address');
		const counted = receipts.filter((receipt) => receipt.address === address);
		if (counted.length === 0) return false;

		const expectedAtomic = readBigIntMetadata(record, 'atomicAmount');
		if (expectedAtomic <= 0n) {
			throw new Error(
				'coin-moebius/bitcoin-cash: the stored payment has no atomicAmount, so it cannot be checked; refusing to settle it',
			);
		}

		const confirmed = counted.filter((receipt) => receipt.confirmations >= requiredConfirmations);
		const confirmedAtomic = sumAtomic(confirmed);
		let status: BitcoinCashWebhookPayload['status'] | null = null;
		if (confirmedAtomic >= expectedAtomic) status = 'success';
		else if (confirmed.length === counted.length) status = 'partial';

		const observation = observe(paymentId, record, expectedAtomic, status ? confirmed : counted);

		if (!status) return await announceProgress(observation);

		const winner = await claimAnnouncement(paymentId, status);
		if (!winner) return false;

		await announce(paymentId, status, payloadFor(observation, status));

		await config.store.upsert({
			...record,
			status,
			amount:
				status === 'partial'
					? proratedInvoiceAmount(record, observation.receivedAtomic)
					: invoiceAmountOf(record),
			metadata: {
				...record.metadata,
				txHash: observation.txHash,
				receivedAtomic: observation.receivedAtomic.toString(),
				confirmations: observation.confirmations,
			},
			timestamp: now(),
			createdAt: record.createdAt,
			updatedAt: now(),
		});

		return true;
	}

	function observe(
		paymentId: string,
		record: PaymentRecord,
		expectedAtomic: bigint,
		receipts: Receipt[],
	): Observation {
		const minedHeights = receipts
			.map((receipt) => receipt.blockHeight)
			.filter((height): height is number => height !== null);
		return {
			paymentId,
			record,
			expectedAtomic,
			receivedAtomic: sumAtomic(receipts),
			confirmations: Math.min(...receipts.map((receipt) => receipt.confirmations)),
			txHash: receipts[0]?.txid ?? null,
			blockHeight: minedHeights.length > 0 ? Math.min(...minedHeights) : null,
		};
	}

	async function announceProgress(observation: Observation): Promise<boolean> {
		const announced = readNumberMetadata(observation.record, 'confirmations');
		if (announced !== null && observation.confirmations <= announced) return false;

		await emitWebhook(payloadFor(observation, 'pending'));

		await config.store.upsert({
			...observation.record,
			metadata: {
				...observation.record.metadata,
				txHash: observation.txHash,
				receivedAtomic: observation.receivedAtomic.toString(),
				confirmations: observation.confirmations,
			},
			timestamp: now(),
			createdAt: observation.record.createdAt,
			updatedAt: now(),
		});

		return true;
	}

	function payloadFor(
		observation: Observation,
		status: BitcoinCashWebhookPayload['status'],
	): BitcoinCashWebhookPayload {
		return {
			provider: 'bitcoin-cash',
			paymentId: observation.paymentId,
			status,
			txHash: observation.txHash,
			address: readStringMetadata(observation.record, 'address'),
			...productIdOf(observation.record),
			invoiceCurrency: observation.record.currency,
			invoiceAmount: invoiceAmountOf(observation.record),
			expectedAmountAtomic: observation.expectedAtomic.toString(),
			receivedAmountAtomic: observation.receivedAtomic.toString(),
			expectedAmountBch: fromAtomic(observation.expectedAtomic),
			receivedAmountBch: fromAtomic(observation.receivedAtomic),
			confirmations: observation.confirmations,
			requiredConfirmations,
			blockHeight: observation.blockHeight,
			timestamp: now(),
		};
	}

	async function sweepExpired(observed: Map<string, Receipt[]>, errors: string[]): Promise<number> {
		if (!config.store.listPending) {
			if (!warnedAboutExpiry) {
				warnedAboutExpiry = true;
				logger.warn(
					'bitcoin-cash: store has no listPending, so unpaid invoices will never be marked failed',
				);
			}
			state.pendingPaymentCount = 0;
			return 0;
		}

		const pending = await config.store.listPending('bitcoin-cash');
		let sent = 0;
		let stillOpen = 0;

		for (const record of pending) {
			if (record.status !== 'pending') continue;
			if (observed.has(record.paymentId)) {
				stillOpen += 1;
				continue;
			}
			const expiresAt = readNumberMetadata(record, 'expiresAt');
			if (expiresAt === null || now() < expiresAt) {
				stillOpen += 1;
				continue;
			}

			try {
				const address = readStringMetadata(record, 'address');
				if (await everReceived(address)) {
					stillOpen += 1;
					logger.warn(
						'bitcoin-cash: money reached an expired invoice outside the lookback window; raise scanLookbackBlocks to settle it',
						{ paymentId: record.paymentId, address },
					);
					continue;
				}

				const winner = await claimAnnouncement(record.paymentId, 'failed');
				if (!winner) continue;

				const expectedAtomic = readBigIntMetadata(record, 'atomicAmount');
				await announce(record.paymentId, 'failed', {
					provider: 'bitcoin-cash',
					paymentId: record.paymentId,
					status: 'failed',
					txHash: null,
					address,
					...productIdOf(record),
					invoiceCurrency: record.currency,
					invoiceAmount: invoiceAmountOf(record),
					expectedAmountAtomic: expectedAtomic.toString(),
					receivedAmountAtomic: '0',
					expectedAmountBch: fromAtomic(expectedAtomic),
					receivedAmountBch: 0,
					confirmations: 0,
					requiredConfirmations,
					blockHeight: null,
					timestamp: now(),
				});

				await config.store.upsert({
					...record,
					status: 'failed',
					metadata: {
						...record.metadata,
						failureReason: 'expired',
					},
					timestamp: now(),
					createdAt: record.createdAt,
					updatedAt: now(),
				});
				sent += 1;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`paymentId=${record.paymentId}: ${message}`);
				logger.error('bitcoin-cash: expiry processing failed', {
					paymentId: record.paymentId,
					message,
				});
			}
		}

		state.pendingPaymentCount = stillOpen;
		return sent;
	}

	async function everReceived(address: string): Promise<boolean> {
		const total = await rpc<unknown>('getreceivedbyaddress', { address, minconf: 0 });
		return typeof total === 'number' && total > 0;
	}

	async function claimAnnouncement(paymentId: string, status: PaymentStatus): Promise<boolean> {
		if (config.store.markStatusAnnounced) {
			return await config.store.markStatusAnnounced(paymentId, status);
		}
		const fresh = await config.store.get(paymentId);
		if (!fresh) return false;
		return fresh.status === 'pending' || (fresh.status === 'failed' && status !== 'failed');
	}

	async function announce(
		paymentId: string,
		status: PaymentStatus,
		payload: BitcoinCashWebhookPayload,
	): Promise<void> {
		try {
			await emitWebhook(payload);
		} catch (err) {
			await config.store.unmarkStatusAnnounced?.(paymentId, status);
			throw err;
		}
	}

	async function emitWebhook(payload: BitcoinCashWebhookPayload): Promise<void> {
		const body = JSON.stringify(payload);
		const sig = await computeBitcoinCashSignature(body, config.hmacSecret);

		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
			try {
				const response = await fetcher(config.webhookUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-bitcoin-cash-sig': sig,
						'x-provider': 'bitcoin-cash',
					},
					body,
					signal: AbortSignal.timeout(requestTimeoutMs),
				});
				if (response.ok) return;
				throw new Error(`webhook responded ${response.status}`);
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt < retryConfig.maxAttempts) {
					await sleep(retryConfig.initialBackoffMs * 2 ** (attempt - 1));
				}
			}
		}
		state.webhookErrorCount += 1;
		logger.error('bitcoin-cash: webhook delivery failed', {
			paymentId: payload.paymentId,
			error: lastError?.message,
		});
		throw lastError ?? new Error('coin-moebius/bitcoin-cash: webhook delivery failed');
	}

	return {
		tick(): Promise<BitcoinCashTickResult> {
			if (ticking) return ticking;
			ticking = tickInternal()
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					state.lastError = { message, at: now() };
					state.totalTicks += 1;
					logger.error('bitcoin-cash: tick failed', { message });
					return {
						walletHeight: state.walletHeight ?? 0,
						transfersInspected: 0,
						webhooksSent: 0,
						errors: [message],
					};
				})
				.finally(() => {
					ticking = null;
				});
			return ticking;
		},
		start(): () => void {
			const handle = setInterval(() => {
				void this.tick();
			}, pollIntervalMs);
			return () => clearInterval(handle);
		},
		status(): BitcoinCashIndexerStatus {
			return { ...state };
		},
	};
}

export async function computeBitcoinCashSignature(
	body: string,
	hmacSecret: string,
): Promise<string> {
	return toHex(new Uint8Array(await hmacSha256(hmacSecret, body)));
}

const QUOTE_SIGNIFICANT_DIGITS = 6;

export function roundQuoteUp(amount: number): number {
	if (!Number.isFinite(amount) || amount <= 0) return amount;
	const magnitude = Math.floor(Math.log10(amount));
	const places = Math.max(0, Math.min(QUOTE_SIGNIFICANT_DIGITS - 1 - magnitude, BCH_DECIMALS));
	return Number(
		formatAtomic(BigInt(atomicAt(amount, places)) * 10n ** BigInt(BCH_DECIMALS - places)),
	);
}

export function toAtomic(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error(`coin-moebius/bitcoin-cash: amount must be positive, got ${amount}`);
	}
	return atomicAt(amount, BCH_DECIMALS);
}

export function fromAtomic(atomic: bigint): number {
	return Number(atomic) / 10 ** BCH_DECIMALS;
}

type Rpc = <T>(method: string, params: unknown) => Promise<T>;

type CashAddrPrefix = 'bitcoincash' | 'bchtest' | 'bchreg';

interface Receipt {
	paymentId: string;
	txid: string;
	vout: number;
	address: string;
	amount: bigint;
	confirmations: number;
	blockHeight: number | null;
}

interface Observation {
	paymentId: string;
	record: PaymentRecord;
	expectedAtomic: bigint;
	receivedAtomic: bigint;
	confirmations: number;
	txHash: string | null;
	blockHeight: number | null;
}

function accountKey(xpub: string): HdPublicNodeValid {
	const decoded = decodeHdPublicKey(xpub);
	if (typeof decoded === 'string') {
		throw new Error(
			'coin-moebius/bitcoin-cash: xpub is not a valid extended public key. Copy it again from your wallet.',
		);
	}
	if (decoded.node.depth !== 3) {
		throw new Error(
			`coin-moebius/bitcoin-cash: xpub must be the account key for m/44'/145'/0' (depth 3), got depth ${decoded.node.depth}`,
		);
	}
	return decoded.node;
}

function receivingAddress(
	account: HdPublicNodeValid,
	index: number,
	prefix: CashAddrPrefix,
): string {
	if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
		throw new Error(`coin-moebius/bitcoin-cash: address index out of range: ${index}`);
	}
	const child = deriveHdPathRelative(account, `0/${index}`);
	if (typeof child === 'string') {
		throw new Error(`coin-moebius/bitcoin-cash: could not derive address 0/${index}`);
	}
	const encoded = encodeCashAddress({ prefix, type: 'p2pkh', payload: hash160(child.publicKey) });
	return typeof encoded === 'string' ? encoded : encoded.address;
}

async function cashAddrPrefix(rpc: Rpc): Promise<CashAddrPrefix> {
	const chain = readString(await rpc<unknown>('getblockchaininfo', []), 'chain');
	if (chain === 'main') return 'bitcoincash';
	if (chain === 'regtest') return 'bchreg';
	if (chain === 'test' || chain === 'test4' || chain === 'scale' || chain === 'chip') {
		return 'bchtest';
	}
	throw new Error(`coin-moebius/bitcoin-cash: node is on an unknown chain '${chain}'`);
}

const LABEL = /^(bch_[0-9a-f]{16})\/(\d+)$/;

function parseLabel(label: string): { paymentId: string; index: number } | null {
	const match = LABEL.exec(label);
	if (!match) return null;
	const index = Number(match[2]);
	return Number.isSafeInteger(index) ? { paymentId: match[1], index } : null;
}

async function highestWatchedIndex(rpc: Rpc): Promise<number> {
	const labels = await rpc<unknown>('listlabels', []);
	if (!Array.isArray(labels)) {
		throw new Error('coin-moebius/bitcoin-cash: node returned no label list');
	}
	let highest = -1;
	for (const label of labels) {
		const parsed = typeof label === 'string' ? parseLabel(label) : null;
		if (parsed && parsed.index > highest) highest = parsed.index;
	}
	return highest;
}

async function isWatched(rpc: Rpc, address: string): Promise<boolean> {
	const info = await rpc<unknown>('getaddressinfo', [address]);
	return readField(info, 'iswatchonly') === true || readField(info, 'ismine') === true;
}

async function labelOf(rpc: Rpc, address: string): Promise<string> {
	return readString(await rpc<unknown>('getaddressinfo', [address]), 'label');
}

function rpcCaller(config: BitcoinCashRpcConfig): Rpc {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const endpoint = `${config.rpcUrl.replace(/\/+$/, '')}/wallet/${encodeURIComponent(config.wallet)}`;
	const authorization =
		config.rpcUser === undefined
			? null
			: `Basic ${base64Std(bytesOf(`${config.rpcUser}:${config.rpcPassword ?? ''}`))}`;

	return async <T>(method: string, params: unknown): Promise<T> => {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (authorization) headers.Authorization = authorization;
		const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });

		const response = await fetcher(endpoint, {
			method: 'POST',
			headers,
			body,
			signal: AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`coin-moebius/bitcoin-cash: node refused ${method} (${response.status}). Check rpcUser and rpcPassword.`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(await response.text()) as unknown;
		} catch {
			throw new Error(`coin-moebius/bitcoin-cash: node ${method} HTTP ${response.status}`);
		}
		const error = readField(parsed, 'error');
		if (typeof error === 'object' && error !== null) {
			throw new Error(
				`coin-moebius/bitcoin-cash: node ${method} error: ${readString(error, 'message') || 'unknown'}`,
			);
		}
		if (!response.ok) {
			throw new Error(`coin-moebius/bitcoin-cash: node ${method} HTTP ${response.status}`);
		}
		const result = readField(parsed, 'result');
		if (result === undefined) {
			throw new Error(`coin-moebius/bitcoin-cash: node ${method} returned no result`);
		}
		return result as T;
	};
}

function readReceipt(entry: object): Receipt | null {
	if (readField(entry, 'category') !== 'receive') return null;
	const label = parseLabel(readString(entry, 'label'));
	if (!label) return null;
	const txid = readString(entry, 'txid').toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(txid)) return null;
	const confirmations = readField(entry, 'confirmations');
	if (typeof confirmations !== 'number' || !Number.isInteger(confirmations) || confirmations < 0) {
		return null;
	}
	const vout = readField(entry, 'vout');
	const amount = satoshisOf(readField(entry, 'amount'));
	if (typeof vout !== 'number' || amount === null) return null;
	const blockHeight = readField(entry, 'blockheight');

	return {
		paymentId: label.paymentId,
		txid,
		vout,
		address: readString(entry, 'address'),
		amount,
		confirmations,
		blockHeight: confirmations > 0 && typeof blockHeight === 'number' ? blockHeight : null,
	};
}

function satoshisOf(value: unknown): bigint | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return BigInt(Math.round(value * 10 ** BCH_DECIMALS));
}

const INDEXER_FIELDS = new Set(['txHash', 'receivedAtomic', 'confirmations', 'failureReason']);

function withoutIndexerFields(metadata: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(metadata).filter(([key]) => !INDEXER_FIELDS.has(key)));
}

function productIdOf(record: PaymentRecord): { productId?: string } {
	const productId = readStringMetadata(record, 'productId');
	return productId ? { productId } : {};
}

function sumAtomic(receipts: Receipt[]): bigint {
	return receipts.reduce((sum, receipt) => sum + receipt.amount, 0n);
}

function groupByPaymentId(received: Receipt[]): Map<string, Receipt[]> {
	const observed = new Map<string, Receipt[]>();
	for (const receipt of received) {
		const list = observed.get(receipt.paymentId) ?? [];
		list.push(receipt);
		observed.set(receipt.paymentId, list);
	}
	return observed;
}

async function invoiceToBch(
	currency: string,
	amount: number,
	bchPerUnit?: (invoiceCurrency: string) => Promise<number>,
): Promise<number> {
	if (currency.toUpperCase() === 'BCH') return amount;
	if (!bchPerUnit) {
		throw new Error(
			`coin-moebius/bitcoin-cash: invoice currency '${currency}' requires bchPerUnit on creator config`,
		);
	}
	const unitsPerCurrency = await bchPerUnit(currency);
	if (!(unitsPerCurrency > 0)) {
		throw new Error(
			`coin-moebius/bitcoin-cash: bchPerUnit('${currency}') returned ${unitsPerCurrency}; must be positive`,
		);
	}
	return amount * unitsPerCurrency;
}

function atomicAt(amount: number, places: number): string {
	const { whole, fraction } = decimalDigits(Number(amount.toPrecision(15)));
	const kept = fraction.slice(0, places).padEnd(places, '0');
	const dropped = fraction.slice(places);
	let atomic = BigInt(whole) * 10n ** BigInt(places) + BigInt(kept || '0');
	if (/[1-9]/.test(dropped)) atomic += 1n;
	return atomic.toString();
}

function decimalDigits(amount: number): { whole: string; fraction: string } {
	const text = amount.toString();
	if (!text.includes('e')) {
		const [whole = '0', fraction = ''] = text.split('.');
		return { whole, fraction };
	}
	const [mantissa = '0', exponent = '0'] = text.split('e');
	const [mantissaWhole = '0', mantissaFraction = ''] = mantissa.split('.');
	const digits = mantissaWhole + mantissaFraction;
	const pointAt = mantissaWhole.length + Number(exponent);
	if (pointAt <= 0) return { whole: '0', fraction: '0'.repeat(-pointAt) + digits };
	if (pointAt >= digits.length) {
		return { whole: digits + '0'.repeat(pointAt - digits.length), fraction: '' };
	}
	return { whole: digits.slice(0, pointAt), fraction: digits.slice(pointAt) };
}

function toPaymentResult(payload: BitcoinCashWebhookPayload): WebhookEvent {
	const amount =
		payload.status === 'partial'
			? proratedFromAtomic(
					payload.invoiceAmount,
					BigInt(payload.expectedAmountAtomic),
					BigInt(payload.receivedAmountAtomic),
				)
			: payload.invoiceAmount;
	return {
		kind: 'payment',
		status: payload.status,
		paymentId: payload.paymentId,
		provider: 'bitcoin-cash',
		amount: payload.status === 'failed' ? 0 : amount,
		currency: payload.invoiceCurrency,
		metadata: {
			address: payload.address,
			...(typeof payload.productId === 'string' ? { productId: payload.productId } : {}),
			txHash: payload.txHash,
			confirmations: payload.confirmations,
			requiredConfirmations: payload.requiredConfirmations,
			blockHeight: payload.blockHeight,
			expectedAmountBch: payload.expectedAmountBch,
			receivedAmountBch: payload.receivedAmountBch,
			expectedAmountAtomic: payload.expectedAmountAtomic,
			receivedAmountAtomic: payload.receivedAmountAtomic,
		},
		timestamp: payload.timestamp,
		raw: payload,
	};
}

function proratedInvoiceAmount(record: PaymentRecord, receivedAtomic: bigint): number {
	return proratedFromAtomic(
		invoiceAmountOf(record),
		readBigIntMetadata(record, 'atomicAmount'),
		receivedAtomic,
	);
}

function proratedFromAtomic(
	invoiceAmount: number,
	expectedAtomic: bigint,
	receivedAtomic: bigint,
): number {
	if (expectedAtomic === 0n) return 0;
	return (invoiceAmount * Number(receivedAtomic)) / Number(expectedAtomic);
}

function readBigIntMetadata(record: PaymentRecord, key: string): bigint {
	const raw = record.metadata[key];
	if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return BigInt(raw);
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 0n;
	return BigInt(raw);
}

function invoiceAmountOf(record: PaymentRecord): number {
	return readNumberMetadata(record, 'invoiceAmount') ?? record.amount;
}

function readStringMetadata(record: PaymentRecord, key: string): string {
	const raw = record.metadata[key];
	return typeof raw === 'string' ? raw : '';
}

function readNumberMetadata(record: PaymentRecord, key: string): number | null {
	const raw = record.metadata[key];
	return typeof raw === 'number' ? raw : null;
}

function readField(source: unknown, field: string): unknown {
	if (typeof source !== 'object' || source === null) return undefined;
	return Reflect.get(source, field) as unknown;
}

function readString(source: unknown, field: string): string {
	const value = readField(source, field);
	return typeof value === 'string' ? value : '';
}

function readArray(source: unknown, field: string): object[] {
	const list = readField(source, field);
	if (!Array.isArray(list)) return [];
	return list.filter((one): one is object => typeof one === 'object' && one !== null);
}

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

function bytesOf(text: string): Uint8Array<ArrayBuffer> {
	return new TextEncoder().encode(text);
}

async function hmacSha256(secret: string, message: string): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey(
		'raw',
		bytesOf(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	return crypto.subtle.sign('HMAC', key, bytesOf(message));
}

function base64Std(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function headerValue(
	headers: Record<string, string | undefined>,
	name: string,
): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

function timingSafeStringEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const b of bytes) out += b.toString(16).padStart(2, '0');
	return out;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function noopLogger(): BitcoinCashLogger {
	return {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
	};
}
