/**
 * Zano server-side primitives for Coin Moebius.
 *
 * Four exports, one per responsibility:
 *
 *   1. {@link createZanoCreator}: invoked from the merchant's "checkout"
 *      serverless function. Asks the merchant's `simplewallet` RPC for an
 *      integrated address (their address with a fresh 8-byte payment id
 *      folded in), persists a pending record to the merchant's
 *      {@link PaymentStore}, and returns the buyer-facing instructions.
 *      Charges in ZANO or in any Zano asset (Freedom Dollar included); the
 *      asset's decimals come from the merchant's own wallet, never from a
 *      table in this package.
 *
 *   2. {@link createZanoVerifier}: invoked from the merchant's
 *      "payment-webhook" serverless function. Validates the HMAC-signed
 *      payload that the indexer posts and returns a normalized
 *      `WebhookEvent`.
 *
 *   3. {@link createZanoIndexer}: a long-running process the merchant hosts
 *      next to `simplewallet` (same box or same private network). Reads the
 *      wallet's transfer history, matches payments by payment id and asset,
 *      and POSTs HMAC-signed webhooks. Exposes `.tick()`, `.start()`, and
 *      `.status()`.
 *
 *   4. {@link computeZanoSignature}: the HMAC helper so custom indexers and
 *      tests can produce signatures the verifier accepts.
 *
 * Zano's wallet RPC refuses to start without authentication unless the
 * operator passes `--unsecure-no-auth`. Pass `jwtSecret` (the value given
 * to `simplewallet --jwt-secret`) and every call carries the
 * `Zano-Access-Token` header the wallet expects. See
 * {@link zanoAccessToken}.
 */

import type { PaymentStatus, WebhookEvent } from '@aquarian-metals/coin-moebius-core';
import type { PaymentRecord, PaymentStore } from '@aquarian-metals/coin-moebius-server';
import {
	ZANO_ASSET_ID,
	ZANO_NATIVE_ASSET,
	formatAtomic,
	isZanoAssetId,
	type ZanoAsset,
} from './assets.js';

export {
	ZANO_ASSET_ID,
	FREEDOM_DOLLAR_ASSET_ID,
	ZANO_NATIVE_ASSET,
	formatAtomic,
} from './assets.js';
export type { ZanoAsset } from './assets.js';

// ============================================================================
// Public types
// ============================================================================

/** Minimal logger contract. Default is a no-op; ops teams inject pino, etc. */
export interface ZanoLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

/** How to reach the merchant's `simplewallet` RPC. Shared by the creator and the indexer. */
export interface ZanoWalletRpcConfig {
	/** Base URL of the wallet RPC (e.g. `http://127.0.0.1:11212`). `/json_rpc` is appended. */
	walletRpcUrl: string;
	/**
	 * The secret given to `simplewallet --jwt-secret`. When set, every call
	 * carries a one-time `Zano-Access-Token`. Omit only when the wallet runs
	 * with `--unsecure-no-auth` on a private interface.
	 */
	jwtSecret?: string;
	/** Optional `fetch` override, for tests and custom transports. */
	fetcher?: typeof fetch;
}

/**
 * Configuration for {@link createZanoCreator}. The creator runs server-side
 * (typically in the merchant's `POST /api/checkout/zano` endpoint).
 */
export interface ZanoCreatorConfig extends ZanoWalletRpcConfig {
	/** The merchant's payment store. The creator writes a pending record per checkout. */
	store: PaymentStore;
	/** Minutes before an unpaid invoice expires. Defaults to 15. */
	expiryMinutes?: number;
	/**
	 * Price feed. Returns how many whole units of `asset` one unit of the
	 * invoice currency buys. Charging 19.99 USD in Freedom Dollar returns 1;
	 * charging USD in ZANO returns `1 / zanoPriceInUsd`. Not called when the
	 * invoice currency already is the asset's ticker.
	 *
	 * Coin Moebius does not call any oracle. The merchant decides where the
	 * price comes from.
	 */
	rate?: (invoiceCurrency: string, asset: ZanoAsset) => Promise<number>;
	/** Optional structured logger. Defaults to no-op. */
	logger?: ZanoLogger;
}

/** Input to the creator returned by {@link createZanoCreator}. */
export interface ZanoCreateInput {
	productId: string;
	/** Invoice amount in `currency` (decimal). */
	amount: number;
	/** Invoice currency: `'ZANO'`, `'FUSD'`, `'USD'`, anything the `rate` callback understands. */
	currency: string;
	/** Asset the buyer pays with. Omit for ZANO. */
	assetId?: string;
	metadata?: Record<string, unknown>;
}

/** Buyer-facing payment instructions returned by the creator. */
export interface ZanoCreateResult {
	paymentId: string;
	/** Integrated address carrying the payment id. */
	address: string;
	/** The 8-byte payment id, hex. What the chain reports back on the payment. */
	paymentReference: string;
	assetId: string;
	ticker: string;
	decimalPoint: number;
	atomicAmount: string;
	assetAmount: number;
	uri: string;
	expiresAt: number;
}

