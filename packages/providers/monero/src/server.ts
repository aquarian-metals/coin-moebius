/**
 * Monero server-side primitives for Coin Moebius.
 *
 * Four exports, one per responsibility:
 *
 *   1. {@link createMoneroCreator} — invoked from the merchant's
 *      "checkout" serverless function. Talks to `monero-wallet-rpc` to
 *      mint a per-payment subaddress, persists a pending record to the
 *      merchant's {@link PaymentStore}, and returns the buyer-facing
 *      instructions (address, exact amount, monero: URI, expiresAt).
 *
 *   2. {@link createMoneroVerifier} — invoked from the merchant's
 *      "payment-webhook" serverless function. Validates the HMAC-signed
 *      payload that the indexer (see #3) posts, and returns a normalized
 *      `PaymentResult` for the registry dispatch layer to consume.
 *
 *   3. {@link createMoneroIndexer} — a long-running process the merchant
 *      hosts next to `monero-wallet-rpc` (same VPC / same box). Polls
 *      wallet-rpc for incoming transfers, decides their canonical status
 *      against the merchant's `PaymentStore`, and POSTs HMAC-signed
 *      webhooks to the verifier endpoint. Exposes `.tick()`, `.start()`,
 *      `.status()`, and `.processTx(txHash)` (for `monero-wallet-rpc
 *      --tx-notify` push-mode).
 *
 *   4. {@link computeMoneroSignature} — exported HMAC helper so the
 *      indexer (and tests) can produce signatures that the verifier
 *      will accept. Same one-call interface as
 *      `computeNowPaymentsSignature` for symmetry.
 *
 * Topology note: the indexer MUST run inside the same private network
 * trust boundary as `monero-wallet-rpc`. For a hobbyist that's the same
 * box; for a business that's the same VPC / Tailscale tailnet / k8s
 * cluster. `walletRpcUrl` is a normal HTTP URL; whether it points at
 * localhost, an internal hostname, or a cluster-internal service is the
 * merchant's choice and the library does not care.
 */

import type { PaymentResult, PaymentStatus } from '@aquarian-metals/coin-moebius-core';
import type { PaymentRecord, PaymentStore } from '@aquarian-metals/coin-moebius-server';

// ============================================================================
// Public types
// ============================================================================

/** Minimal logger contract. Default is a no-op; ops teams inject pino, etc. */
export interface MoneroLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Configuration for {@link createMoneroCreator}. The creator runs
 * server-side (typically in the merchant's `POST /api/checkout/monero`
 * endpoint) and talks to `monero-wallet-rpc` to mint a subaddress.
 */
export interface MoneroCreatorConfig {
	/** Full URL of the merchant's `monero-wallet-rpc` (e.g. `http://localhost:18083`). */
	walletRpcUrl: string;
	/** The merchant's payment store. The creator writes a pending record per checkout. */
	store: PaymentStore;
	/**
	 * Optional Monero subaddress account index. Most merchants use 0;
	 * larger merchants may segregate storefronts onto different account
	 * indices. Defaults to 0.
	 */
	accountIndex?: number;
	/**
	 * Minutes before an unpaid invoice expires. After this window, the
	 * indexer marks the payment `failed`. Defaults to 15.
	 */
	expiryMinutes?: number;
	/**
	 * Required when invoicing in any currency other than XMR. Returns the
	 * current price as `XMR per 1 unit of the invoice currency`. For
	 * example, if XMR is $160 and the invoice is in USD, this should
	 * return `1 / 160 ≈ 0.00625`.
	 *
	 * Coin Moebius does not call any oracle directly — the merchant
	 * controls where the price comes from (CoinGecko, Kraken ticker,
	 * pinned constant, etc.).
	 */
	xmrPerUnit?: (invoiceCurrency: string) => Promise<number>;
	/** Optional `fetch` override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/** Optional structured logger. Defaults to no-op. */
	logger?: MoneroLogger;
}

/** Input to the creator returned by {@link createMoneroCreator}. */
export interface MoneroCreateInput {
	productId: string;
	/** Invoice amount in `currency` (decimal). */
	amount: number;
	/** Invoice currency — `'XMR'` for native, anything else requires `xmrPerUnit`. */
	currency: string;
	metadata?: Record<string, unknown>;
}

