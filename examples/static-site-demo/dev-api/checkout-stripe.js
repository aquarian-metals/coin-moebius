/**
 * `POST /api/checkout/stripe` — create a Stripe Checkout Session and
 * return `{ url }` for the browser provider to redirect to.
 *
 * Required env:
 *   - `STRIPE_SECRET_KEY` (sk_test_… or sk_live_…)
 *
 * Optional env:
 *   - `STRIPE_SUCCESS_URL` (defaults to `http://localhost:5173/?status=success`)
 *   - `STRIPE_CANCEL_URL`  (defaults to `http://localhost:5173/?status=cancel`)
 */

import Stripe from 'stripe';

export async function handleStripeCheckout(req, res) {
	const secretKey = process.env.STRIPE_SECRET_KEY;
	if (!secretKey) {
		res.statusCode = 503;
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify({
				error: 'STRIPE_SECRET_KEY is not set — Stripe checkout is disabled in this demo session.',
			}),
		);
		return;
	}

	const body = await readJson(req);
	const stripe = new Stripe(secretKey);

	const session = await stripe.checkout.sessions.create({
		mode: 'payment',
		line_items: [
			{
				price_data: {
					currency: body.currency?.toLowerCase() ?? 'usd',
					product_data: { name: `Coin Moebius demo (${body.productId})` },
					unit_amount: Math.round(Number(body.amount) * 100),
				},
				quantity: 1,
			},
		],
		success_url: process.env.STRIPE_SUCCESS_URL ?? 'http://localhost:5173/?status=success',
		cancel_url: process.env.STRIPE_CANCEL_URL ?? 'http://localhost:5173/?status=cancel',
		metadata: body.metadata ?? {},
	});

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	res.end(JSON.stringify({ url: session.url }));
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
}