/** Configuration for {@link createZanoVerifier}. */
export interface ZanoVerifierConfig {
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

/** Money that arrived on the payment id in an asset other than the one invoiced. */
export interface ZanoOtherAsset {
	assetId: string;
	amountAtomic: string;
}

/**
 * The exact JSON payload the indexer POSTs and the verifier validates.
 * Exported so custom indexers and tests can build conformant payloads.
 */
export interface ZanoWebhookPayload {
	provider: 'zano';
	paymentId: string;
	/**
	 * `'pending'` while the payment is on the chain and still gathering
	 * confirmations, then one of the terminal three: `'success'`, `'partial'`,
	 * or `'failed'`.
	 */
	status: Extract<PaymentStatus, 'pending' | 'success' | 'partial' | 'failed'>;
	/** Transaction hash, or `null` when the status is `'failed'` due to expiry without payment. */
	txHash: string | null;
	/** The integrated address the buyer was given. */
	address: string;
	/** The asset invoiced. Only money in this asset counts toward the amount. */
	assetId: string;
	ticker: string;
	decimalPoint: number;
	/** Original invoice currency (e.g. `'USD'`, `'ZANO'`). */
	invoiceCurrency: string;
	/** Original invoice amount in `invoiceCurrency`. */
	invoiceAmount: number;
	/** What we asked the buyer to send, in the asset's atomic units, as a string. */
	expectedAmountAtomic: string;
	/** What arrived in the invoiced asset, in atomic units, as a string. `'0'` when nothing arrived. */
	receivedAmountAtomic: string;
	/** Whole-unit convenience field for `expectedAmountAtomic`. */
	expectedAmount: number;
	/** Whole-unit convenience field for `receivedAmountAtomic`. */
	receivedAmount: number;
	/**
	 * Money that arrived on this payment id in some other asset, for example
	 * ZANO sent to a Freedom Dollar invoice. Never counted toward the amount.
	 * Present only when something else arrived.
	 */
	otherAssets?: ZanoOtherAsset[];
	confirmations: number;
	/** How many confirmations this payment needs before it settles. */
	requiredConfirmations: number;
	/** Block height the payment was first observed at, or `null` while unconfirmed or for expiry-failed. */
	blockHeight: number | null;
	timestamp: number;
}

/** Webhook verifier surface. Matches the `WebhookVerifier` contract from `coin-moebius-server`. */
export interface ZanoVerifier {
	verify(rawBody: unknown, headers: Record<string, string | undefined>): Promise<WebhookEvent>;
}

/** Configuration for {@link createZanoIndexer}. */
export interface ZanoIndexerConfig extends ZanoWalletRpcConfig {
	/** Merchant's payment store, the same instance the creator writes to. */
	store: PaymentStore;
	/** Full URL of the merchant's payment-webhook endpoint (where the verifier lives). */
	webhookUrl: string;
	/** Shared secret. Must match what the verifier is configured with. */
	hmacSecret: string;
	/**
	 * Confirmations required before a payment settles. Zano's own integration
	 * guide says credit nothing under 10. Defaults to 10. Blocks are a minute
	 * apart, so that is roughly ten minutes.
	 */
	requiredConfirmations?: number;
	/** Extra blocks of history to read beyond `requiredConfirmations` as a safety margin. Defaults to 20. */
	scanLookbackBlocks?: number;
	/** Transfers per wallet RPC page. Defaults to 50. */
	pageSize?: number;
	/** Upper bound on pages read per tick. Defaults to 20. */
	maxPages?: number;
	/** Default polling interval for `.start()`. Defaults to 30 seconds. */
	pollIntervalMs?: number;
	/** Webhook POST retry config. Defaults: 3 attempts, starting at 500ms with exponential backoff. */
	webhookRetry?: {
		maxAttempts?: number;
		initialBackoffMs?: number;
	};
	/** Optional structured logger. */
	logger?: ZanoLogger;
	/** Time provider, overridable for tests. Defaults to `Date.now`. */
	now?: () => number;
}

/** Runtime status snapshot returned by `indexer.status()`. */
export interface ZanoIndexerStatus {
	lastTickAt: number | null;
	lastError: { message: string; at: number } | null;
	walletHeight: number | null;
	pendingPaymentCount: number;
	totalTicks: number;
	totalWebhooksSent: number;
	webhookErrorCount: number;
}

/** Per-tick result for callers who run the indexer on a cron (rather than via `.start()`). */
export interface ZanoTickResult {
	walletHeight: number;
	transfersInspected: number;
	webhooksSent: number;
	errors: string[];
}

/** Indexer surface. */
export interface ZanoIndexer {
	/** Run one polling iteration. Safe to call from a cron, a queue worker, or repeatedly. */
	tick(): Promise<ZanoTickResult>;
	/** Start a polling loop on `pollIntervalMs`. Returns a stop function. */
	start(): () => void;
	/** In-memory status snapshot. Suitable to expose from a `/health` endpoint. */
	status(): ZanoIndexerStatus;
}

const PAYMENT_ID_PREFIX = 'zano_';

// ============================================================================
// Creator
// ============================================================================

/**
 * Build the server-side creator. Wire it into the merchant's
 * `POST /api/checkout/zano` endpoint. The endpoint receives the
 * {@link ZanoCreateInput} from the browser provider and forwards the
 * returned {@link ZanoCreateResult} back as the response body.
 *
 * @example
 *   const create = createZanoCreator({
 *     walletRpcUrl: process.env.ZANO_WALLET_RPC_URL!,
 *     jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
 *     store: myProductionStore,
 *     rate: async (currency, asset) => {
 *       if (asset.assetId === FREEDOM_DOLLAR_ASSET_ID && currency === 'USD') return 1;
 *       return await unitsOfAssetPerCurrencyFromMyOracle(currency, asset);
 *     },
 *   });
 */
export function createZanoCreator(config: ZanoCreatorConfig) {
	const expiryMinutes = config.expiryMinutes ?? 15;
	const logger = config.logger ?? noopLogger();
	const rpc = walletRpcCaller(config);
	const now = Date.now;

	return async function createZanoPayment(input: ZanoCreateInput): Promise<ZanoCreateResult> {
		const asset = await resolveAsset(rpc, input.assetId);
		const quoted = await invoiceToAsset(input.currency, input.amount, asset, config.rate);
		// The atomic integer is the invoice. `toAtomic` rounds any fraction
		// finer than the asset carries upward, so the quote and the requirement
		// differ whenever a rate does not land cleanly on the asset's decimals.
		// Every amount we hand out is read back from the atomic value, so the
		// number the buyer is told to send is exactly the number that settles
		// the invoice. Quoting the pre-rounding float here would ask the buyer
		// for one atomic unit less than we then require, and pay them a partial.
		const atomicAmount = toAtomic(quoted, asset.decimalPoint);
		const assetAmount = fromAtomic(BigInt(atomicAmount), asset.decimalPoint);

		const minted = await rpc<{ integrated_address?: unknown; payment_id?: unknown }>(
			'make_integrated_address',
			{ payment_id: randomPaymentId() },
		);
		const address = readString(minted, 'integrated_address');
		const paymentReference = readString(minted, 'payment_id').toLowerCase();
		if (!address || !isPaymentId(paymentReference)) {
			throw new Error('coin-moebius/zano: wallet returned no integrated address');
		}

		const paymentId = PAYMENT_ID_PREFIX + paymentReference;
		const expiresAt = now() + expiryMinutes * 60 * 1000;
		const uri = paymentUri(address, atomicAmount, asset);

		const record: PaymentRecord = {
			status: 'pending',
			paymentId,
			provider: 'zano',
			amount: input.amount,
			currency: input.currency,
			metadata: {
				...(input.metadata ?? {}),
				productId: input.productId,
				address,
				paymentReference,
				assetId: asset.assetId,
				ticker: asset.ticker,
				decimalPoint: asset.decimalPoint,
				atomicAmount,
				assetAmount,
				expiresAt,
			},
			timestamp: now(),
			createdAt: now(),
			updatedAt: now(),
		};
		await config.store.upsert(record);

		logger.info('zano: created payment', { paymentId, ticker: asset.ticker, assetAmount });

		return {
			paymentId,
			address,
			paymentReference,
			assetId: asset.assetId,
			ticker: asset.ticker,
			decimalPoint: asset.decimalPoint,
			atomicAmount,
			assetAmount,
			uri,
			expiresAt,
		};
	};
}

/**
 * ZANO needs no lookup. Any other asset is added to the wallet's local
 * whitelist, which the wallet must hold anyway to report the asset's
 * incoming transfers, and the reply carries the asset's own descriptor
 * (ticker and decimals) straight from the chain. Adding an asset the
 * wallet already knows is a no-op that still returns the descriptor.
 */
async function resolveAsset(rpc: WalletRpc, assetId: string | undefined): Promise<ZanoAsset> {
	if (assetId === undefined || assetId.toLowerCase() === ZANO_ASSET_ID) return ZANO_NATIVE_ASSET;
	if (!isZanoAssetId(assetId.toLowerCase())) {
		throw new Error(`coin-moebius/zano: '${assetId}' is not a Zano asset id (64 hex characters)`);
	}

	const id = assetId.toLowerCase();
	const reply = await rpc<{ status?: unknown; asset_descriptor?: unknown }>(
		'assets_whitelist_add',
		{
			asset_id: id,
		},
	);
	const descriptor = reply.asset_descriptor;
	if (reply.status !== 'OK' || typeof descriptor !== 'object' || descriptor === null) {
		throw new Error(
			`coin-moebius/zano: asset ${id} is not on the chain the wallet is connected to`,
		);
	}
	const ticker = readString(descriptor, 'ticker');
	const decimalPoint = readNumber(descriptor, 'decimal_point');
	if (!ticker || decimalPoint === null || decimalPoint < 0 || decimalPoint > 18) {
		throw new Error(`coin-moebius/zano: wallet returned no usable descriptor for asset ${id}`);
	}
	return { assetId: id, ticker, decimalPoint };
}

// ============================================================================
// Verifier
// ============================================================================

/**
 * Build the webhook verifier. Wire into the merchant's webhook handler via
 * `createVerifierRegistry().register('zano', verifier.verify)`.
 *
 * The signature scheme: HMAC-SHA256 of the JSON body (exactly as received,
 * byte-for-byte if available; falls back to re-stringifying the parsed
 * object), hex-encoded, compared in constant time against the
 * `x-zano-sig` header.
 */
export function createZanoVerifier(config: ZanoVerifierConfig): ZanoVerifier {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/zano: hmacSecret missing on verifier config');
	}

