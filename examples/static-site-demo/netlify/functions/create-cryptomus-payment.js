import { createCryptomusCreator } from '@aquarianmetals/coin-moebius-monero-cryptomus/server';

const siteUrl = process.env.URL ?? 'http://localhost:8888';

const create = createCryptomusCreator({
	merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID ?? '',
	paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY ?? '',
	callbackUrl: `${siteUrl}/.netlify/functions/payment-webhook`,
	returnUrl: `${siteUrl}/success`,
});

export default async function handler(req) {
	if (req.method !== 'POST') {
		return { statusCode: 405, body: 'Method not allowed' };
	}

	try {
		const { productId, amount, metadata } = JSON.parse(req.body);

		if (!productId || !amount) {
			throw new Error('Missing required fields: productId, amount');
		}

		const result = await create({ productId, amount, metadata });

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				uuid: result.uuid,
				address: result.address,
				qr: result.qr,
				amount: result.amount,
			}),
		};
	} catch (err) {
		console.error('[create-cryptomus-payment] error:', err);
		return {
			statusCode: 500,
			body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
		};
	}
}
