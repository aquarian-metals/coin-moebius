import { isStatusRegression } from '@aquarian-metals/coin-moebius-core';
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createBitcoinCashVerifier } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
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

		const existing = await myStore.get(result.paymentId);
		if (existing && existing.status === result.status) {
			return new Response('', { status: 200 });
		}
		if (existing && isStatusRegression(existing.status, result.status)) {
			return new Response('', { status: 200 });
		}

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
	console.log(
		`[payment-webhook] paid: ${order.paymentId} ${order.metadata.productId} ${order.metadata.receivedAmountBch} BCH`,
	);
}