	return {
		async verify(rawBody, headers): Promise<WebhookEvent> {
			const sig = headerValue(headers, 'x-zano-sig');
			if (!sig) {
				throw new Error('coin-moebius/zano: missing x-zano-sig header');
			}

			let payload: ZanoWebhookPayload;
			let canonical: string;
			if (typeof rawBody === 'string') {
				canonical = rawBody;
				try {
					payload = JSON.parse(rawBody) as ZanoWebhookPayload;
				} catch {
					throw new Error('coin-moebius/zano: body is not valid JSON');
				}
			} else if (rawBody && typeof rawBody === 'object') {
				payload = rawBody as ZanoWebhookPayload;
				canonical = JSON.stringify(payload);
			} else {
				throw new Error('coin-moebius/zano: unsupported body type');
			}

			const expected = await computeZanoSignature(canonical, config.hmacSecret);
			if (!timingSafeStringEqual(expected, sig)) {
				throw new Error('coin-moebius/zano: invalid signature');
			}

			const tolerance = config.freshnessToleranceMs ?? DEFAULT_WEBHOOK_FRESHNESS_MS;
			const nowMs = (config.now ?? Date.now)();
			if (
				typeof payload.timestamp !== 'number' ||
				Math.abs(nowMs - payload.timestamp) > tolerance
			) {
				throw new Error('coin-moebius/zano: webhook timestamp outside the freshness window');
			}

			return toPaymentResult(payload);
		},
	};
}

