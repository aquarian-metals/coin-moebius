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

import { createBitcoinVerifier } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { createBitcoinCashVerifier } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { createCryptomusVerifier } from '@aquarian-metals/coin-moebius-cryptomus/server';
import { createMoneroVerifier } from '@aquarian-metals/coin-moebius-monero/server';
import { createStripeVerifier } from '@aquarian-metals/coin-moebius-stripe/server';
import { createZanoVerifier } from '@aquarian-metals/coin-moebius-zano/server';
import {
	getBitcoinCashHmacSecret,
	getBitcoinHmacSecret,
	getMoneroHmacSecret,
	getRegistry,
	getStore,
	getZanoHmacSecret,
	registerVerifierOnce,
} from './_shared.js';

const stripeSessions = new Map();

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
	if (getMoneroHmacSecret())
		registerVerifierOnce(
			'monero',
			() => createMoneroVerifier({ hmacSecret: getMoneroHmacSecret() }).verify,
		);
	if (getZanoHmacSecret())
		registerVerifierOnce(
			'zano',
			() => createZanoVerifier({ hmacSecret: getZanoHmacSecret() }).verify,
		);
	if (getBitcoinHmacSecret())
		registerVerifierOnce(
			'bitcoin',
			() => createBitcoinVerifier({ hmacSecret: getBitcoinHmacSecret() }).verify,
		);
	if (getBitcoinCashHmacSecret())
		registerVerifierOnce(
			'bitcoin-cash',
			() => createBitcoinCashVerifier({ hmacSecret: getBitcoinCashHmacSecret() }).verify,
		);
}

export async function handlePaymentWebhook(req, res) {
	ensureVerifiersRegistered();

	const rawText = await readText(req);
	const headers = req.headers;

	try {
		const result = await getRegistry().verify(rawText, headers, providerFromPath(req.url));
		if (result?.kind !== 'payment') {
			res.statusCode = 200;
			res.end('event ignored');
			return;
		}

		const session = result.provider === 'stripe' && result.raw?.data?.object;
		const paymentId =
			session?.object === 'checkout.session'
				? session.id
				: result.provider === 'stripe'
					? (stripeSessions.get(result.paymentId) ?? result.paymentId)
					: result.paymentId;
		const existing = await getStore().get(paymentId);
		if (!existing || existing.provider !== result.provider) {
			res.statusCode = 409;
			res.end('No matching checkout');
			return;
		}
		const expectedAmount = existing.metadata.invoiceAmount ?? existing.amount;
		if (
			result.currency !== existing.currency ||
			(result.status === 'success' && result.amount !== expectedAmount)
		) {
			res.statusCode = 409;
			res.end('Payment does not match checkout');
			return;
		}
		if (session?.object === 'checkout.session') stripeSessions.set(result.paymentId, paymentId);
		await getStore().upsert({
			...existing,
			status: result.status,
			amount: result.status === 'pending' ? expectedAmount : result.amount,
			timestamp: result.timestamp,
			metadata: {
				...existing.metadata,
				...result.metadata,
				productId: existing.metadata.productId,
				invoiceAmount: expectedAmount,
			},
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
