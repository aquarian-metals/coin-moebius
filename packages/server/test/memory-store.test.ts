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

	it('does not let a late lower-rank status regress a settled payment (SDK C2)', async () => {
		const store = createMemoryStore();
		await store.upsert(makeRecord({ paymentId: 'pi_1', status: 'success', timestamp: 100 }));

		// A reordered/replayed `pending` arrives after `success`.
		await store.upsert(makeRecord({ paymentId: 'pi_1', status: 'pending', timestamp: 200 }));

		const fetched = await store.get('pi_1');
		expect(fetched?.status).toBe('success'); // not regressed to pending
		expect(fetched?.updatedAt).toBe(100); // the stale update was ignored entirely
	});

	it('still advances forward (pending -> success) and to terminal refunded', async () => {
		const store = createMemoryStore();
		await store.upsert(makeRecord({ paymentId: 'pi_1', status: 'pending', timestamp: 100 }));
		await store.upsert(makeRecord({ paymentId: 'pi_1', status: 'success', timestamp: 200 }));
		expect((await store.get('pi_1'))?.status).toBe('success');
		await store.upsert(makeRecord({ paymentId: 'pi_1', status: 'refunded', timestamp: 300 }));
		expect((await store.get('pi_1'))?.status).toBe('refunded');
	});

	it('isolates state across distinct stores', async () => {
		const a = createMemoryStore();
		const b = createMemoryStore();

		await a.upsert(makeRecord({ paymentId: 'pi_1' }));

		expect(await a.get('pi_1')).not.toBeNull();
		expect(await b.get('pi_1')).toBeNull();
	});

	describe('markStatusAnnounced', () => {
		it('returns true the first time and false on every subsequent claim', async () => {
			const store = createMemoryStore();
			expect(await store.markStatusAnnounced?.('pi_1', 'success')).toBe(true);
			expect(await store.markStatusAnnounced?.('pi_1', 'success')).toBe(false);
			expect(await store.markStatusAnnounced?.('pi_1', 'success')).toBe(false);
		});

		it('treats distinct paymentIds independently', async () => {
			const store = createMemoryStore();
			expect(await store.markStatusAnnounced?.('pi_1', 'success')).toBe(true);
			expect(await store.markStatusAnnounced?.('pi_2', 'success')).toBe(true);
			expect(await store.markStatusAnnounced?.('pi_1', 'success')).toBe(false);
		});

		it('treats distinct statuses on the same paymentId independently', async () => {
			// A payment can progress pending → success → refunded. Each
			// transition is its own announcement; claiming `pending` must
			// not preclude later claiming `success`.
			const store = createMemoryStore();
			expect(await store.markStatusAnnounced?.('pi_1', 'pending')).toBe(true);
			expect(await store.markStatusAnnounced?.('pi_1', 'success')).toBe(true);
			expect(await store.markStatusAnnounced?.('pi_1', 'refunded')).toBe(true);
			expect(await store.markStatusAnnounced?.('pi_1', 'pending')).toBe(false);
		});

		it('isolates announcement state across distinct stores', async () => {
			const a = createMemoryStore();
			const b = createMemoryStore();
			expect(await a.markStatusAnnounced?.('pi_1', 'success')).toBe(true);
			expect(await b.markStatusAnnounced?.('pi_1', 'success')).toBe(true);
		});
	});
});