// ============================================================================
// Indexer
// ============================================================================

/**
 * Build the indexer. Run it inside the same private network as
 * `simplewallet`. Poll-based: `.start()` runs `.tick()` every
 * `pollIntervalMs`. Zano's wallet has no push hook, so polling is the whole
 * mechanism.
 *
 * Every tick reads the wallet's recent transfer history newest first, stops
 * once it is past `requiredConfirmations + scanLookbackBlocks` blocks of
 * depth, and matches each payment id it finds against the store. The
 * wallet keeps no record of the payment ids it hands out, so the store is
 * the only list of open invoices: when the store implements
 * `listPending`, unpaid invoices past their `expiresAt` are announced
 * `failed`; when it does not, they stay `pending` and a warning is logged
 * once.
 *
 * Catch-up by design: if the indexer is offline for a stretch, the next
 * tick sees everything it missed inside the lookback window and emits the
 * webhooks then.
 *
 * @example
 *   const indexer = createZanoIndexer({
 *     walletRpcUrl: 'http://127.0.0.1:11212',
 *     jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
 *     store: myProductionStore,
 *     webhookUrl: 'https://my-site.example/api/payment-webhook',
 *     hmacSecret: process.env.ZANO_HMAC_SECRET!,
 *   });
 *   const stop = indexer.start();
 *   process.on('SIGTERM', stop);
 */
