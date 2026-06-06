/**
 * ISO-4217 minor-unit conversion. Most currencies have 2 decimal places, but
 * zero-decimal currencies (JPY, KRW, …) have none and three-decimal ones (KWD,
 * BHD, …) have three. Dividing a gateway's minor-unit amount by a hard-coded
 * 100 is therefore wrong: JPY comes out 100× too large, KWD 10× too small. Use
 * these helpers anywhere a provider reports amounts in minor units.
 */

const ZERO_DECIMAL = new Set([
	'BIF',
	'CLP',
	'DJF',
	'GNF',
	'JPY',
	'KMF',
	'KRW',
	'MGA',
	'PYG',
	'RWF',
	'UGX',
	'VND',
	'VUV',
	'XAF',
	'XOF',
	'XPF',
]);

const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

/** Number of minor-unit decimal places for an ISO-4217 code (default 2). */
export function minorUnitExponent(currency: string): number {
	const code = currency.toUpperCase();
	if (ZERO_DECIMAL.has(code)) return 0;
	if (THREE_DECIMAL.has(code)) return 3;
	return 2;
}

/** Convert a gateway minor-unit amount (e.g. 1000 = ¥1000, 199 = $1.99) to major units. */
export function minorToMajorUnits(minor: number, currency: string): number {
	return minor / 10 ** minorUnitExponent(currency);
}

/** Convert a major-unit amount to integer minor units for a gateway API. */
export function majorToMinorUnits(amount: number, currency: string): number {
	return Math.round(amount * 10 ** minorUnitExponent(currency));
}
