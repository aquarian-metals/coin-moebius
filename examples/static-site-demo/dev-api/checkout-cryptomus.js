/**
 * `POST /api/checkout/cryptomus` — create a Cryptomus invoice and
 * return `{ uuid, address, qr, amount }` for the browser provider.
 *
 * Required env:
 *   - `CRYPTOMUS_MERCHANT_UUID`
 *   - `CRYPTOMUS_PAYMENT_API_KEY`
 *   - `CRYPTOMUS_CALLBACK_URL` (publicly reachable URL for Cryptomus's webhook;
 *     for local dev expose `/api/payment-webhook` via ngrok or cloudflared)
 *   - `CRYPTOMUS_RETURN_URL` (where the buyer lands after paying;
 *     defaults to `http://localhost:5173/?status=success`)
 */

import { createCryptomusCreator } from '@aquarian-metals/coin-moebius-cryptomus/server';
import { getStore } from './_shared.js';

let creator = null;

function getCreator() {
	if (creator) return creator;
	const merchantUuid = process.env.CRYPTOMUS_MERCHANT_UUID;
	const paymentApiKey = process.env.CRYPTOMUS_PAYMENT_API_KEY;
	const callbackUrl = process.env.CRYPTOMUS_CALLBACK_URL;
	const returnUrl = process.env.CRYPTOMUS_RETURN_URL ?? 'http://localhost:5173/?status=success';

	if (!merchantUuid || !paymentApiKey || !callbackUrl) return null;

	creator = createCryptomusCreator({ merchantUuid, paymentApiKey, callbackUrl, returnUrl });
	return creator;
}

export async function handleCryptomusCheckout(req, res) {
	const create = getCreator();
	if (!create) {
		res.statusCode = 503;
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify({
				error:
					'Cryptomus env not configured. Set CRYPTOMUS_MERCHANT_UUID, CRYPTOMUS_PAYMENT_API_KEY, CRYPTOMUS_CALLBACK_URL.',
			}),
		);
		return;
	}

	const body = await readJson(req);
	const result = await create({
		productId: String(body.productId ?? 'demo'),
		amount: Number(body.amount),
		currency: String(body.currency ?? 'USD'),
		metadata: body.metadata ?? {},
	});

	await getStore().upsert({
		status: 'pending',
		paymentId: result.uuid,
		provider: 'cryptomus',
		amount: Number(body.amount),
		currency: String(body.currency ?? 'USD'),
		metadata: {
			...(body.metadata ?? {}),
			address: result.address,
			qr: result.qr,
			cryptomusAmount: result.amount,
		},
		timestamp: Date.now(),
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	res.end(
		JSON.stringify({
			uuid: result.uuid,
			address: result.address,
			qr: result.qr,
			amount: result.amount,
		}),
	);
}

async function readJson(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
}