export function createZanoIndexer(config: ZanoIndexerConfig): ZanoIndexer {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/zano: hmacSecret missing on indexer config');
	}

	const requiredConfirmations = config.requiredConfirmations ?? 10;
	const scanLookback = config.scanLookbackBlocks ?? 20;
	const pageSize = config.pageSize ?? 50;
	const maxPages = config.maxPages ?? 20;
	const pollIntervalMs = config.pollIntervalMs ?? 30_000;
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const logger = config.logger ?? noopLogger();
	const now = config.now ?? Date.now;
	const rpc = walletRpcCaller(config);
	const retryConfig = {
		maxAttempts: config.webhookRetry?.maxAttempts ?? 3,
		initialBackoffMs: config.webhookRetry?.initialBackoffMs ?? 500,
	};

	const state: ZanoIndexerStatus = {
		lastTickAt: null,
		lastError: null,
		walletHeight: null,
		pendingPaymentCount: 0,
		totalTicks: 0,
		totalWebhooksSent: 0,
		webhookErrorCount: 0,
	};

	let ticking: Promise<ZanoTickResult> | null = null;
	let warnedAboutExpiry = false;

	async function tickInternal(): Promise<ZanoTickResult> {
		const tickStartedAt = now();
		const errors: string[] = [];
		let webhooksSent = 0;

		const { walletHeight, transfers } = await readRecentTransfers();
		state.walletHeight = walletHeight;

		const observed = groupByPaymentReference(transfers);

		for (const [paymentReference, txs] of observed) {
			const paymentId = PAYMENT_ID_PREFIX + paymentReference;
			try {
				const sent = await processPaymentChainState(paymentId, txs, walletHeight);
				if (sent) webhooksSent += 1;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`paymentId=${paymentId}: ${message}`);
				logger.error('zano: payment processing failed', { paymentId, message });
			}
		}

		webhooksSent += await sweepExpired(observed);

		state.totalTicks += 1;
		state.totalWebhooksSent += webhooksSent;
		state.lastTickAt = tickStartedAt;
		state.lastError = errors.length === 0 ? null : { message: errors[0], at: tickStartedAt };

		return {
			walletHeight,
			transfersInspected: transfers.length,
			webhooksSent,
			errors,
		};
	}

	async function readRecentTransfers(): Promise<{
		walletHeight: number;
		transfers: WalletTransfer[];
	}> {
		let walletHeight = 0;
		let minHeight = 0;
		const byHash = new Map<string, WalletTransfer>();

		for (let page = 0; page < maxPages; page++) {
			const reply = await rpc<{ pi?: unknown; transfers?: unknown }>('get_recent_txs_and_info3', {
				offset: page * pageSize,
				count: pageSize,
				update_provision_info: page === 0,
				exclude_mining_txs: true,
				exclude_unconfirmed: false,
				order: 'FROM_END_TO_BEGIN',
			});

			if (page === 0) {
				const height = readNumber(reply.pi, 'curent_height');
				if (height === null) {
					throw new Error('coin-moebius/zano: wallet-rpc reported no height');
				}
				walletHeight = height;
				minHeight = Math.max(0, walletHeight - requiredConfirmations - scanLookback);
			}

			const entries = readArray(reply, 'transfers').map(readTransfer).filter(isPresent);
			let oldest = Number.POSITIVE_INFINITY;
			for (const transfer of entries) {
				const known = byHash.get(transfer.txHash);
				if (!known || (known.height === 0 && transfer.height > 0)) {
					byHash.set(transfer.txHash, transfer);
				}
				if (transfer.height > 0) oldest = Math.min(oldest, transfer.height);
			}

			if (entries.length < pageSize || oldest <= minHeight) break;
		}

		return { walletHeight, transfers: [...byHash.values()] };
	}

	async function processPaymentChainState(
		paymentId: string,
		txs: ObservedTx[],
		walletHeight: number,
	): Promise<boolean> {
		const record = await config.store.get(paymentId);
		if (record?.provider !== 'zano') return false;
		if (record.status === 'success' || record.status === 'partial' || record.status === 'failed') {
			return false;
		}

		const asset = readAssetMetadata(record);
		const expectedAtomic = readBigIntMetadata(record, 'atomicAmount');

		let receivedAtomic = 0n;
		const others = new Map<string, bigint>();
		for (const tx of txs) {
			for (const income of tx.income) {
				if (income.assetId === asset.assetId) {
					receivedAtomic += income.amount;
				} else {
					others.set(income.assetId, (others.get(income.assetId) ?? 0n) + income.amount);
				}
			}
		}
		const otherAssets = [...others].map(([assetId, amount]) => ({
			assetId,
			amountAtomic: amount.toString(),
		}));

		const counted = txs.filter((tx) => tx.income.some((one) => one.assetId === asset.assetId));
		if (counted.length === 0) {
			if (otherAssets.length > 0) {
				logger.warn('zano: payment received in an asset that was not invoiced', {
					paymentId,
					otherAssets,
				});
			}
			return false;
		}

		const confirmations = Math.min(...counted.map((tx) => confirmationsOf(tx, walletHeight)));
		const confirmedHeights = counted.map((tx) => tx.height).filter((height) => height > 0);
		const blockHeight = confirmedHeights.length > 0 ? Math.min(...confirmedHeights) : null;
		const firstTxHash = counted[0]?.txHash ?? null;

		const observation = {
			paymentId,
			record,
			asset,
			expectedAtomic,
			receivedAtomic,
			otherAssets,
			confirmations,
			txHash: firstTxHash,
			blockHeight,
		};

		if (confirmations < requiredConfirmations) return await announceProgress(observation);

		const status: ZanoWebhookPayload['status'] =
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
				txHash: firstTxHash,
				receivedAtomic: receivedAtomic.toString(),
				confirmations,
				...(otherAssets.length > 0 ? { otherAssets } : {}),
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
				...(observation.otherAssets.length > 0 ? { otherAssets: observation.otherAssets } : {}),
			},
			timestamp: now(),
			createdAt: observation.record.createdAt,
			updatedAt: now(),
		});

		return true;
	}

	function payloadFor(
		observation: Observation,
		status: ZanoWebhookPayload['status'],
	): ZanoWebhookPayload {
		return {
			provider: 'zano',
			paymentId: observation.paymentId,
			status,
			txHash: observation.txHash,
			address: readStringMetadata(observation.record, 'address'),
			assetId: observation.asset.assetId,
			ticker: observation.asset.ticker,
			decimalPoint: observation.asset.decimalPoint,
			invoiceCurrency: observation.record.currency,
			invoiceAmount: observation.record.amount,
			expectedAmountAtomic: observation.expectedAtomic.toString(),
			receivedAmountAtomic: observation.receivedAtomic.toString(),
			expectedAmount: fromAtomic(observation.expectedAtomic, observation.asset.decimalPoint),
			receivedAmount: fromAtomic(observation.receivedAtomic, observation.asset.decimalPoint),
			...(observation.otherAssets.length > 0 ? { otherAssets: observation.otherAssets } : {}),
			confirmations: observation.confirmations,
			requiredConfirmations,
			blockHeight: observation.blockHeight,
			timestamp: now(),
		};
	}

	async function sweepExpired(observed: Map<string, ObservedTx[]>): Promise<number> {
		if (!config.store.listPending) {
			if (!warnedAboutExpiry) {
				warnedAboutExpiry = true;
				logger.warn(
					'zano: store has no listPending, so unpaid invoices will never be marked failed',
				);
			}
			state.pendingPaymentCount = 0;
			return 0;
		}

		const pending = await config.store.listPending('zano');
		let sent = 0;
		let stillOpen = 0;

		for (const record of pending) {
			if (record.status !== 'pending') continue;
			const paymentReference = readStringMetadata(record, 'paymentReference');
			if (observed.has(paymentReference)) {
				stillOpen += 1;
				continue;
			}
			const expiresAt = readNumberMetadata(record, 'expiresAt');
			if (expiresAt === null || now() < expiresAt) {
				stillOpen += 1;
				continue;
			}

			const winner = await claimAnnouncement(record.paymentId, 'failed');
			if (!winner) continue;

			const asset = readAssetMetadata(record);
			const expectedAtomic = readBigIntMetadata(record, 'atomicAmount');
			await announce(record.paymentId, 'failed', {
				provider: 'zano',
				paymentId: record.paymentId,
				status: 'failed',
				txHash: null,
				address: readStringMetadata(record, 'address'),
				assetId: asset.assetId,
				ticker: asset.ticker,
				decimalPoint: asset.decimalPoint,
				invoiceCurrency: record.currency,
				invoiceAmount: record.amount,
				expectedAmountAtomic: expectedAtomic.toString(),
				receivedAmountAtomic: '0',
				expectedAmount: fromAtomic(expectedAtomic, asset.decimalPoint),
				receivedAmount: 0,
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
		}

		state.pendingPaymentCount = stillOpen;
		return sent;
	}

	async function claimAnnouncement(paymentId: string, status: PaymentStatus): Promise<boolean> {
		if (config.store.markStatusAnnounced) {
			return await config.store.markStatusAnnounced(paymentId, status);
		}
		const fresh = await config.store.get(paymentId);
		if (!fresh) return false;
		return fresh.status === 'pending';
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
		payload: ZanoWebhookPayload,
	): Promise<void> {
		try {
			await emitWebhook(payload);
		} catch (err) {
			await config.store.unmarkStatusAnnounced?.(paymentId, status);
			throw err;
		}
	}

	async function emitWebhook(payload: ZanoWebhookPayload): Promise<void> {
		const body = JSON.stringify(payload);
		const sig = await computeZanoSignature(body, config.hmacSecret);

		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
			try {
				const response = await fetcher(config.webhookUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-zano-sig': sig,
						'x-provider': 'zano',
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
		logger.error('zano: webhook delivery failed', {
			paymentId: payload.paymentId,
			error: lastError?.message,
		});
		throw lastError ?? new Error('coin-moebius/zano: webhook delivery failed');
	}

	function confirmationsOf(tx: ObservedTx, walletHeight: number): number {
		return tx.height === 0 ? 0 : Math.max(0, walletHeight - tx.height);
	}

	return {
		tick(): Promise<ZanoTickResult> {
			if (ticking) return ticking;
			ticking = tickInternal()
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					state.lastError = { message, at: now() };
					state.totalTicks += 1;
					logger.error('zano: tick failed', { message });
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
		status(): ZanoIndexerStatus {
			return { ...state };
		},
	};
}

// ============================================================================
// Public helpers
// ============================================================================

/** HMAC-SHA256 of `body` keyed by `hmacSecret`, hex-encoded. */
export async function computeZanoSignature(body: string, hmacSecret: string): Promise<string> {
	return toHex(new Uint8Array(await hmacSha256(hmacSecret, body)));
}

/**
 * Build the one-time `Zano-Access-Token` header value that `simplewallet
 * --jwt-secret` requires on every RPC call: an HS256 JWT whose claims are
 * the SHA-256 of the exact request body, a random salt the wallet refuses
 * to see twice, and a one-minute expiry. Exported for custom transports.
 */
export async function zanoAccessToken(
	body: string,
	jwtSecret: string,
	now: () => number = Date.now,
): Promise<string> {
	const header = base64Std(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
	const claims = {
		body_hash: toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytesOf(body)))),
		salt: toHex(randomBytes(32)),
		exp: Math.floor(now() / 1000) + 60,
	};
	const payload = base64Std(new TextEncoder().encode(JSON.stringify(claims)));
	const signature = base64Std(new Uint8Array(await hmacSha256(jwtSecret, `${header}.${payload}`)));
	return `${header}.${payload}.${signature}`;
}

/**
 * Whole units to atomic units at the asset's precision, as a string. Any
 * fraction finer than the asset carries rounds up, so the merchant is never
 * a fraction short. The amount is first settled to the 15 significant
 * digits a double reliably holds, so binary noise such as
 * `0.30000000000000004` reads as `0.3` rather than as a fraction to round.
 */
export function toAtomic(amount: number, decimalPoint: number): string {
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error(`coin-moebius/zano: amount must be positive, got ${amount}`);
	}
	const { whole, fraction } = decimalDigits(Number(amount.toPrecision(15)));
	const kept = fraction.slice(0, decimalPoint).padEnd(decimalPoint, '0');
	const dropped = fraction.slice(decimalPoint);
	let atomic = BigInt(whole) * 10n ** BigInt(decimalPoint) + BigInt(kept || '0');
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

/** Atomic units to whole units, as a number for display. The atomic string stays canonical. */
export function fromAtomic(atomic: bigint, decimalPoint: number): number {
	return Number(atomic) / 10 ** decimalPoint;
}

// ============================================================================
// Internals
// ============================================================================

type WalletRpc = <T>(method: string, params: unknown) => Promise<T>;

interface WalletIncome {
	assetId: string;
	amount: bigint;
}

interface WalletTransfer {
	txHash: string;
	height: number;
	byPaymentId: { paymentId: string; income: WalletIncome[] }[];
}

interface ObservedTx {
	txHash: string;
	height: number;
	income: WalletIncome[];
}

interface Observation {
	paymentId: string;
	record: PaymentRecord;
	asset: ZanoAsset;
	expectedAtomic: bigint;
	receivedAtomic: bigint;
	otherAssets: ZanoOtherAsset[];
	confirmations: number;
	txHash: string | null;
	blockHeight: number | null;
}

function walletRpcCaller(config: ZanoWalletRpcConfig): WalletRpc {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const base = config.walletRpcUrl.replace(/\/+$/, '');
	const endpoint = base.endsWith('/json_rpc') ? base : `${base}/json_rpc`;

	return async <T>(method: string, params: unknown): Promise<T> => {
		const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method, params });
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (config.jwtSecret)
			headers['Zano-Access-Token'] = await zanoAccessToken(body, config.jwtSecret);

		const response = await fetcher(endpoint, { method: 'POST', headers, body });
		if (response.status === 401) {
			throw new Error(
				`coin-moebius/zano: wallet-rpc ${method} refused the request (401). Pass the wallet's --jwt-secret as jwtSecret.`,
			);
		}
		if (!response.ok) {
			throw new Error(`coin-moebius/zano: wallet-rpc ${method} HTTP ${response.status}`);
		}

		const parsed = parseJsonKeepingBigIntegers(await response.text());
		const error = readField(parsed, 'error');
		if (typeof error === 'object' && error !== null) {
			throw new Error(
				`coin-moebius/zano: wallet-rpc ${method} error: ${readString(error, 'message') || 'unknown'}`,
			);
		}
		const result = readField(parsed, 'result');
		if (result === undefined) {
			throw new Error(`coin-moebius/zano: wallet-rpc ${method} returned no result`);
		}
		return result as T;
	};
}