/** Buyer-facing payment instructions returned by the creator. */
export interface MoneroCreateResult {
	paymentId: string;
	address: string;
	addressIndex: number;
	atomicAmount: string;
	xmrAmount: number;
	uri: string;
	expiresAt: number;
}

/** Configuration for {@link createMoneroVerifier}. */
export interface MoneroVerifierConfig {
	/** Shared secret used by the indexer when signing webhooks and the verifier when validating them. */
	hmacSecret: string;
}

/**
 * The exact JSON payload the indexer POSTs and the verifier validates.
 * Exported so callers writing custom indexers (or tests) can build
 * conformant payloads.
 */
export interface MoneroWebhookPayload {
	provider: 'monero';
	paymentId: string;
	/** Terminal status — `'success'`, `'partial'`, or `'failed'`. */
	status: Extract<PaymentStatus, 'success' | 'partial' | 'failed'>;
	/** Transaction hash, or `null` when the status is `'failed'` due to expiry without payment. */
	txHash: string | null;
	address: string;
	/** Original invoice currency (e.g. `'USD'`, `'XMR'`). */
	invoiceCurrency: string;
	/** Original invoice amount in `invoiceCurrency`. */
	invoiceAmount: number;
	/** What we asked the buyer to send, in piconero (10^-12 XMR), as a string. */
	expectedAmountAtomic: string;
	/** What the chain actually delivered, in piconero, as a string. `'0'` when nothing arrived. */
	receivedAmountAtomic: string;
	/** Decimal XMR convenience field for `expectedAmountAtomic`. */
	expectedAmountXmr: number;
	/** Decimal XMR convenience field for `receivedAmountAtomic`. */
	receivedAmountXmr: number;
	confirmations: number;
	/** Block height the payment was first observed at, or `null` for expiry-failed. */
	blockHeight: number | null;
	timestamp: number;
}

/** Webhook verifier surface. Matches the `WebhookVerifier` contract from `coin-moebius-server`. */
export interface MoneroVerifier {
	verify(rawBody: unknown, headers: Record<string, string | undefined>): Promise<PaymentResult>;
}

/** Configuration for {@link createMoneroIndexer}. */
export interface MoneroIndexerConfig {
	/** Wallet RPC URL — same value the creator uses. */
	walletRpcUrl: string;
	/** Merchant's payment store — same instance the creator writes to. */
	store: PaymentStore;
	/** Full URL of the merchant's payment-webhook endpoint (where the verifier lives). */
	webhookUrl: string;
	/** Shared secret — must match what the verifier is configured with. */
	hmacSecret: string;
	/**
	 * Block confirmations required before a payment transitions to
	 * `success`. Monero standard is 10 (~20 minutes). Defaults to 10.
	 */
	requiredConfirmations?: number;
	/** Wallet subaddress account index. Defaults to 0; must match the creator. */
	accountIndex?: number;
	/** How many extra blocks of history to scan beyond `requiredConfirmations` as a safety margin. Defaults to 20. */
	scanLookbackBlocks?: number;
	/** Default polling interval for `.start()`. Defaults to 30 seconds. */
	pollIntervalMs?: number;
	/** Webhook POST retry config. Defaults: 3 attempts, starting at 500ms with exponential backoff. */
	webhookRetry?: {
		maxAttempts?: number;
		initialBackoffMs?: number;
	};
	/** Optional `fetch` override — used by tests and custom transports. */
	fetcher?: typeof fetch;
	/** Optional structured logger. */
	logger?: MoneroLogger;
	/** Time provider — overridable for tests. Defaults to `Date.now`. */
	now?: () => number;
}

/** Runtime status snapshot returned by `indexer.status()`. */
export interface MoneroIndexerStatus {
	lastTickAt: number | null;
	lastError: { message: string; at: number } | null;
	walletHeight: number | null;
	pendingPaymentCount: number;
	totalTicks: number;
	totalWebhooksSent: number;
	webhookErrorCount: number;
}

