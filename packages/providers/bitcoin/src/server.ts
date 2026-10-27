/**
 * Bitcoin server-side primitives for Coin Moebius.
 *
 * Four exports, one per responsibility:
 *
 *   1. {@link createBitcoinCreator}: invoked from the merchant's "checkout"
 *      serverless function. Asks the merchant's Bitcoin Core wallet for a
 *      fresh receiving address labeled with the payment id, persists a
 *      pending record to the merchant's {@link PaymentStore}, and returns
 *      the buyer-facing instructions (address, exact amount, `bitcoin:`
 *      link, expiresAt).
 *
 *   2. {@link createBitcoinVerifier}: invoked from the merchant's
 *      "payment-webhook" serverless function. Validates the HMAC-signed
 *      payload that the indexer posts and returns a normalized
 *      `WebhookEvent`.
 *
 *   3. {@link createBitcoinIndexer}: a long-running process the merchant
 *      hosts next to `bitcoind` (same box or same private network). Reads
 *      the wallet's recent incoming transactions, matches them to payments
 *      by address label, and POSTs HMAC-signed webhooks. Exposes `.tick()`,
 *      `.start()`, and `.status()`.
 *
 *   4. {@link computeBitcoinSignature}: the HMAC helper so custom indexers
 *      and tests can produce signatures the verifier accepts.
 *
 * The wallet should be watch-only: a descriptor wallet created with private
 * keys disabled, holding only the merchant's extended public key. It can
 * hand out addresses and see payments, and it cannot spend.
 */

import type { PaymentStatus, WebhookEvent } from '@aquarian-metals/coin-moebius-core';
import type { PaymentRecord, PaymentStore } from '@aquarian-metals/coin-moebius-server';
import { BTC_DECIMALS, formatAtomic } from './amounts.js';

export { BTC_DECIMALS, formatAtomic } from './amounts.js';

// ============================================================================
// Public types
// ============================================================================

/** Minimal logger contract. Default is a no-op; ops teams inject pino, etc. */
export interface BitcoinLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

/** How to reach the merchant's Bitcoin Core RPC. Shared by the creator and the indexer. */
export interface BitcoinRpcConfig {
	/** Base URL of `bitcoind`'s RPC (e.g. `http://127.0.0.1:8332`). `/wallet/<wallet>` is appended. */
	rpcUrl: string;
	/** Name of the wallet loaded in `bitcoind` that receives payments. */
	wallet: string;
	/**
	 * RPC user. Set it with `rpcPassword` to send HTTP Basic auth. For cookie
	 * auth, pass `__cookie__` here and the text after the colon in the node's
	 * `.cookie` file as `rpcPassword`.
	 */
	rpcUser?: string;
	/** RPC password, paired with `rpcUser`. */
	rpcPassword?: string;
	/** Optional `fetch` override, for tests and custom transports. */
	fetcher?: typeof fetch;
}

/**
 * Configuration for {@link createBitcoinCreator}. The creator runs
 * server-side (typically in the merchant's `POST /api/checkout/bitcoin`
 * endpoint).
 */
export interface BitcoinCreatorConfig extends BitcoinRpcConfig {
	/** The merchant's payment store. The creator writes a pending record per checkout. */
	store: PaymentStore;
	/** Minutes before an unpaid invoice expires. Defaults to 15. */
	expiryMinutes?: number;
	/**
	 * Required when invoicing in any currency other than BTC. Returns the
	 * current price as `BTC per 1 unit of the invoice currency`. For example,
	 * if bitcoin is $100,000 and the invoice is in USD, this should return
	 * `1 / 100000 = 0.00001`.
	 *
	 * Coin Moebius does not call any oracle. The merchant decides where the
	 * price comes from.
	 */
	btcPerUnit?: (invoiceCurrency: string) => Promise<number>;
	/** Optional structured logger. Defaults to no-op. */
	logger?: BitcoinLogger;
}

