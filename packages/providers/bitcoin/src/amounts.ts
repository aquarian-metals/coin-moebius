/** Bitcoin carries eight decimal places. One satoshi is 10^-8 BTC. */
export const BTC_DECIMALS = 8;

/**
 * Satoshis to an exact decimal string of BTC with no trailing zeros.
 *
 * This is the only honest way to write an amount for a buyer. The satoshi
 * integer is what the invoice actually requires; a float built from it can
 * print binary noise or slide into exponent form, and a buyer who types what
 * they read would then underpay. Lives here because both the browser modal
 * and the server creator have to print the same number.
 */
export function formatAtomic(atomic: bigint): string {
	const digits = atomic.toString().padStart(BTC_DECIMALS + 1, '0');
	const whole = digits.slice(0, digits.length - BTC_DECIMALS);
	const fraction = digits.slice(digits.length - BTC_DECIMALS).replace(/0+$/, '');
	return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
