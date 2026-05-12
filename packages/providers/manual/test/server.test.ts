import { describe, it, expect } from 'vitest';
import {
	generateReferenceCode,
	markReceived,
	cancelPending,
	expirePending,
	type ManualTransactionState,
} from '../src/server';

describe('generateReferenceCode', () => {
	it('produces a code with the default GBK prefix and 4 random chars', () => {
		const code = generateReferenceCode();
		expect(code).toMatch(/^GBK-[A-HJKMNPQRSTUVWXYZ23456789]{4}$/);
	});

	it('accepts a custom prefix and length', () => {
		const code = generateReferenceCode({ prefix: 'CASH', length: 6 });
		expect(code).toMatch(/^CASH-[A-HJKMNPQRSTUVWXYZ23456789]{6}$/);
	});

	it('omits ambiguous characters (0, O, 1, I, L) from the random portion', () => {
		// Sample many codes to catch edge cases in the alphabet pick.
		for (let i = 0; i < 2000; i++) {
			const random = generateReferenceCode().split('-')[1];
			expect(random).not.toMatch(/[01OIL]/);
		}
	});

	it('produces different codes on repeated calls', () => {
		const codes = new Set(Array.from({ length: 100 }, () => generateReferenceCode()));
		// With 4 chars from a 31-char alphabet (~924k codes), 100 samples should
		// essentially never collide; tolerating a rare collision keeps the test
		// non-flaky.
		expect(codes.size).toBeGreaterThan(95);
	});
});

const baseState: ManualTransactionState = {
	status: 'pending_manual',
	referenceCode: 'GBK-TEST',
	createdAt: 1_700_000_000_000,
	expectedAmount: 30,
	expectedCurrency: 'Goldback',
};

describe('markReceived', () => {
	it('transitions pending_manual to succeeded and returns a success PaymentResult', () => {
		const { state, result } = markReceived(baseState, 30);
		expect(state.status).toBe('succeeded');
		expect(state.receivedAmount).toBe(30);
		expect(state.confirmedAt).toBeTypeOf('number');
		expect(result.status).toBe('success');
		expect(result.amount).toBe(30);
		expect(result.provider).toBe('manual');
		expect(result.paymentId).toBe('GBK-TEST');
		expect(result.metadata.amountMatch).toBe(true);
	});

	it('marks amountMatch=false when received differs from expected', () => {
		const { result } = markReceived(baseState, 25);
		expect(result.metadata.amountMatch).toBe(false);
		// The result reports the actual received amount, not the expected.
		expect(result.amount).toBe(25);
	});

	it('throws when the transaction is not in pending_manual', () => {
		const canceled: ManualTransactionState = { ...baseState, status: 'manual_canceled' };
		expect(() => markReceived(canceled, 30)).toThrow(/not "pending_manual"/);
	});
});

describe('cancelPending', () => {
	it('transitions pending_manual to manual_canceled', () => {
		const next = cancelPending(baseState);
		expect(next.status).toBe('manual_canceled');
	});

	it('throws when not in pending_manual', () => {
		const succeeded: ManualTransactionState = { ...baseState, status: 'succeeded' };
		expect(() => cancelPending(succeeded)).toThrow(/not "pending_manual"/);
	});
});

describe('expirePending', () => {
	it('transitions pending_manual to manual_expired', () => {
		const next = expirePending(baseState);
		expect(next.status).toBe('manual_expired');
	});

	it('throws when not in pending_manual', () => {
		expect(() => expirePending({ ...baseState, status: 'succeeded' })).toThrow();
	});
});