/**
 * Zano amounts are unsigned 64-bit integers and arrive as bare JSON
 * numbers. `JSON.parse` would round anything past 2^53 (about 9,007 ZANO in
 * atomic units), so integers of 16 or more digits are quoted before
 * parsing and read back through `BigInt`.
 *
 * A run of digits only counts as a whole number when nothing numeric sits on
 * either side of it. The tail of a decimal (`1.2345678901234567`) and the
 * digits after a sign or an exponent are part of a number already being
 * written, and quoting them mid-literal produces text `JSON.parse` rejects —
 * which would throw on every tick and stop the indexer for good. Amounts are
 * unsigned, so a signed run is never an amount and is left to `JSON.parse`.
 */
function parseJsonKeepingBigIntegers(text: string): unknown {
	let out = '';
	let inString = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			out += char;
			if (char === '\\') {
				out += text[++i] ?? '';
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}

		if (char >= '0' && char <= '9') {
			let end = i;
			while (end < text.length && text[end] >= '0' && text[end] <= '9') end++;
			const digits = text.slice(i, end);
			const next = text[end];
			const prev = out[out.length - 1];
			const startsALiteral =
				prev !== '.' && prev !== 'e' && prev !== 'E' && prev !== '-' && prev !== '+';
			const endsALiteral = next !== '.' && next !== 'e' && next !== 'E';
			out += startsALiteral && endsALiteral && digits.length >= 16 ? `"${digits}"` : digits;
			i = end - 1;
			continue;
		}

		out += char;
	}

	return JSON.parse(out) as unknown;
}

