/**
 * /api/payment-webhook: receives HMAC-signed webhooks from the Bitcoin
 * indexer (or any other provider you wire in here). Verifies the
 * signature, normalizes the payload, persists, and runs fulfillment.
 *
 * Idempotency note: like every payment webhook, this handler MUST be safe
 * to call twice with the same payload. Treat a duplicate
 * `(paymentId, status)` as a no-op and return 200.
 */
import { isStatusRegression } from '@aquarian-metals/coin-moebius-core';
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createBitcoinVerifier } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myStore } from './_store.js';

const verifiers = createVerifierRegistry();
verifiers.register(
	'bitcoin',
	createBitcoinVerifier({ hmacSecret: process.env.BITCOIN_HMAC_SECRET }).verify,
);

export default async (req) => {
	if (req.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}
	try {
		const rawBody = await req.text();
		const headers = Object.fromEntries(req.headers.entries());
		const result = await verifiers.verify(rawBody, headers);
		if (!result) return new Response('', { status: 200 });

		const existing = await myStore.get(result.paymentId);
		if (existing && existing.status === result.status) {
			return new Response('', { status: 200 });
		}
		// Never step a settled payment back. A `pending` progress message that
		// is re-sent after `success` must not reopen a paid order.
		if (existing && isStatusRegression(existing.status, result.status)) {
			return new Response('', { status: 200 });
		}

		// Merge, never replace. The stored order holds the amount the buyer was
		// asked to pay, and the indexer checks every payment against it; an
		// order overwritten with only the event's fields has lost that amount.
		const order = {
			...existing,
			...result,
			metadata: { ...existing?.metadata, ...result.metadata },
			createdAt: existing?.createdAt ?? result.timestamp,
			updatedAt: Date.now(),
		};
		await myStore.upsert(order);

		if (result.status === 'success') {
			await onPaymentSucceeded(order);
		}

		return new Response('', { status: 200 });
	} catch (err) {
		console.error('[payment-webhook] error:', err);
		return new Response('', { status: 400 });
	}
};

async function onPaymentSucceeded(order) {
	// Replace with your real fulfilment. `order.metadata.productId` names what
	// was bought, and anything attached at checkout (an email, say) is here too.
	console.log(
		`[payment-webhook] paid: ${order.paymentId} ${order.metadata.productId} ${order.metadata.receivedAmountBtc} BTC`,
	);
}
