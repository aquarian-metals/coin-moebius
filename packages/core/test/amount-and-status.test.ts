import { expect, it } from 'vitest';
import {
	minorUnitExponent,
	minorToMajorUnits,
	majorToMinorUnits,
	paymentStatusRank,
	isStatusRegression,
	type PaymentStatus,
} from '../src/index.js';

it.each([
	['jpy', 0, 142, 142],
	['USD', 2, 1.99, 199],
	['kwd', 3, 1.234, 1234],
] as const)('converts %s amounts in both directions', (code, exponent, major, minor) => {
	expect(minorUnitExponent(code)).toBe(exponent);
	expect(majorToMinorUnits(major, code)).toBe(minor);
	expect(minorToMajorUnits(minor, code)).toBe(major);
});

const stages: PaymentStatus[][] = [
	['pending'],
	['partial'],
	['failed', 'success'],
	['disputed', 'refunded'],
];
it('preserves the documented ordering for every pair of statuses', () => {
	for (const [i, previous] of stages.entries()) {
		for (const status of previous) {
			expect(paymentStatusRank(status)).toBe(i);
			for (const [j, next] of stages.entries()) {
				for (const candidate of next) expect(isStatusRegression(status, candidate)).toBe(j < i);
			}
		}
	}
});
