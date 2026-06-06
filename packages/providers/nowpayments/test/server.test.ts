import { describe, it, expect } from 'vitest';
import { asPayment } from '@aquarian-metals/coin-moebius-core';
import {
	createNowPaymentsVerifier,
	computeNowPaymentsSignature,
	type NowPaymentsIpnPayload,
} from '../src/server.js';

/**
 * Unit tests for the NOWPayments IPN verifier. We round-trip the same
 * payload through `computeNowPaymentsSignature` and the verifier — if the
 * recursive-sort step were broken (e.g. only sorting top-level keys), a
 * payload with a nested object would mismatch.
 */

const IPN_SECRET = 'TestIpnSecret_unit_tests_only';

function samplePayload(overrides: Partial<NowPaymentsIpnPayload> = {}): NowPaymentsIpnPayload {
	return {
		payment_id: 1234567890,
		payment_status: 'finished',
		pay_address: 'btc1qexampleaddress',
		price_amount: 9.99,
		price_currency: 'usd',
		pay_amount: 0.0002,
		pay_currency: 'btc',
		order_id: 'tx_abc123',
		order_description: 'Coin Moebius — sticker',
		purchase_id: 5555,
		created_at: '2026-05-13T10:00:00Z',
		updated_at: '2026-05-13T10:05:00Z',
		outcome_amount: 0.0002,
		outcome_currency: 'btc',
		actually_paid: 0.0002,
		network: 'btc',
		...overrides,
	};
}

describe('computeNowPaymentsSignature', () => {
	it('produces a hex SHA512 (128 chars) regardless of input', async () => {
		const sig = await computeNowPaymentsSignature(samplePayload(), IPN_SECRET);
		expect(sig).toMatch(/^[0-9a-f]{128}$/);
	});

	it('is deterministic across calls for the same payload', async () => {
		const a = await computeNowPaymentsSignature(samplePayload(), IPN_SECRET);
		const b = await computeNowPaymentsSignature(samplePayload(), IPN_SECRET);
		expect(a).toBe(b);
	});

	it('changes when a single field changes', async () => {
		const original = await computeNowPaymentsSignature(samplePayload(), IPN_SECRET);
		const modified = await computeNowPaymentsSignature(
			samplePayload({ payment_status: 'failed' }),
			IPN_SECRET,
		);
		expect(original).not.toBe(modified);
	});

	it('is independent of input key order (recursive sort fix-up)', async () => {
		// Reverse-ordered keys, including a nested object — should hash the
		// same as the canonical-ordered version.
		const original = samplePayload();
		const reversed: Record<string, unknown> = {};
		for (const key of Object.keys(original).reverse()) {
			reversed[key] = (original as Record<string, unknown>)[key];
		}
		const a = await computeNowPaymentsSignature(original, IPN_SECRET);
		const b = await computeNowPaymentsSignature(reversed, IPN_SECRET);
		expect(a).toBe(b);
	});

	it('recursively sorts nested objects (top-level-only sort would not match)', async () => {
		const withNested = samplePayload({
			// `metadata` is an arbitrary nested object the merchant may have
			// attached. We need to confirm nested keys also normalize.
			...({ metadata: { z: 1, a: 2 } } as Partial<NowPaymentsIpnPayload>),
		});
		const reverseNested = samplePayload({
			...({ metadata: { a: 2, z: 1 } } as Partial<NowPaymentsIpnPayload>),
		});
		const a = await computeNowPaymentsSignature(withNested, IPN_SECRET);
		const b = await computeNowPaymentsSignature(reverseNested, IPN_SECRET);
		expect(a).toBe(b);
	});
});

describe('createNowPaymentsVerifier', () => {
	it('accepts a payload with a valid signature and maps `finished` to success', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		const payload = samplePayload();
		const sig = await computeNowPaymentsSignature(payload, IPN_SECRET);

		const result = asPayment(await verifier.verify(payload, { 'x-nowpayments-sig': sig }));
		expect(result!.status).toBe('success');
		expect(result!.provider).toBe('nowpayments');
		expect(result!.paymentId).toBe('1234567890');
		expect(result!.amount).toBe(9.99);
		expect(result!.currency).toBe('USD');
		expect((result!.metadata as { orderId: string }).orderId).toBe('tx_abc123');
	});

	it('maps in-flight statuses to pending', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		for (const status of ['waiting', 'confirming', 'confirmed', 'sending']) {
			const payload = samplePayload({ payment_status: status });
			const sig = await computeNowPaymentsSignature(payload, IPN_SECRET);
			const result = asPayment(await verifier.verify(payload, { 'x-nowpayments-sig': sig }));
			expect(result!.status).toBe('pending');
		}
	});

	it('maps partially_paid to partial and reports actually_paid as the amount', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		const payload = samplePayload({
			payment_status: 'partially_paid',
			price_amount: 30,
			actually_paid: 25.5,
		});
		const sig = await computeNowPaymentsSignature(payload, IPN_SECRET);
		const result = asPayment(await verifier.verify(payload, { 'x-nowpayments-sig': sig }));
		expect(result!.status).toBe('partial');
		expect(result!.amount).toBe(25.5);
		expect(result!.metadata).toMatchObject({ actuallyPaid: 25.5, invoicedAmount: 30 });
	});

	it('maps refunded to refunded (Surface A: refunds reach the merchant)', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		const payload = samplePayload({ payment_status: 'refunded' });
		const sig = await computeNowPaymentsSignature(payload, IPN_SECRET);
		const result = asPayment(await verifier.verify(payload, { 'x-nowpayments-sig': sig }));
		expect(result!.status).toBe('refunded');
	});

	it('maps failed/expired to failed', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		for (const status of ['failed', 'expired']) {
			const payload = samplePayload({ payment_status: status });
			const sig = await computeNowPaymentsSignature(payload, IPN_SECRET);
			const result = asPayment(await verifier.verify(payload, { 'x-nowpayments-sig': sig }));
			expect(result!.status).toBe('failed');
		}
	});

	it('rejects a payload signed with the wrong key', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		const payload = samplePayload();
		const wrongSig = await computeNowPaymentsSignature(payload, 'wrong_key');
		await expect(verifier.verify(payload, { 'x-nowpayments-sig': wrongSig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a tampered body with a stale signature', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		const sig = await computeNowPaymentsSignature(samplePayload(), IPN_SECRET);
		const tampered = samplePayload({ price_amount: 99999 });
		await expect(verifier.verify(tampered, { 'x-nowpayments-sig': sig })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects when the x-nowpayments-sig header is missing', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		await expect(verifier.verify(samplePayload(), {})).rejects.toThrow(/missing/);
	});

	it('accepts a raw JSON string body and a parsed object equivalently', async () => {
		const verifier = createNowPaymentsVerifier({ ipnSecret: IPN_SECRET });
		const payload = samplePayload();
		const sig = await computeNowPaymentsSignature(payload, IPN_SECRET);

		const fromObject = asPayment(await verifier.verify(payload, { 'x-nowpayments-sig': sig }));
		const fromString = asPayment(
			await verifier.verify(JSON.stringify(payload), { 'x-nowpayments-sig': sig }),
		);
		expect(fromObject!.paymentId).toBe(fromString!.paymentId);
	});
});
