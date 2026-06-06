import type { PaymentStatus } from '@aquarian-metals/coin-moebius-core';
import type { PaymentRecord, PaymentStore } from './types.js';

/**
 * Create an in-memory {@link PaymentStore}. Useful for tests, prototypes,
 * and getting-started examples. **Not production-viable** — state is lost
 * on process restart and not shared across processes.
 *
 * For production, implement {@link PaymentStore} against your own backing
 * store (Postgres, SQLite/D1, Redis, DynamoDB, whatever fits). The interface
 * is intentionally small: one `upsert`, one `get`. See `PaymentStore` for
 * the contract.
 *
 * @example
 *   import { createMemoryStore, createStatusSubscriber } from '@aquarian-metals/coin-moebius-server';
 *
 *   const store = createMemoryStore();
 *   const subscribe = createStatusSubscriber(store);
 *
 *   // In your webhook handler:
 *   await store.upsert({ paymentId: 'pi_1', status: 'success', ... });
 *
 *   // In your status poll handler:
 *   const record = await store.get('pi_1');
 */
export function createMemoryStore(): PaymentStore {
	const records = new Map<string, PaymentRecord>();
	// Tracks the `(paymentId, status)` pairs that have already been claimed
	// via `markStatusAnnounced`. JS is single-threaded so a `Set.has` /
	// `Set.add` pair is atomic enough to guarantee exactly-once at this
	// scope. Cross-process / multi-replica deployments need a real store.
	const announced = new Set<string>();

	return {
		upsert(record) {
			const existing = records.get(record.paymentId);
			records.set(record.paymentId, {
				...record,
				createdAt: existing?.createdAt ?? record.timestamp,
				updatedAt: record.timestamp,
			});
			return Promise.resolve();
		},
		get(paymentId) {
			return Promise.resolve(records.get(paymentId) ?? null);
		},
		markStatusAnnounced(paymentId: string, status: PaymentStatus) {
			const key = `${paymentId}\u0000${status}`;
			if (announced.has(key)) return Promise.resolve(false);
			announced.add(key);
			return Promise.resolve(true);
		},
	};
}