/** Input to the creator returned by {@link createBitcoinCreator}. */
export interface BitcoinCreateInput {
	productId: string;
	/** Invoice amount in `currency` (decimal). */
	amount: number;
	/** Invoice currency: `'BTC'` for native, anything else requires `btcPerUnit`. */
	currency: string;
	metadata?: Record<string, unknown>;
}

/** Buyer-facing payment instructions returned by the creator. */
export interface BitcoinCreateResult {
	paymentId: string;
	address: string;
	/** Exact amount to send, in satoshis, as a string. */
	atomicAmount: string;
	btcAmount: number;
	uri: string;
	expiresAt: number;
}

/** Configuration for {@link createBitcoinVerifier}. */
export interface BitcoinVerifierConfig {
	/** Shared secret used by the indexer when signing webhooks and the verifier when validating them. */
	hmacSecret: string;
	/**
	 * Replay guard: max allowed difference between the webhook's signed
	 * `timestamp` and the verifier's clock, in ms. Default 5 minutes.
	 */
	freshnessToleranceMs?: number;
	/** Time source, overridable for tests. Defaults to `Date.now`. */
	now?: () => number;
}

const DEFAULT_WEBHOOK_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * The exact JSON payload the indexer POSTs and the verifier validates.
 * Exported so custom indexers and tests can build conformant payloads.
 */
export interface BitcoinWebhookPayload {
	provider: 'bitcoin';
	paymentId: string;
	/**
	 * `'pending'` while the payment is on the chain and still gathering
	 * confirmations, then one of the terminal three: `'success'`, `'partial'`,
	 * or `'failed'`.
	 */
	status: Extract<PaymentStatus, 'pending' | 'success' | 'partial' | 'failed'>;
	/** Transaction id, or `null` when the status is `'failed'` due to expiry without payment. */
	txHash: string | null;
	/** The address the buyer was given. */
	address: string;
	/** Original invoice currency (e.g. `'USD'`, `'BTC'`). */
	invoiceCurrency: string;
	/** Original invoice amount in `invoiceCurrency`. */
	invoiceAmount: number;
	/** What we asked the buyer to send, in satoshis, as a string. */
	expectedAmountAtomic: string;
	/** What arrived at the address, in satoshis, as a string. `'0'` when nothing arrived. */
	receivedAmountAtomic: string;
	/** BTC convenience field for `expectedAmountAtomic`. */
	expectedAmountBtc: number;
	/** BTC convenience field for `receivedAmountAtomic`. */
	receivedAmountBtc: number;
	confirmations: number;
	/** How many confirmations this payment needs before it settles. */
	requiredConfirmations: number;
	/** Block height the payment was first mined at, or `null` while unconfirmed or for expiry-failed. */
	blockHeight: number | null;
	timestamp: number;
}

/** Webhook verifier surface. Matches the `WebhookVerifier` contract from `coin-moebius-server`. */
export interface BitcoinVerifier {
	verify(rawBody: unknown, headers: Record<string, string | undefined>): Promise<WebhookEvent>;
}

/** Configuration for {@link createBitcoinIndexer}. */
export interface BitcoinIndexerConfig extends BitcoinRpcConfig {
	/** Merchant's payment store, the same instance the creator writes to. */
	store: PaymentStore;
	/** Full URL of the merchant's payment-webhook endpoint (where the verifier lives). */
	webhookUrl: string;
	/** Shared secret. Must match what the verifier is configured with. */
	hmacSecret: string;
	/**
	 * Confirmations required before a payment settles. Defaults to 1: once the
	 * payment is in a block it can no longer be swapped for a different
	 * transaction from the mempool. Raise it for larger sales. Blocks are ten
	 * minutes apart on average. Must be a whole number of at least 1: a payment
	 * still in the mempool can be replaced by the buyer, so it never settles.
	 */
	requiredConfirmations?: number;
	/**
	 * Extra blocks of history to read beyond `requiredConfirmations`, so a
	 * payment mined while the indexer was offline is still found when it comes
	 * back. Defaults to 144, about one day of blocks.
	 */
	scanLookbackBlocks?: number;
	/** Default polling interval for `.start()`. Defaults to 30 seconds. */
	pollIntervalMs?: number;
	/** Webhook POST retry config. Defaults: 3 attempts, starting at 500ms with exponential backoff. */
	webhookRetry?: {
		maxAttempts?: number;
		initialBackoffMs?: number;
	};
	/** Optional structured logger. */
	logger?: BitcoinLogger;
	/** Time provider, overridable for tests. Defaults to `Date.now`. */
	now?: () => number;
}

