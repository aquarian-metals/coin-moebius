import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createBitcoinCashVerifier } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { recordIndexerPayment } from '../record-indexer-payment.js';
import { myStore } from './_store.js';

const verifiers = createVerifierRegistry();
verifiers.register(
	'bitcoin-cash',
	createBitcoinCashVerifier({ hmacSecret: process.env.BCH_HMAC_SECRET }).verify,
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

		return await recordIndexerPayment(myStore, result, onPaymentSucceeded);
	} catch (err) {
		console.error('[payment-webhook] error:', err);
		return new Response('', { status: 400 });
	}
};

// This callback may run again after a restart or lost reply. Insert the grant
// under a unique order ID using the buyer recorded at checkout.
async function onPaymentSucceeded(order) {
	console.log(
		`[payment-webhook] paid: ${order.paymentId} ${order.metadata.productId} ${order.metadata.receivedAmountBch} BCH`,
	);
}