function readTransfer(entry: unknown): WalletTransfer | null {
	if (typeof entry !== 'object' || entry === null) return null;
	const txHash = readString(entry, 'tx_hash');
	const height = readNumber(entry, 'height');
	if (!/^[0-9a-f]{64}$/i.test(txHash) || height === null) return null;

	const byPaymentId: WalletTransfer['byPaymentId'] = [];
	for (const group of readArray(entry, 'subtransfers_by_pid')) {
		const paymentId = readString(group, 'payment_id').toLowerCase();
		if (!isPaymentId(paymentId)) continue;

		const income: WalletIncome[] = [];
		for (const one of readArray(group, 'subtransfers')) {
			if (readField(one, 'is_income') !== true) continue;
			const amount = readBigInt(one, 'amount');
			if (amount === null) continue;
			const rawAsset = readString(one, 'asset_id').toLowerCase();
			income.push({ assetId: isZanoAssetId(rawAsset) ? rawAsset : ZANO_ASSET_ID, amount });
		}
		if (income.length > 0) byPaymentId.push({ paymentId, income });
	}

	return { txHash: txHash.toLowerCase(), height, byPaymentId };
}

function groupByPaymentReference(transfers: WalletTransfer[]): Map<string, ObservedTx[]> {
	const observed = new Map<string, ObservedTx[]>();
	for (const transfer of transfers) {
		for (const group of transfer.byPaymentId) {
			const list = observed.get(group.paymentId) ?? [];
			list.push({ txHash: transfer.txHash, height: transfer.height, income: group.income });
			observed.set(group.paymentId, list);
		}
	}
	return observed;
}

