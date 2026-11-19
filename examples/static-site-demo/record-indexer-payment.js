import { isStatusRegression } from '@aquarian-metals/coin-moebius-core';

// The indexer and the receiver share the checkout store. Fulfillment belongs to
// the merchant and must be idempotent by order ID, including across retries.
export async function recordIndexerPayment(store, result, fulfillOnce) {
	const saved = await store.get(result.paymentId);
	if (!saved || saved.provider !== result.provider || saved.currency !== result.currency)
		return new Response('No matching checkout', { status: 409 });
	const expectedAmount = saved.metadata.invoiceAmount ?? saved.amount;
	if (result.status === 'success' && result.amount !== expectedAmount)
		return new Response('Amount mismatch', { status: 409 });
	if (isStatusRegression(saved.status, result.status)) return new Response('');
	const order = {
		...saved,
		status: result.status,
		amount: result.amount,
		timestamp: result.timestamp,
		metadata: {
			...saved.metadata,
			...result.metadata,
			productId: saved.metadata.productId,
			invoiceAmount: expectedAmount,
		},
	};
	await store.upsert(order);
	if (result.status !== 'success') return new Response('');
	// Keep the delivery claim separate from the indexer's webhook announcement.
	const claim = 'fulfillment/' + order.provider + '/' + order.paymentId;
	if (store.markStatusAnnounced && store.unmarkStatusAnnounced) {
		if (!(await store.markStatusAnnounced(claim, 'success'))) return new Response('');
		try {
			await fulfillOnce(order);
		} catch (error) {
			await store.unmarkStatusAnnounced(claim, 'success');
			throw error;
		}
	} else {
		await fulfillOnce(order);
	}
	return new Response('');
}
