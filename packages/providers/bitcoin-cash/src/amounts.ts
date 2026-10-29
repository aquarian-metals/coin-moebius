export const BCH_DECIMALS = 8;

export function formatAtomic(atomic: bigint): string {
	const digits = atomic.toString().padStart(BCH_DECIMALS + 1, '0');
	const whole = digits.slice(0, digits.length - BCH_DECIMALS);
	const fraction = digits.slice(digits.length - BCH_DECIMALS).replace(/0+$/, '');
	return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