/** Per-tick result for callers who run the indexer on a cron (rather than via `.start()`). */
export interface MoneroTickResult {
	walletHeight: number;
	transfersInspected: number;
	webhooksSent: number;
	errors: string[];
}

/** Indexer surface. */
export interface MoneroIndexer {
	/** Run one polling iteration. Safe to call from a cron, a queue worker, or repeatedly. */
	tick(): Promise<MoneroTickResult>;
	/** Start a polling loop on `pollIntervalMs`. Returns a stop function. */
	start(): () => void;
	/** In-memory status snapshot. Suitable to expose from a `/health` endpoint. */
	status(): MoneroIndexerStatus;
	/**
	 * Process a single transaction by hash. For `monero-wallet-rpc
	 * --tx-notify` push-mode: the wallet fires this for every incoming
	 * tx, the merchant's notify hook calls `processTx(hash)`, the
	 * indexer maps the tx to a payment and emits the webhook
	 * immediately. The `.start()` polling loop is still the backstop
	 * that catches missed notifications and counts confirmations.
	 */
	processTx(txHash: string): Promise<void>;
}

// ============================================================================
// Creator
// ============================================================================

/**
 * Build the server-side creator. Wire it into the merchant's
 * `POST /api/checkout/monero` endpoint. The endpoint receives the
 * `MoneroCreateInput` from the browser provider and forwards the
 * returned `MoneroCreateResult` back as the response body.
 *
 * @example
 *   const create = createMoneroCreator({
 *     walletRpcUrl: process.env.MONERO_WALLET_RPC_URL!,
 *     store: myProductionStore,
 *     xmrPerUnit: async (cur) => {
 *       if (cur === 'XMR') return 1;
 *       // Merchant fetches their own price feed — Coin Moebius stays
 *       // out of oracle business.
 *       return await fetchXmrPriceFromMyOracle(cur);
 *     },
 *   });
 */
export function createMoneroCreator(config: MoneroCreatorConfig) {
	const accountIndex = config.accountIndex ?? 0;
	const expiryMinutes = config.expiryMinutes ?? 15;
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const logger = config.logger ?? noopLogger();
	const now = Date.now;

	return async function createMoneroPayment(input: MoneroCreateInput): Promise<MoneroCreateResult> {
		const xmrAmount = await invoiceToXmr(input.currency, input.amount, config.xmrPerUnit);
		const atomicAmount = xmrToAtomic(xmrAmount);

		const paymentId = generatePaymentId(input.productId, now());

		// The wallet itself is the source of truth for the
		// `addressIndex → paymentId` mapping: we store the paymentId in
		// the subaddress's `label` field, then look it up at indexer time
		// via `get_address`. This avoids needing iteration on the
		// PaymentStore.
		const addressResult = await walletRpc<{ address: string; address_index: number }>(
			config.walletRpcUrl,
			'create_address',
			{ account_index: accountIndex, label: paymentId },
			fetcher,
		);

		const expiresAt = now() + expiryMinutes * 60 * 1000;
		const uri = `monero:${addressResult.address}?tx_amount=${xmrAmount}`;

		const record: PaymentRecord = {
			status: 'pending',
			paymentId,
			provider: 'monero',
			amount: input.amount,
			currency: input.currency,
			metadata: {
				...(input.metadata ?? {}),
				productId: input.productId,
				address: addressResult.address,
				addressIndex: addressResult.address_index,
				accountIndex,
				atomicAmount,
				xmrAmount,
				expiresAt,
			},
			timestamp: now(),
			createdAt: now(),
			updatedAt: now(),
		};
		await config.store.upsert(record);

		logger.info('monero: created payment', {
			paymentId,
			addressIndex: addressResult.address_index,
			xmrAmount,
		});

		return {
			paymentId,
			address: addressResult.address,
			addressIndex: addressResult.address_index,
			atomicAmount,
			xmrAmount,
			uri,
			expiresAt,
		};
	};
}

// ============================================================================
// Verifier
// ============================================================================