/** Runtime status snapshot returned by `indexer.status()`. */
export interface BitcoinIndexerStatus {
	lastTickAt: number | null;
	lastError: { message: string; at: number } | null;
	walletHeight: number | null;
	pendingPaymentCount: number;
	totalTicks: number;
	totalWebhooksSent: number;
	webhookErrorCount: number;
}

/** Per-tick result for callers who run the indexer on a cron (rather than via `.start()`). */
export interface BitcoinTickResult {
	walletHeight: number;
	transfersInspected: number;
	webhooksSent: number;
	errors: string[];
}

/** Indexer surface. */
export interface BitcoinIndexer {
	/** Run one polling iteration. Safe to call from a cron, a queue worker, or repeatedly. */
	tick(): Promise<BitcoinTickResult>;
	/** Start a polling loop on `pollIntervalMs`. Returns a stop function. */
	start(): () => void;
	/** In-memory status snapshot. Suitable to expose from a `/health` endpoint. */
	status(): BitcoinIndexerStatus;
}

const PAYMENT_ID_PREFIX = 'btc_';

// ============================================================================
// Creator
// ============================================================================

/**
 * Build the server-side creator. Wire it into the merchant's
 * `POST /api/checkout/bitcoin` endpoint. The endpoint receives the
 * {@link BitcoinCreateInput} from the browser provider and forwards the
 * returned {@link BitcoinCreateResult} back as the response body.
 *
 * Every checkout gets an address of its own, labeled with its payment id in
 * the wallet. The label is how the indexer knows which payment a transaction
 * belongs to.
 *
 * @example
 *   const create = createBitcoinCreator({
 *     rpcUrl: process.env.BITCOIN_RPC_URL!,
 *     wallet: 'shop',
 *     rpcUser: process.env.BITCOIN_RPC_USER,
 *     rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
 *     store: myProductionStore,
 *     btcPerUnit: async (currency) => await btcPerUnitFromMyOracle(currency),
 *   });
 */
export function createBitcoinCreator(config: BitcoinCreatorConfig) {
	const expiryMinutes = config.expiryMinutes ?? 15;
	const logger = config.logger ?? noopLogger();
	const rpc = rpcCaller(config);
	const now = Date.now;

	return async function createBitcoinPayment(
		input: BitcoinCreateInput,
	): Promise<BitcoinCreateResult> {
		const rawQuote = await invoiceToBtc(input.currency, input.amount, config.btcPerUnit);
		const quoted = roundQuoteUp(rawQuote);
		// The satoshi integer is the invoice. Every amount we hand out is read
		// back from it, so the number the buyer is told to send is exactly the
		// number that settles the invoice.
		const atomicAmount = toAtomic(quoted);
		const btcAmount = fromAtomic(BigInt(atomicAmount));

		const paymentId = PAYMENT_ID_PREFIX + toHex(randomBytes(8));
		const address = await rpc<unknown>('getnewaddress', { label: paymentId });
		if (typeof address !== 'string' || address.length === 0) {
			throw new Error('coin-moebius/bitcoin: wallet returned no address');
		}

		const expiresAt = now() + expiryMinutes * 60 * 1000;
		const uri = `bitcoin:${address}?amount=${formatAtomic(BigInt(atomicAmount))}`;

		const record: PaymentRecord = {
			status: 'pending',
			paymentId,
			provider: 'bitcoin',
			amount: input.amount,
			currency: input.currency,
			metadata: {
				...withoutIndexerFields(input.metadata ?? {}),
				productId: input.productId,
				address,
				atomicAmount,
				btcAmount,
				expiresAt,
			},
			timestamp: now(),
			createdAt: now(),
			updatedAt: now(),
		};
		await config.store.upsert(record);

		logger.info('bitcoin: created payment', { paymentId, btcAmount });

		return { paymentId, address, atomicAmount, btcAmount, uri, expiresAt };
	};
}

