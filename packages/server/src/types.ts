import type { PaymentResult, PaymentStatus } from '@aquarian-metals/coin-moebius-core';

/**
 * Persistent representation of a payment, suitable for storage in a
 * {@link PaymentStore}. Extends {@link PaymentResult} with two server-only
 * timestamps that the store fills in on write.
 *
 * Provider-specific fields like blockchain confirmation counts go in
 * `metadata` (consistent with where the verifier puts them — see e.g. the
 * Cryptomus verifier's `metadata.confirmations`). The interface deliberately
 * doesn't pull such fields up to the top level so that the shape stays
 * provider-neutral.
 */
export interface PaymentRecord extends PaymentResult {
	/** When this paymentId was first written to the store. */
	createdAt: number;
	/** When this paymentId was most recently written or updated. */
	updatedAt: number;
}

/**
 * Storage contract for payment records. Implement against any backing store —
 * Postgres, SQLite (D1), Redis, DynamoDB, an in-memory `Map`, your fridge.
 * The interface is intentionally minimal so the surface area to re-implement
 * for a new backend is small.
 *
 * One reference implementation ships in this package: `createMemoryStore()`.
 * Use it for tests and prototypes; implement your own for production.
 */
export interface PaymentStore {
	/**
	 * Insert or update a payment record. Implementations should set
	 * `createdAt` on first write and update `updatedAt` on every write.
	 */
	upsert(record: PaymentRecord): Promise<void>;

	/**
	 * Read the payment record for the given `paymentId`, or `null` if no
	 * record exists.
	 */
	get(paymentId: string): Promise<PaymentRecord | null>;

	/**
	 * Optional. Atomically claim the right to announce `paymentId` as
	 * `status`, returning `true` if the caller won the race and should
	 * proceed (e.g. POST the outbound webhook), or `false` if another caller
	 * already announced this `(paymentId, status)` pair.
	 *
	 * Implementations should perform a single atomic operation — a DB UPSERT
	 * on a `(paymentId, status)` unique constraint, a Redis `SETNX`, or
	 * equivalent — so that two concurrent indexer replicas cannot both win.
	 * Returning `true` even when racing is incorrect; returning `false`
	 * defensively when uncertain is acceptable (the duplicate is then
	 * caught by the merchant's webhook-receiver idempotency).
	 *
	 * Stores that omit this method are safe for single-process / single-
	 * indexer deployments. The Monero indexer falls back to a read-then-
	 * write check in `upsert`/`get`, with deduplication ultimately handled
	 * by the merchant's webhook endpoint (which has to be idempotent for
	 * every provider anyway — Stripe, NOWPayments, etc. all resend).
	 *
	 * Implement this on production stores (Postgres, D1, DynamoDB) when
	 * you plan to run the Monero indexer in HA / multi-replica mode.
	 */
	markStatusAnnounced?(paymentId: string, status: PaymentStatus): Promise<boolean>;
}
