import { describe, it, expect } from 'vitest';
import { toPublicPaymentResult, type PaymentResult } from '../src/index';

function result(): PaymentResult {
	return {
		status: 'success',
		paymentId: 'pi_1',
		provider: 'stripe',
		amount: 19.99,
		currency: 'USD',
		metadata: {
			productId: 'sku-1',
			email: 'buyer@example.com',
			customer_details: { email: 'buyer@example.com' },
		},
		timestamp: 1_700_000_000_000,
		raw: { huge: 'gateway event', secrets: 'here' },
	};
}

describe('toPublicPaymentResult (W2 — browser-safe projection)', () => {
	it('drops the raw gateway event', () => {
		const pub = toPublicPaymentResult(result()) as unknown as Record<string, unknown>;
		expect(pub.raw).toBeUndefined();
	});

	it('strips buyer PII from metadata but keeps merchant fields', () => {
		const pub = toPublicPaymentResult(result());
		expect(pub.metadata.productId).toBe('sku-1');
		expect(pub.metadata.email).toBeUndefined();
		expect(pub.metadata.customer_details).toBeUndefined();
	});

	it('keeps the status/amount/ids the page needs', () => {
		const pub = toPublicPaymentResult(result());
		expect(pub).toMatchObject({
			status: 'success',
			paymentId: 'pi_1',
			provider: 'stripe',
			amount: 19.99,
			currency: 'USD',
		});
	});
});