// ============================================================================
// Verifier
// ============================================================================

/**
 * Build the webhook verifier. Wire into the merchant's webhook handler via
 * `createVerifierRegistry().register('bitcoin', verifier.verify)`.
 *
 * The signature scheme: HMAC-SHA256 of the JSON body (exactly as received,
 * byte-for-byte if available; falls back to re-stringifying the parsed
 * object), hex-encoded, compared in constant time against the
 * `x-bitcoin-sig` header.
 */
export function createBitcoinVerifier(config: BitcoinVerifierConfig): BitcoinVerifier {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/bitcoin: hmacSecret missing on verifier config');
	}

	return {
		async verify(rawBody, headers): Promise<WebhookEvent> {
			const sig = headerValue(headers, 'x-bitcoin-sig');
			if (!sig) {
				throw new Error('coin-moebius/bitcoin: missing x-bitcoin-sig header');
			}

			let payload: BitcoinWebhookPayload;
			let canonical: string;
			if (typeof rawBody === 'string') {
				canonical = rawBody;
				try {
					payload = JSON.parse(rawBody) as BitcoinWebhookPayload;
				} catch {
					throw new Error('coin-moebius/bitcoin: body is not valid JSON');
				}
			} else if (rawBody && typeof rawBody === 'object') {
				payload = rawBody as BitcoinWebhookPayload;
				canonical = JSON.stringify(payload);
			} else {
				throw new Error('coin-moebius/bitcoin: unsupported body type');
			}

			const expected = await computeBitcoinSignature(canonical, config.hmacSecret);
			if (!timingSafeStringEqual(expected, sig)) {
				throw new Error('coin-moebius/bitcoin: invalid signature');
			}

			const tolerance = config.freshnessToleranceMs ?? DEFAULT_WEBHOOK_FRESHNESS_MS;
			const nowMs = (config.now ?? Date.now)();
			if (
				typeof payload.timestamp !== 'number' ||
				Math.abs(nowMs - payload.timestamp) > tolerance
			) {
				throw new Error('coin-moebius/bitcoin: webhook timestamp outside the freshness window');
			}

			return toPaymentResult(payload);
		},
	};
}

// ============================================================================
// Indexer
// ============================================================================

/**
 * Build the indexer. Run it inside the same private network as `bitcoind`.
 * Poll-based: `.start()` runs `.tick()` every `pollIntervalMs`.
 *
 * Every tick asks the wallet for every incoming transaction since the block
 * `requiredConfirmations + scanLookbackBlocks` below the tip, plus whatever
 * is still in the mempool, and matches each one to a payment by the label
 * the creator put on its address. Confirmation counts come from the node
 * itself, so a block that is reorganized away lowers the count instead of
 * leaving a stale one behind. A transaction the node reports as conflicted
 * (double-spent) is never counted.
 *
 * The wallet has no list of open invoices, so the store is the list: when
 * the store implements `listPending`, unpaid invoices past their
 * `expiresAt` are announced `failed`; when it does not, they stay `pending`
 * and a warning is logged once. Before an invoice is failed, the node is
 * asked directly whether anything ever reached its address, so money that
 * fell outside the lookback window is never reported as missing.
 *
 * Catch-up by design: if the indexer is offline for a stretch, the next
 * tick sees everything it missed inside the lookback window and emits the
 * webhooks then.
 *
 * @example
 *   const indexer = createBitcoinIndexer({
 *     rpcUrl: 'http://127.0.0.1:8332',
 *     wallet: 'shop',
 *     rpcUser: process.env.BITCOIN_RPC_USER,
 *     rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
 *     store: myProductionStore,
 *     webhookUrl: 'https://my-site.example/api/payment-webhook',
 *     hmacSecret: process.env.BITCOIN_HMAC_SECRET!,
 *   });
 *   const stop = indexer.start();
 *   process.on('SIGTERM', stop);
 */
