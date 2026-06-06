import { describe, it, expect } from 'vitest';
import { asPayment, asSubscription, type WebhookEvent } from '../src/index';

function paymentEvent(): WebhookEvent {
	return {
		kind: 'payment',
		status: 'success',
		paymentId: 'pay_1',
		provider: 'stripe',
		amount: 12.5,
		currency: 'USD',
		metadata: {},
		timestamp: 1700000000000,
	};
}

function subscriptionEvent(): WebhookEvent {
	return {
		kind: 'subscription',
		type: 'subscription.created',
		subscriptionId: 'sub_1',
		provider: 'stripe',
		productId: 'prod_1',
		customerRef: 'cust_1',
		status: 'active',
		currentPeriodEnd: 1700003600,
		amount: 9.99,
		currency: 'USD',
		metadata: {},
		timestamp: 1700000000000,
	};
}

describe('asPayment', () => {
	it('returns the payment shape without the kind discriminator', () => {
		const result = asPayment(paymentEvent());
		expect(result).not.toBeNull();
		expect(result).not.toHaveProperty('kind');
		expect(result?.paymentId).toBe('pay_1');
		expect(result?.status).toBe('success');
	});

	it('returns null for a subscription event', () => {
		expect(asPayment(subscriptionEvent())).toBeNull();
	});

	it('returns null for null and undefined input', () => {
		expect(asPayment(null)).toBeNull();
		expect(asPayment(undefined)).toBeNull();
	});
});

describe('asSubscription', () => {
	it('returns the subscription shape without the kind discriminator', () => {
		const result = asSubscription(subscriptionEvent());
		expect(result).not.toBeNull();
		expect(result).not.toHaveProperty('kind');
		expect(result?.subscriptionId).toBe('sub_1');
		expect(result?.type).toBe('subscription.created');
	});

	it('returns null for a payment event', () => {
		expect(asSubscription(paymentEvent())).toBeNull();
	});

	it('returns null for null and undefined input', () => {
		expect(asSubscription(null)).toBeNull();
		expect(asSubscription(undefined)).toBeNull();
	});
});