/**
 * Build the webhook verifier. Wire into the merchant's webhook handler
 * via `createVerifierRegistry().register('monero', verifier.verify)`.
 *
 * The signature scheme: HMAC-SHA256 of the JSON body (exactly as
 * received, byte-for-byte if available; falls back to re-stringifying
 * the parsed object), hex-encoded, compared in constant time against
 * the `x-monero-sig` header.
 */
export function createMoneroVerifier(config: MoneroVerifierConfig): MoneroVerifier {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/monero: hmacSecret missing on verifier config');
	}

	return {
		async verify(rawBody, headers): Promise<PaymentResult> {
			const sig = headerValue(headers, 'x-monero-sig');
			if (!sig) {
				throw new Error('coin-moebius/monero: missing x-monero-sig header');
			}

			let payload: MoneroWebhookPayload;
			let canonical: string;
			if (typeof rawBody === 'string') {
				canonical = rawBody;
				try {
					payload = JSON.parse(rawBody) as MoneroWebhookPayload;
				} catch {
					throw new Error('coin-moebius/monero: body is not valid JSON');
				}
			} else if (rawBody && typeof rawBody === 'object') {
				payload = rawBody as MoneroWebhookPayload;
				canonical = JSON.stringify(payload);
			} else {
				throw new Error('coin-moebius/monero: unsupported body type');
			}

			const expected = await computeMoneroSignature(canonical, config.hmacSecret);
			if (!timingSafeStringEqual(expected, sig)) {
				throw new Error('coin-moebius/monero: invalid signature');
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
 * `monero-wallet-rpc`. The indexer is poll-based by default (`.start()`
 * runs `.tick()` every `pollIntervalMs`); merchants who want lower
 * latency can additionally wire `processTx(hash)` to
 * `monero-wallet-rpc --tx-notify`.
 *
 * The indexer is **catch-up by design**: if it's offline for a stretch,
 * the next tick will see all transfers it missed and emit webhooks
 * then. Operational SLA is "eventually consistent within a few
 * minutes," not "five-nines uptime." Buyer-side UI may show a stale
 * "pending" during downtime but no payment will be lost.
 *
 * @example
 *   const indexer = createMoneroIndexer({
 *     walletRpcUrl: 'http://localhost:18083',
 *     store: myProductionStore,
 *     webhookUrl: 'https://my-site.example/api/payment-webhook',
 *     hmacSecret: process.env.MONERO_HMAC_SECRET!,
 *     requiredConfirmations: 10,
 *   });
 *   const stop = indexer.start();
 *   process.on('SIGTERM', stop);
 */
export function createMoneroIndexer(config: MoneroIndexerConfig): MoneroIndexer {
	if (!config.hmacSecret) {
		throw new Error('coin-moebius/monero: hmacSecret missing on indexer config');
	}

	const accountIndex = config.accountIndex ?? 0;
	const requiredConfirmations = config.requiredConfirmations ?? 10;
	const scanLookback = config.scanLookbackBlocks ?? 20;
	const pollIntervalMs = config.pollIntervalMs ?? 30_000;
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const logger = config.logger ?? noopLogger();
	const now = config.now ?? Date.now;
	const retryConfig = {
		maxAttempts: config.webhookRetry?.maxAttempts ?? 3,
		initialBackoffMs: config.webhookRetry?.initialBackoffMs ?? 500,
	};

	const state: MoneroIndexerStatus = {
		lastTickAt: null,
		lastError: null,
		walletHeight: null,
		pendingPaymentCount: 0,
		totalTicks: 0,
		totalWebhooksSent: 0,
		webhookErrorCount: 0,
	};

	// In-process re-entrancy guard. Overlapping `.tick()` invocations
	// (slow wallet RPC + fast cron) would double-emit webhooks; we serial-
	// ize them here. Cross-process races are caught by `markStatusAnnounced`
	// when the merchant's store implements it.
	let ticking: Promise<MoneroTickResult> | null = null;

	async function tickInternal(): Promise<MoneroTickResult> {
		const tickStartedAt = now();
		const errors: string[] = [];
		let webhooksSent = 0;
		let transfersInspected = 0;

		const heightResult = await walletRpc<{ height: number }>(
			config.walletRpcUrl,
			'get_height',
			{},
			fetcher,
		);
		const walletHeight = heightResult.height;
		state.walletHeight = walletHeight;
		const minHeight = Math.max(0, walletHeight - requiredConfirmations - scanLookback);

		const transfersResult = await walletRpc<{ in?: WalletTransfer[] }>(
			config.walletRpcUrl,
			'get_transfers',
			{
				in: true,
				account_index: accountIndex,
				filter_by_height: true,
				min_height: minHeight,
				max_height: walletHeight,
			},
			fetcher,
		);
		const incoming = transfersResult.in ?? [];
		transfersInspected = incoming.length;

		const labelByIndex = await fetchLabelMap(config.walletRpcUrl, accountIndex, fetcher);

		// Group transfers by paymentId so a payment that received multiple
		// sub-amounts (multi-tx invoice settlement) sums correctly.
		const transfersByPaymentId = new Map<string, WalletTransfer[]>();
		for (const transfer of incoming) {
			const addressIndex = transfer.subaddr_index?.minor;
			if (addressIndex === undefined) continue;
			const paymentId = labelByIndex.get(addressIndex);
			if (!paymentId) continue;
			const list = transfersByPaymentId.get(paymentId) ?? [];
			list.push(transfer);
			transfersByPaymentId.set(paymentId, list);
		}

		for (const [paymentId, transfers] of transfersByPaymentId) {
			try {
				const sent = await processPaymentChainState(paymentId, transfers, walletHeight);
				if (sent) webhooksSent += 1;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push(`paymentId=${paymentId}: ${message}`);
				logger.error('monero: payment processing failed', { paymentId, message });
			}
		}

		// Expiry sweep: for paymentIds that have a tracked subaddress but
		// no incoming transfer, check if they've passed `expiresAt` and
		// announce `failed` if so. We only look at addresses the wallet
		// knows about (via labels), since that's our cheapest enumeration
		// of "payments we care about."
		const expiredCount = await sweepExpired(labelByIndex, transfersByPaymentId, walletHeight);
		webhooksSent += expiredCount;

		state.totalTicks += 1;
		state.totalWebhooksSent += webhooksSent;
		state.lastTickAt = tickStartedAt;
		if (errors.length === 0) {
			state.lastError = null;
		} else {
			state.lastError = { message: errors[0], at: tickStartedAt };
		}

		return {
			walletHeight,
			transfersInspected,
			webhooksSent,
			errors,
		};
	}

	async function processPaymentChainState(
		paymentId: string,
		transfers: WalletTransfer[],
		walletHeight: number,
	): Promise<boolean> {
		const record = await config.store.get(paymentId);
		if (!record) {
			logger.warn('monero: transfer for unknown payment', { paymentId });
			return false;
		}
		if (record.status === 'success' || record.status === 'partial' || record.status === 'failed') {
			return false;
		}

		const expectedAtomic = readAtomicMetadata(record);
		const receivedAtomic = transfers.reduce((sum, t) => sum + BigInt(t.amount), BigInt(0));
		// The minimum confirmations across all contributing txs gates the
		// payment's overall confirmation state — we only succeed once the
		// slowest piece has cleared.
		const minConfirmations = transfers.reduce(
			(min, t) => Math.min(min, t.confirmations ?? 0),
			Number.POSITIVE_INFINITY,
		);
		const firstHeight = transfers.reduce(
			(min, t) => Math.min(min, t.height ?? walletHeight),
			Number.POSITIVE_INFINITY,
		);
		const firstTxHash = transfers[0]?.txid ?? null;

		if (minConfirmations < requiredConfirmations) {
			return false;
		}

		const status: MoneroWebhookPayload['status'] =
			receivedAtomic >= expectedAtomic ? 'success' : 'partial';
		const winner = await claimAnnouncement(paymentId, status);
		if (!winner) return false;

		await emitWebhook({
			provider: 'monero',
			paymentId,
			status,
			txHash: firstTxHash,
			address: readStringMetadata(record, 'address'),
			invoiceCurrency: record.currency,
			invoiceAmount: record.amount,
			expectedAmountAtomic: expectedAtomic.toString(),
			receivedAmountAtomic: receivedAtomic.toString(),
			expectedAmountXmr: atomicToXmr(expectedAtomic),
			receivedAmountXmr: atomicToXmr(receivedAtomic),
			confirmations: minConfirmations,
			blockHeight: Number.isFinite(firstHeight) ? firstHeight : walletHeight,
			timestamp: now(),
		});

		await config.store.upsert({
			...record,
			status,
			amount: status === 'partial' ? proratedInvoiceAmount(record, receivedAtomic) : record.amount,
			metadata: {
				...record.metadata,
				txHash: firstTxHash,
				receivedAtomic: receivedAtomic.toString(),
				confirmations: minConfirmations,
			},
			timestamp: now(),
			createdAt: record.createdAt,
			updatedAt: now(),
		});

		return true;
	}

	async function sweepExpired(
		labelByIndex: Map<number, string>,
		transfersByPaymentId: Map<string, WalletTransfer[]>,
		walletHeight: number,
	): Promise<number> {
		let sent = 0;
		for (const paymentId of labelByIndex.values()) {
			if (transfersByPaymentId.has(paymentId)) continue;
			const record = await config.store.get(paymentId);
			if (!record) continue;
			if (record.status !== 'pending') continue;
			const expiresAt = readNumberMetadata(record, 'expiresAt');
			if (expiresAt === null || now() < expiresAt) continue;

			const winner = await claimAnnouncement(paymentId, 'failed');
			if (!winner) continue;

			const expectedAtomic = readAtomicMetadata(record);
			await emitWebhook({
				provider: 'monero',
				paymentId,
				status: 'failed',
				txHash: null,
				address: readStringMetadata(record, 'address'),
				invoiceCurrency: record.currency,
				invoiceAmount: record.amount,
				expectedAmountAtomic: expectedAtomic.toString(),
				receivedAmountAtomic: '0',
				expectedAmountXmr: atomicToXmr(expectedAtomic),
				receivedAmountXmr: 0,
				confirmations: 0,
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
		state.pendingPaymentCount = countPending(labelByIndex, transfersByPaymentId);
		void walletHeight;
		return sent;
	}

	function countPending(
		labelByIndex: Map<number, string>,
		transfersByPaymentId: Map<string, WalletTransfer[]>,
	): number {
		let pending = 0;
		for (const paymentId of labelByIndex.values()) {
			if (!transfersByPaymentId.has(paymentId)) pending += 1;
		}
		return pending;
	}

	async function claimAnnouncement(paymentId: string, status: PaymentStatus): Promise<boolean> {
		if (config.store.markStatusAnnounced) {
			return await config.store.markStatusAnnounced(paymentId, status);
		}
		// Fallback: re-read the record under the assumption that there's
		// at most one indexer process. The merchant's webhook receiver is
		// the ultimate dedup line (it has to be — Stripe and NOWPayments
		// resend, too).
		const fresh = await config.store.get(paymentId);
		if (!fresh) return false;
		return fresh.status === 'pending';
	}

	async function emitWebhook(payload: MoneroWebhookPayload): Promise<void> {
		const body = JSON.stringify(payload);
		const sig = await computeMoneroSignature(body, config.hmacSecret);

		let lastError: Error | null = null;
		for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
			try {
				const response = await fetcher(config.webhookUrl, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'x-monero-sig': sig,
						'x-provider': 'monero',
					},
					body,
				});
				if (response.ok) return;
				throw new Error(`webhook responded ${response.status}`);
			} catch (err) {
				lastError = err instanceof Error ? err : new Error(String(err));
				if (attempt < retryConfig.maxAttempts) {
					const backoff = retryConfig.initialBackoffMs * 2 ** (attempt - 1);
					await sleep(backoff);
				}
			}
		}
		state.webhookErrorCount += 1;
		logger.error('monero: webhook delivery failed', {
			paymentId: payload.paymentId,
			error: lastError?.message,
		});
		throw lastError ?? new Error('coin-moebius/monero: webhook delivery failed');
	}

	async function processTxInternal(txHash: string): Promise<void> {
		const result = await walletRpc<{
			transfer?: WalletTransfer;
			transfers?: WalletTransfer[];
		}>(
			config.walletRpcUrl,
			'get_transfer_by_txid',
			{ txid: txHash, account_index: accountIndex },
			fetcher,
		);
		const transfers = result.transfers ?? (result.transfer ? [result.transfer] : []);
		if (transfers.length === 0) return;

		const labelByIndex = await fetchLabelMap(config.walletRpcUrl, accountIndex, fetcher);
		const heightResult = await walletRpc<{ height: number }>(
			config.walletRpcUrl,
			'get_height',
			{},
			fetcher,
		);
		const walletHeight = heightResult.height;

		const transfersByPaymentId = new Map<string, WalletTransfer[]>();
		for (const transfer of transfers) {
			const idx = transfer.subaddr_index?.minor;
			if (idx === undefined) continue;
			const paymentId = labelByIndex.get(idx);
			if (!paymentId) continue;
			const list = transfersByPaymentId.get(paymentId) ?? [];
			list.push(transfer);
			transfersByPaymentId.set(paymentId, list);
		}

		for (const [paymentId, ts] of transfersByPaymentId) {
			try {
				await processPaymentChainState(paymentId, ts, walletHeight);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				logger.error('monero: processTx failed', { paymentId, txHash, message });
			}
		}
	}

	return {
		tick(): Promise<MoneroTickResult> {
			if (ticking) return ticking;
			ticking = tickInternal()
				.catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					state.lastError = { message, at: now() };
					state.totalTicks += 1;
					logger.error('monero: tick failed', { message });
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
		status(): MoneroIndexerStatus {
			return { ...state };
		},
		processTx(txHash: string): Promise<void> {
			return processTxInternal(txHash);
		},
	};
}

// ============================================================================
// Public helper — exported so the indexer and tests can produce signatures
// the verifier will accept.
// ============================================================================

/** HMAC-SHA256 of `body` keyed by `hmacSecret`, hex-encoded. */
export async function computeMoneroSignature(body: string, hmacSecret: string): Promise<string> {
	const message = new TextEncoder().encode(body);
	const keyBytes = new TextEncoder().encode(hmacSecret);
	const key = await crypto.subtle.importKey(
		'raw',
		keyBytes as BufferSource,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sigBuf = await crypto.subtle.sign('HMAC', key, message);
	return toHex(new Uint8Array(sigBuf));
}

// ============================================================================
// Internals
// ============================================================================

interface WalletTransfer {
	txid: string;
	amount: number | string;
	confirmations?: number;
	height?: number;
	subaddr_index?: { major: number; minor: number };
	address?: string;
}

interface JsonRpcResponse<T> {
	result?: T;
	error?: { code: number; message: string };
}

async function walletRpc<T>(
	url: string,
	method: string,
	params: unknown,
	fetcher: typeof fetch,
): Promise<T> {
	const endpoint = url.replace(/\/+$/, '') + '/json_rpc';
	const response = await fetcher(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
	});
	if (!response.ok) {
		throw new Error(`coin-moebius/monero: wallet-rpc ${method} HTTP ${response.status}`);
	}
	const body = (await response.json()) as JsonRpcResponse<T>;
	if (body.error) {
		throw new Error(`coin-moebius/monero: wallet-rpc ${method} error: ${body.error.message}`);
	}
	if (body.result === undefined) {
		throw new Error(`coin-moebius/monero: wallet-rpc ${method} returned no result`);
	}
	return body.result;
}

async function fetchLabelMap(
	walletRpcUrl: string,
	accountIndex: number,
	fetcher: typeof fetch,
): Promise<Map<number, string>> {
	const result = await walletRpc<{
		addresses: { address: string; address_index: number; label?: string }[];
	}>(walletRpcUrl, 'get_address', { account_index: accountIndex }, fetcher);
	const map = new Map<number, string>();
	for (const a of result.addresses) {
		if (a.label) map.set(a.address_index, a.label);
	}
	return map;
}

/** Map the indexer's webhook payload onto the SDK's canonical `PaymentResult`. */
function toPaymentResult(payload: MoneroWebhookPayload): PaymentResult {
	const amount =
		payload.status === 'partial'
			? proratedFromAtomic(
					payload.invoiceAmount,
					BigInt(payload.expectedAmountAtomic),
					BigInt(payload.receivedAmountAtomic),
				)
			: payload.invoiceAmount;
	return {
		status: payload.status,
		paymentId: payload.paymentId,
		provider: 'monero',
		amount: payload.status === 'failed' ? 0 : amount,
		currency: payload.invoiceCurrency,
		metadata: {
			address: payload.address,
			txHash: payload.txHash,
			confirmations: payload.confirmations,
			blockHeight: payload.blockHeight,
			expectedAmountXmr: payload.expectedAmountXmr,
			receivedAmountXmr: payload.receivedAmountXmr,
			expectedAmountAtomic: payload.expectedAmountAtomic,
			receivedAmountAtomic: payload.receivedAmountAtomic,
		},
		timestamp: payload.timestamp,
		raw: payload,
	};
}

async function invoiceToXmr(
	currency: string,
	amount: number,
	xmrPerUnit?: (currency: string) => Promise<number>,
): Promise<number> {
	if (currency.toUpperCase() === 'XMR') return amount;
	if (!xmrPerUnit) {
		throw new Error(
			`coin-moebius/monero: invoice currency '${currency}' requires xmrPerUnit on creator config`,
		);
	}
	const rate = await xmrPerUnit(currency);
	if (!(rate > 0)) {
		throw new Error(
			`coin-moebius/monero: xmrPerUnit('${currency}') returned ${rate}; must be positive`,
		);
	}
	return amount * rate;
}

const ATOMIC_PER_XMR = 1_000_000_000_000n;

function xmrToAtomic(xmr: number): string {
	// Round to 12 decimals via string formatting to avoid float drift,
	// then split on the decimal point and rebuild as a BigInt count of
	// piconero. This handles values like 0.0000012345 without losing the
	// trailing digits to float64.
	const [whole, fraction = ''] = xmr.toFixed(12).split('.');
	const paddedFraction = fraction.padEnd(12, '0').slice(0, 12);
	return (BigInt(whole ?? '0') * ATOMIC_PER_XMR + BigInt(paddedFraction)).toString();
}

function atomicToXmr(atomic: bigint): number {
	// Float conversion is fine for display — buyers see this; the canonical
	// atomic-units string is what we sign and compare on.
	return Number(atomic) / Number(ATOMIC_PER_XMR);
}

function proratedInvoiceAmount(record: PaymentRecord, receivedAtomic: bigint): number {
	const expectedAtomic = readAtomicMetadata(record);
	if (expectedAtomic === 0n) return 0;
	return proratedFromAtomic(record.amount, expectedAtomic, receivedAtomic);
}

function proratedFromAtomic(
	invoiceAmount: number,
	expectedAtomic: bigint,
	receivedAtomic: bigint,
): number {
	if (expectedAtomic === 0n) return 0;
	// Convert via Number for the ratio; precision loss in the last few
	// decimals of invoice currency is acceptable for a "what fraction
	// did we receive" credit calculation.
	return (invoiceAmount * Number(receivedAtomic)) / Number(expectedAtomic);
}

function readAtomicMetadata(record: PaymentRecord): bigint {
	const raw = record.metadata.atomicAmount;
	if (typeof raw !== 'string') return 0n;
	try {
		return BigInt(raw);
	} catch {
		return 0n;
	}
}

function readStringMetadata(record: PaymentRecord, key: string): string {
	const raw = record.metadata[key];
	return typeof raw === 'string' ? raw : '';
}

function readNumberMetadata(record: PaymentRecord, key: string): number | null {
	const raw = record.metadata[key];
	return typeof raw === 'number' ? raw : null;
}

function generatePaymentId(productId: string, ts: number): string {
	// Suffix with a short random component so two checkouts for the same
	// product in the same millisecond don't collide.
	const rand = Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.padStart(8, '0');
	return `xmr_${productId}_${ts}_${rand}`;
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

function noopLogger(): MoneroLogger {
	return {
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
	};
}