function paymentUri(address: string, atomicAmount: string, asset: ZanoAsset): string {
	const amount = formatAtomic(BigInt(atomicAmount), asset.decimalPoint);
	return `zano:action=send&address=${address}&amount=${amount}&asset_id=${asset.assetId}`;
}

async function invoiceToAsset(
	currency: string,
	amount: number,
	asset: ZanoAsset,
	rate?: (invoiceCurrency: string, asset: ZanoAsset) => Promise<number>,
): Promise<number> {
	if (currency.toUpperCase() === asset.ticker.toUpperCase()) return amount;
	if (!rate) {
		throw new Error(
			`coin-moebius/zano: invoice currency '${currency}' paid in ${asset.ticker} requires rate on creator config`,
		);
	}
	const unitsPerCurrency = await rate(currency, asset);
	if (!(unitsPerCurrency > 0)) {
		throw new Error(
			`coin-moebius/zano: rate('${currency}', ${asset.ticker}) returned ${unitsPerCurrency}; must be positive`,
		);
	}
	return amount * unitsPerCurrency;
}

/** Map the indexer's webhook payload onto the SDK's canonical `WebhookEvent` (payment kind). */
function toPaymentResult(payload: ZanoWebhookPayload): WebhookEvent {
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
		provider: 'zano',
		amount: payload.status === 'failed' ? 0 : amount,
		currency: payload.invoiceCurrency,
		metadata: {
			address: payload.address,
			txHash: payload.txHash,
			assetId: payload.assetId,
			ticker: payload.ticker,
			decimalPoint: payload.decimalPoint,
			confirmations: payload.confirmations,
			requiredConfirmations: payload.requiredConfirmations,
			blockHeight: payload.blockHeight,
			expectedAmount: payload.expectedAmount,
			receivedAmount: payload.receivedAmount,
			expectedAmountAtomic: payload.expectedAmountAtomic,
			receivedAmountAtomic: payload.receivedAmountAtomic,
			...(payload.otherAssets === undefined ? {} : { otherAssets: payload.otherAssets }),
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

function readAssetMetadata(record: PaymentRecord): ZanoAsset {
	const assetId = readStringMetadata(record, 'assetId').toLowerCase();
	const ticker = readStringMetadata(record, 'ticker');
	const decimalPoint = readNumberMetadata(record, 'decimalPoint');
	if (!isZanoAssetId(assetId) || !ticker || decimalPoint === null) return ZANO_NATIVE_ASSET;
	return { assetId, ticker, decimalPoint };
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

function readNumber(source: unknown, field: string): number | null {
	const value = readField(source, field);
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
	if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
	return null;
}

function readBigInt(source: unknown, field: string): bigint | null {
	const value = readField(source, field);
	if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
	return null;
}

function readArray(source: unknown, field: string): object[] {
	const list = readField(source, field);
	if (!Array.isArray(list)) return [];
	return list.filter((one): one is object => typeof one === 'object' && one !== null);
}

function isPresent<T>(value: T | null): value is T {
	return value !== null;
}

function isPaymentId(value: string): boolean {
	return /^[0-9a-f]{16}$/.test(value);
}

function randomPaymentId(): string {
	return toHex(randomBytes(8));
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

/**
 * Standard base64, padding and all.
 *
 * A JWT is normally base64url, and this used to be. Zano's wallet decodes the
 * token with a plain base64 decoder, so the moment a token contained a `-` or
 * a `_` the wallet answered 401 with `Invalid input: not within alphabet`, and
 * every call failed. Verified against `simplewallet v2.2.1.506`: the same
 * request signed this way returns 200, signed base64url returns 401.
 */
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

function noopLogger(): ZanoLogger {
	return {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
	};
}
