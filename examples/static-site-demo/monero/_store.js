/**
 * Stand-in payment store. Replace with your real backing store —
 * Postgres, D1, DynamoDB, Redis, whatever. The interface is the
 * `PaymentStore` from `@aquarian-metals/coin-moebius-server` and is
 * intentionally tiny: one `upsert`, one `get`, and (optional)
 * `markStatusAnnounced` for HA / multi-replica indexer deployments.
 *
 * The in-memory store shipped with the SDK is **not production-viable**
 * — state is lost on process restart and not shared across processes.
 * It exists for tests and prototypes only. Use it here just to make the
 * example self-contained.
 */
import { createMemoryStore } from '@aquarian-metals/coin-moebius-server';

export const myStore = createMemoryStore();
