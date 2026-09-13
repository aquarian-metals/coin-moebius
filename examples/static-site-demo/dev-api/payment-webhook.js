/**
 * `POST /api/payment-webhook/:provider` — provider-agnostic webhook receiver.
 *
 * Dispatches to the shared verifier registry by the provider named in the
 * URL path, which is the trusted channel the registry asks for once more
 * than one verifier is registered (it refuses to pick from the
 * attacker-controllable `x-provider` header or `provider` body field). On a
 * verified payment event, persists the normalized {@link PaymentResult} to
 * the shared store so `/api/payment-status` reads the latest state and the
 * browser's `subscribeToStatus` loop converges to `success`.
 *
 * Idempotent by design — re-delivering the same webhook just re-writes
 * the same record. The merchant's webhook receiver MUST be idempotent for
 * every provider (Stripe, NOWPayments, Cryptomus, Monero all resend).
 */

import { createCryptomusVerifier } from '@aquarian-metals/coin-moebius-cryptomus/server';
import { createMoneroVerifier } from '@aquarian-metals/coin-moebius-monero/server';
import { createStripeVerifier } from '@aquarian-metals/coin-moebius-stripe/server';
import { createZanoVerifier } from '@aquarian-metals/coin-moebius-zano/server';
import {
	getMoneroHmacSecret,
	getRegistry,
	getStore,
	getZanoHmacSecret,
	registerVerifierOnce,
} from './_shared.js';

function ensureVerifiersRegistered() {
	if (process.env.STRIPE_WEBHOOK_SECRET) {
		registerVerifierOnce('stripe', () =>
			createStripeVerifier({
				endpointSecret: process.env.STRIPE_WEBHOOK_SECRET,
				secretKey: process.env.STRIPE_SECRET_KEY,
			}),
		);
	}
	if (process.env.CRYPTOMUS_MERCHANT_UUID && process.env.CRYPTOMUS_PAYMENT_API_KEY) {
		registerVerifierOnce('cryptomus', () =>
			createCryptomusVerifier({
				merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID,
				paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY,
			}),
		);
	}
	registerVerifierOnce('monero', () => {
		const v = createMoneroVerifier({ hmacSecret: getMoneroHmacSecret() });
		return v.verify;
	});
	registerVerifierOnce('zano', () => {
		const v = createZanoVerifier({ hmacSecret: getZanoHmacSecret() });
		return v.verify;
	});
}

export async function handlePaymentWebhook(req, res) {
	ensureVerifiersRegistered();

	const rawText = await readText(req);
	const headers = req.headers;

	let parsed;
	try {
		parsed = rawText ? JSON.parse(rawText) : {};
	} catch {
		res.statusCode = 400;
		res.end('invalid JSON body');
		return;
	}

	try {
		const stripeRaw = headers['stripe-signature'] ? rawText : parsed;
		const result = await getRegistry().verify(stripeRaw, headers, providerFromPath(req.url));
		if (!result) {
			res.statusCode = 200;
			res.end('event ignored');
			return;
		}

		const existing = await getStore().get(result.paymentId);
		await getStore().upsert({
			...existing,
			...result,
			metadata: {
				...(existing?.metadata ?? {}),
				...result.metadata,
			},
			createdAt: existing?.createdAt ?? result.timestamp,
			updatedAt: result.timestamp,
		});

		res.statusCode = 200;
		res.end('ok');
	} catch (err) {
		res.statusCode = 400;
		res.end(`verifier error: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function providerFromPath(url) {
	const path = new URL(url ?? '', 'http://localhost').pathname;
	const suffix = path.replace(/^\/api\/payment-webhook\/?/, '');
	return suffix === '' ? undefined : suffix;
}

async function readText(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}
