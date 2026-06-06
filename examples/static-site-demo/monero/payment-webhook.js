/**
 * /api/payment-webhook — receives HMAC-signed webhooks from the Monero
 * indexer (or any other provider you wire in here). Verifies the
 * signature, normalizes the payload, persists, and runs fulfillment.
 *
 * Idempotency note: like every payment webhook (Stripe, NOWPayments,
 * etc.), this handler MUST be safe to call twice with the same payload.
 * Treat a duplicate `(paymentId, status)` as a no-op and return 200.
 */
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createMoneroVerifier } from '@aquarian-metals/coin-moebius-monero/server';
import { myStore } from './_store.js';

const verifiers = createVerifierRegistry();
verifiers.register(
	'monero',
	createMoneroVerifier({ hmacSecret: process.env.MONERO_HMAC_SECRET }).verify,
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
			// Duplicate webhook — idempotent no-op.
			return new Response('', { status: 200 });
		}

		await myStore.upsert({
			...result,
			createdAt: existing?.createdAt ?? result.timestamp,
			updatedAt: Date.now(),
		});

		if (result.status === 'success') {
			// Fulfill the order. This is your fulfilment logic — unlock
			// the digital download, email the buyer, etc.
			await onPaymentSucceeded(result);
		}

		return new Response('', { status: 200 });
	} catch (err) {
		console.error('[payment-webhook] error:', err);
		return new Response('', { status: 400 });
	}
};

async function onPaymentSucceeded(result) {
	// Replace with your real fulfilment.
	console.log(`[payment-webhook] paid: ${result.paymentId} ${result.amount} ${result.currency}`);
}
