import type { PaymentResult } from '@aquarian-metals/coin-moebius-core';

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
}
