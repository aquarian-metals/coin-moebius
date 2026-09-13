/**
 * Stand-in payment store. Replace with your real backing store: Postgres,
 * D1, DynamoDB, Redis, whatever. The interface is the `PaymentStore` from
 * `@aquarian-metals/coin-moebius-server`: one `upsert`, one `get`, plus
 * two optional methods the Zano indexer uses when present:
 * `markStatusAnnounced` (exactly-once webhooks across replicas) and
 * `listPending` (so unpaid invoices can be expired).
 *
 * The in-memory store shipped with the SDK is **not production-viable**.
 * State is lost on process restart and not shared across processes. It
 * exists for tests and prototypes only. It is used here just to make the
 * example self-contained.
 */
import { createMemoryStore } from '@aquarian-metals/coin-moebius-server';

export const myStore = createMemoryStore();
