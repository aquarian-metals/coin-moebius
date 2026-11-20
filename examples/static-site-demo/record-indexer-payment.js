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
	// A delivery marker written before the grant can strand a paid buyer after a crash.
	// The grant itself must be idempotent, using the saved order ID as its unique key.
	const current = await store.get(order.paymentId);
	if (current?.status === 'success') await fulfillOnce(current);
	return new Response('');
}
