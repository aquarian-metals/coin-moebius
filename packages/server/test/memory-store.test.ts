import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '../src/index.js';
import type { PaymentRecord } from '../src/types.js';

function makeRecord(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
	return {
		paymentId: 'pi_1',
		status: 'pending',
		provider: 'stripe',
		amount: 10,
		currency: 'USD',
		metadata: {},
		timestamp: 1_700_000_000_000,
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_000_000_000,
		...overrides,
	};
}

describe('createMemoryStore', () => {
	it('returns null for an unknown paymentId', async () => {
		const store = createMemoryStore();
		expect(await store.get('missing')).toBeNull();
	});

	it('round-trips a record through upsert + get', async () => {
		const store = createMemoryStore();
		const record = makeRecord({ paymentId: 'pi_1' });

		await store.upsert(record);
		const fetched = await store.get('pi_1');

		expect(fetched).toMatchObject({
			paymentId: 'pi_1',
			status: 'pending',
			amount: 10,
		});
	});

	it('updates an existing record and preserves the original createdAt', async () => {
		const store = createMemoryStore();
		const original = makeRecord({
			paymentId: 'pi_1',
			status: 'pending',
			timestamp: 1_700_000_000_000,
		});
		await store.upsert(original);

		const updated = makeRecord({
			paymentId: 'pi_1',
			status: 'success',
			timestamp: 1_700_000_100_000,
		});
		await store.upsert(updated);

		const fetched = await store.get('pi_1');
		expect(fetched?.status).toBe('success');
		expect(fetched?.createdAt).toBe(1_700_000_000_000);
		expect(fetched?.updatedAt).toBe(1_700_000_100_000);
	});

	it('isolates state across distinct stores', async () => {
		const a = createMemoryStore();
		const b = createMemoryStore();

		await a.upsert(makeRecord({ paymentId: 'pi_1' }));

		expect(await a.get('pi_1')).not.toBeNull();
		expect(await b.get('pi_1')).toBeNull();
	});
});
