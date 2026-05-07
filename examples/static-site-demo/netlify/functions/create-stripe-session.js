import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
	apiVersion: '2025-02-24.acacia',
});

export default async function handler(req) {
	if (req.method !== 'POST') {
		return { statusCode: 405, body: 'Method not allowed' };
	}

	try {
		const { productId, amount, currency, metadata } = JSON.parse(req.body);

		if (!productId || !amount || !currency) {
			throw new Error('Missing required fields: productId, amount, currency');
		}

		const session = await stripe.checkout.sessions.create({
			payment_method_types: ['card'],
			line_items: [
				{
					price_data: {
						currency: currency.toLowerCase(),
						product_data: {
							name: metadata?.productName || `Product ${productId}`,
							description: metadata?.description || '',
						},
						unit_amount: Math.round(amount * 100),
					},
					quantity: 1,
				},
			],
			mode: 'payment',
			success_url: `${new URL(req.url ?? 'http://localhost/', 'http://localhost').origin}/success?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${new URL(req.url ?? 'http://localhost/', 'http://localhost').origin}/`,
			metadata: {
				...metadata,
				productId,
			},
		});

		return {
			statusCode: 200,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: session.id }),
		};
	} catch (err) {
		console.error('[create-stripe-session] error:', err);
		return {
			statusCode: 500,
			body: JSON.stringify({ error: err instanceof Error ? err.message : 'Unknown error' }),
		};
	}
}
