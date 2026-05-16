/**
 * `GET /api/payment-status?paymentId=...` — read-through of the shared
 * payment store for the browser's `payments.subscribeToStatus(...)` loop.
 *
 * Mirrors the `PaymentResult` shape so the browser-side polling helper can
 * consume it directly. 404 when the payment id is unknown; 400 when the
 * required `paymentId` query param is missing.
 */

import { getStore } from './_shared.js';

export async function handlePaymentStatus(req, res) {
	const url = new URL(req.url, 'http://localhost');
	const paymentId = url.searchParams.get('paymentId');

	if (!paymentId) {
		res.statusCode = 400;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'paymentId query param required' }));
		return;
	}

	const record = await getStore().get(paymentId);
	if (!record) {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ error: 'unknown paymentId' }));
		return;
	}

	res.statusCode = 200;
	res.setHeader('Content-Type', 'application/json');
	res.end(JSON.stringify(record));
}