export function createBitcoinIndexer(config: BitcoinIndexerConfig): BitcoinIndexer {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/bitcoin: hmacSecret missing on indexer config');
	}

	const requiredConfirmations = config.requiredConfirmations ?? 1;
	if (!Number.isInteger(requiredConfirmations) || requiredConfirmations < 1) {
		throw new Error(
			`coin-moebius/bitcoin: requiredConfirmations must be a whole number of at least 1, got ${requiredConfirmations}`,
		);
	}
	const scanLookback = config.scanLookbackBlocks ?? 144;
	const pollIntervalMs = config.pollIntervalMs ?? 30_000;
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const logger = config.logger ?? noopLogger();
	const now = config.now ?? Date.now;
	const rpc = rpcCaller(config);
	const retryConfig = {
		maxAttempts: config.webhookRetry?.maxAttempts ?? 3,
		initialBackoffMs: config.webhookRetry?.initialBackoffMs ?? 500,
	};

	const state: BitcoinIndexerStatus = {
		lastTickAt: null,
		lastError: null,
		walletHeight: null,
		pendingPaymentCount: 0,
		totalTicks: 0,
		totalWebhooksSent: 0,
		webhookErrorCount: 0,
	};

	let ticking: Promise<BitcoinTickResult> | null = null;
	let warnedAboutExpiry = false;

	async function tickInternal(): Promise<BitcoinTickResult> {
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
				logger.error('bitcoin: payment processing failed', { paymentId, message });
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
			throw new Error('coin-moebius/bitcoin: node reported no block height');
		}
		const fromHeight = Math.max(0, walletHeight - requiredConfirmations - scanLookback);
		const fromHash = await rpc<unknown>('getblockhash', [fromHeight]);
		if (typeof fromHash !== 'string') {
			throw new Error(`coin-moebius/bitcoin: node returned no hash for block ${fromHeight}`);
		}

		const reply = await rpc<unknown>('listsinceblock', { blockhash: fromHash });
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
		if (record?.provider !== 'bitcoin') return false;
		// `failed` is not terminal: an expired invoice whose money turns up days
		// later still settles. Telling that buyer to start over makes them pay twice.
		if (record.status === 'success' || record.status === 'partial') {
			return false;
		}

		const address = readStringMetadata(record, 'address');
		const counted = receipts.filter((receipt) => receipt.address === address);
		if (counted.length === 0) return false;

		const expectedAtomic = readBigIntMetadata(record, 'atomicAmount');
		const receivedAtomic = counted.reduce((sum, receipt) => sum + receipt.amount, 0n);
		const confirmations = Math.min(...counted.map((receipt) => receipt.confirmations));
		const minedHeights = counted
			.map((receipt) => receipt.blockHeight)
			.filter((height): height is number => height !== null);
		const blockHeight = minedHeights.length > 0 ? Math.min(...minedHeights) : null;

		const observation: Observation = {
			paymentId,
			record,
			expectedAtomic,
			receivedAtomic,
			confirmations,
			txHash: counted[0]?.txid ?? null,
			blockHeight,
		};

		if (confirmations < requiredConfirmations) return await announceProgress(observation);

		const status: BitcoinWebhookPayload['status'] =
			receivedAtomic >= expectedAtomic ? 'success' : 'partial';
		const winner = await claimAnnouncement(paymentId, status);
		if (!winner) return false;

		await announce(paymentId, status, payloadFor(observation, status));

		await config.store.upsert({
			...record,
			status,
			amount: status === 'partial' ? proratedInvoiceAmount(record, receivedAtomic) : record.amount,
			metadata: {
				...record.metadata,
				txHash: observation.txHash,
				receivedAtomic: receivedAtomic.toString(),
				confirmations,
			},
			timestamp: now(),
			createdAt: record.createdAt,
			updatedAt: now(),
		});

		return true;
	}

	/**
	 * Report a payment that is on the chain but not yet settled, so a buyer
	 * watching a checkout sees a confirmation count climb. The payment stays
	 * `pending` throughout. Sends only when the count actually moved.
	 */
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
		status: BitcoinWebhookPayload['status'],
	): BitcoinWebhookPayload {
		return {
			provider: 'bitcoin',
			paymentId: observation.paymentId,
			status,
			txHash: observation.txHash,
			address: readStringMetadata(observation.record, 'address'),
			invoiceCurrency: observation.record.currency,
			invoiceAmount: observation.record.amount,
			expectedAmountAtomic: observation.expectedAtomic.toString(),
			receivedAmountAtomic: observation.receivedAtomic.toString(),
			expectedAmountBtc: fromAtomic(observation.expectedAtomic),
			receivedAmountBtc: fromAtomic(observation.receivedAtomic),
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
					'bitcoin: store has no listPending, so unpaid invoices will never be marked failed',
				);
			}
			state.pendingPaymentCount = 0;
			return 0;
		}

		const pending = await config.store.listPending('bitcoin');
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
						'bitcoin: money reached an expired invoice outside the lookback window; raise scanLookbackBlocks to settle it',
						{ paymentId: record.paymentId, address },
					);
					continue;
				}

				const winner = await claimAnnouncement(record.paymentId, 'failed');
				if (!winner) continue;

				const expectedAtomic = readBigIntMetadata(record, 'atomicAmount');
				await announce(record.paymentId, 'failed', {
					provider: 'bitcoin',
					paymentId: record.paymentId,
					status: 'failed',
					txHash: null,
					address,
					invoiceCurrency: record.currency,
					invoiceAmount: record.amount,
					expectedAmountAtomic: expectedAtomic.toString(),
					receivedAmountAtomic: '0',
					expectedAmountBtc: fromAtomic(expectedAtomic),
					receivedAmountBtc: 0,
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
				logger.error('bitcoin: expiry processing failed', {
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
		// An invoice marked failed at expiry can still be paid late, and that
		// money has to be announced; only a second `failed` is a duplicate.
		return fresh.status === 'pending' || (fresh.status === 'failed' && status !== 'failed');
	}

	/**
	 * Deliver an announcement the caller has already claimed, and hand the
	 * claim back if delivery fails.
	 *
	 * The claim has to come first, or two indexers announce the same
	 * settlement twice. But a claim spent on a webhook that never arrived is
	 * the worse outcome by far: the money is real and on the chain, and no
	 * later tick would try again, so the merchant would be told at expiry that
	 * nothing ever came. Giving the claim back puts the announcement in play on
	 * the next tick, and the delivery error still reaches the tick's error list.
	 */
	async function announce(
		paymentId: string,
		status: PaymentStatus,
		payload: BitcoinWebhookPayload,
	): Promise<void> {
		try {
			await emitWebhook(payload);
		} catch (err) {
			await config.store.unmarkStatusAnnounced?.(paymentId, status);
			throw err;
		}
	}

	async function emitWebhook(payload: BitcoinWebhookPayload): Promise<void> {
		const body = JSON.stringify(payload);
		const sig = await computeBitcoinSignature(body, config.hmacSecret);

		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
			try {
				const response = await fetcher(config.webhookUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-bitcoin-sig': sig,
						'x-provider': 'bitcoin',
					},
					body,
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
		logger.error('bitcoin: webhook delivery failed', {
			paymentId: payload.paymentId,
			error: lastError?.message,
		});
		throw lastError ?? new Error('coin-moebius/bitcoin: webhook delivery failed');
	}

	return {
		tick(): Promise<BitcoinTickResult> {
			if (ticking) return ticking;
			ticking = tickInternal()
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					state.lastError = { message, at: now() };
					state.totalTicks += 1;
					logger.error('bitcoin: tick failed', { message });
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
		status(): BitcoinIndexerStatus {
			return { ...state };
		},
	};
}

// ============================================================================
// Public helpers
// ============================================================================

/** HMAC-SHA256 of `body` keyed by `hmacSecret`, hex-encoded. */
export async function computeBitcoinSignature(body: string, hmacSecret: string): Promise<string> {
	return toHex(new Uint8Array(await hmacSha256(hmacSecret, body)));
}

/**
 * How many significant digits a quote is allowed to show a buyer.
 *
 * A fixed count of decimal places cannot be right, because the last place is
 * worth whatever bitcoin is worth. Counting significant digits scales on its
 * own: it keeps the same relative accuracy however small the invoice is, and
 * it never rounds a small invoice away to nothing.
 */
const QUOTE_SIGNIFICANT_DIGITS = 6;

/**
 * Round a quote up to something a person can read, never finer than one
 * satoshi.
 *
 * Up, never down: rounding down would leave the merchant a fraction short on
 * every order, and a buyer who sends the displayed figure would land on
 * `partial`. Up costs the buyer a rounding error well under a cent and keeps
 * the displayed number payable.
 */
export function roundQuoteUp(amount: number): number {
	// Nothing to round, and log10 would not survive the attempt.
	if (!Number.isFinite(amount) || amount <= 0) return amount;
	// Where the first significant digit sits: 0 for 1.6, -5 for 0.0000163.
	const magnitude = Math.floor(Math.log10(amount));
	const places = Math.max(0, Math.min(QUOTE_SIGNIFICANT_DIGITS - 1 - magnitude, BTC_DECIMALS));
	return Number(
		formatAtomic(BigInt(atomicAt(amount, places)) * 10n ** BigInt(BTC_DECIMALS - places)),
	);
}

/**
 * BTC to satoshis, as a string. Any fraction finer than one satoshi rounds
 * up, so the merchant is never a fraction short. The amount is first settled
 * to the 15 significant digits a double reliably holds, so binary noise such
 * as `0.30000000000000004` reads as `0.3` rather than as a fraction to round.
 */
export function toAtomic(amount: number): string {
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error(`coin-moebius/bitcoin: amount must be positive, got ${amount}`);
	}
	return atomicAt(amount, BTC_DECIMALS);
}

/** Satoshis to BTC, as a number for display. The satoshi string stays canonical. */
export function fromAtomic(atomic: bigint): number {
	return Number(atomic) / 10 ** BTC_DECIMALS;
}

// ============================================================================
// Internals
// ============================================================================

type Rpc = <T>(method: string, params: unknown) => Promise<T>;

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

function rpcCaller(config: BitcoinRpcConfig): Rpc {
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

		const response = await fetcher(endpoint, { method: 'POST', headers, body });
		if (response.status === 401 || response.status === 403) {
			throw new Error(
				`coin-moebius/bitcoin: node refused ${method} (${response.status}). Check rpcUser and rpcPassword.`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(await response.text()) as unknown;
		} catch {
			throw new Error(`coin-moebius/bitcoin: node ${method} HTTP ${response.status}`);
		}
		const error = readField(parsed, 'error');
		if (typeof error === 'object' && error !== null) {
			throw new Error(
				`coin-moebius/bitcoin: node ${method} error: ${readString(error, 'message') || 'unknown'}`,
			);
		}
		if (!response.ok) {
			throw new Error(`coin-moebius/bitcoin: node ${method} HTTP ${response.status}`);
		}
		const result = readField(parsed, 'result');
		if (result === undefined) {
			throw new Error(`coin-moebius/bitcoin: node ${method} returned no result`);
		}
		return result as T;
	};
}

/**
 * One output of an incoming transaction, kept only when it can belong to a
 * checkout: a plain receive (not a mined coin), on an address labeled with a
 * payment id, and not in conflict with a transaction the chain kept instead.
 * The node reports a conflicted transaction with negative confirmations.
 */
function readReceipt(entry: object): Receipt | null {
	if (readField(entry, 'category') !== 'receive') return null;
	const paymentId = readString(entry, 'label');
	if (!paymentId.startsWith(PAYMENT_ID_PREFIX)) return null;
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
		paymentId,
		txid,
		vout,
		address: readString(entry, 'address'),
		amount,
		confirmations,
		blockHeight: confirmations > 0 && typeof blockHeight === 'number' ? blockHeight : null,
	};
}

/**
 * The node writes amounts as BTC with eight decimals. Every amount up to the
 * full 21 million BTC supply parses to a double close enough that scaling by
 * 10^8 and rounding recovers the exact satoshi count.
 */
function satoshisOf(value: unknown): bigint | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
	return BigInt(Math.round(value * 10 ** BTC_DECIMALS));
}

/**
 * Fields the indexer writes onto a record as a payment progresses. Checkout
 * metadata usually comes from the buyer's browser, so none of these may be
 * seeded from it: a planted `confirmations` count would silence the
 * buyer-facing progress updates, and the rest would misreport the payment.
 */
const INDEXER_FIELDS = new Set(['txHash', 'receivedAtomic', 'confirmations', 'failureReason']);

function withoutIndexerFields(metadata: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(metadata).filter(([key]) => !INDEXER_FIELDS.has(key)));
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

async function invoiceToBtc(
	currency: string,
	amount: number,
	btcPerUnit?: (invoiceCurrency: string) => Promise<number>,
): Promise<number> {
	if (currency.toUpperCase() === 'BTC') return amount;
	if (!btcPerUnit) {
		throw new Error(
			`coin-moebius/bitcoin: invoice currency '${currency}' requires btcPerUnit on creator config`,
		);
	}
	const unitsPerCurrency = await btcPerUnit(currency);
	if (!(unitsPerCurrency > 0)) {
		throw new Error(
			`coin-moebius/bitcoin: btcPerUnit('${currency}') returned ${unitsPerCurrency}; must be positive`,
		);
	}
	return amount * unitsPerCurrency;
}

/** Whole BTC to an integer count of units at `places` decimals, rounding any finer fraction up. */
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

/** Map the indexer's webhook payload onto the SDK's canonical `WebhookEvent` (payment kind). */
function toPaymentResult(payload: BitcoinWebhookPayload): WebhookEvent {
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
		provider: 'bitcoin',
		amount: payload.status === 'failed' ? 0 : amount,
		currency: payload.invoiceCurrency,
		metadata: {
			address: payload.address,
			txHash: payload.txHash,
			confirmations: payload.confirmations,
			requiredConfirmations: payload.requiredConfirmations,
			blockHeight: payload.blockHeight,
			expectedAmountBtc: payload.expectedAmountBtc,
			receivedAmountBtc: payload.receivedAmountBtc,
			expectedAmountAtomic: payload.expectedAmountAtomic,
			receivedAmountAtomic: payload.receivedAmountAtomic,
		},
		timestamp: payload.timestamp,
		raw: payload,
	};
}

function proratedInvoiceAmount(record: PaymentRecord, receivedAtomic: bigint): number {
	return proratedFromAtomic(
		record.amount,
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
	if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 0n;
	return BigInt(raw);
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

function noopLogger(): BitcoinLogger {
	return {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
	};
}
