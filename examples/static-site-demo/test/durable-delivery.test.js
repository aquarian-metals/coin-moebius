import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { recordIndexerPayment } from '../record-indexer-payment.js';

it('recovers after payment persistence and grants one download to the saved buyer', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'coin-moebius-delivery-'));
	const path = join(dir, 'orders.sqlite');
	let db = new DatabaseSync(path);
	try {
		db.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY, buyer TEXT NOT NULL, record TEXT NOT NULL);
 CREATE TABLE downloads(order_id TEXT PRIMARY KEY REFERENCES orders(id), buyer TEXT NOT NULL);`);
		const pending = {
			provider: 'bitcoin',
			paymentId: 'order',
			amount: 12,
			currency: 'USD',
			status: 'pending',
			metadata: { productId: 'guide' },
			timestamp: 1,
		};
		db.prepare('INSERT INTO orders VALUES(?,?,?)').run('order', 'buyer-a', JSON.stringify(pending));
		const store = {
			get(id) {
				const row = db.prepare('SELECT record FROM orders WHERE id=?').get(id);
				return row && JSON.parse(row.record);
			},
			upsert(record) {
				db.prepare('UPDATE orders SET record=? WHERE id=?').run(
					JSON.stringify(record),
					record.paymentId,
				);
			},
		};
		const grant = (order) =>
			db
				.prepare(
					`INSERT INTO downloads(order_id,buyer) SELECT id,buyer FROM orders
 WHERE id=? AND json_extract(record,'$.status')='success' ON CONFLICT(order_id) DO NOTHING`,
				)
				.run(order.paymentId);
		const downloads = (buyer) =>
			db.prepare('SELECT count(*) AS n FROM downloads WHERE buyer=?').get(buyer).n;
		const paid = { ...pending, status: 'success' };
		await recordIndexerPayment(store, pending, grant);
		expect(downloads('buyer-a')).toBe(0);
		await expect(
			recordIndexerPayment(store, paid, () => {
				throw new Error('worker stopped');
			}),
		).rejects.toThrow('worker stopped');
		db.close();
		db = new DatabaseSync(path);
		expect(store.get('order').status).toBe('success');
		expect(downloads('buyer-a')).toBe(0);
		await expect(
			recordIndexerPayment(store, paid, (order) => {
				grant(order);
				throw new Error('response lost');
			}),
		).rejects.toThrow('response lost');
		db.close();
		db = new DatabaseSync(path);
		await Promise.all([
			recordIndexerPayment(store, paid, grant),
			recordIndexerPayment(store, paid, grant),
		]);
		expect(downloads('buyer-a')).toBe(1);
		expect(downloads('buyer-b')).toBe(0);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
