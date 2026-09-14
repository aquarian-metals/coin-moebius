/**
 * Asset identity on Zano is the 64-character hex `asset_id`. Tickers and
 * names are decoration anyone can copy, so everything the SDK stores,
 * matches, and verifies keys off the id.
 */
export interface ZanoAsset {
	assetId: string;
	ticker: string;
	/** Number of decimal places one whole unit carries (12 for ZANO, 4 for Freedom Dollar). */
	decimalPoint: number;
}

/** The chain's own coin. Not a deployed asset, so the daemon's `get_asset_info` does not know it. */
export const ZANO_ASSET_ID = 'd6329b5b1f7c0805b5c345f4957554002a2f557845f64d7645dae0e051a6498a';

/**
 * Freedom Dollar (fUSD), the stablecoin issued on Zano. Verified against the
 * chain's own `get_asset_info`, Zano's published asset list, and CoinGecko.
 */
export const FREEDOM_DOLLAR_ASSET_ID =
	'86143388bd056a8f0bab669f78f14873fac8e2dd8d57898cdb725a2d5e2e4f8f';

export const ZANO_NATIVE_ASSET: ZanoAsset = {
	assetId: ZANO_ASSET_ID,
	ticker: 'ZANO',
	decimalPoint: 12,
};

export function isZanoAssetId(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Atomic units to an exact decimal string with no trailing zeros.
 *
 * This is the only honest way to write an amount for a buyer. The atomic
 * integer is what the invoice actually requires; a float built from it can
 * print binary noise or slide into exponent form, and a buyer who types what
 * they read would then underpay. Lives beside the asset definitions because
 * both the browser modal and the server creator have to print the same number.
 */
export function formatAtomic(atomic: bigint, decimalPoint: number): string {
	const digits = atomic.toString().padStart(decimalPoint + 1, '0');
	const whole = digits.slice(0, digits.length - decimalPoint);
	const fraction = digits.slice(digits.length - decimalPoint).replace(/0+$/, '');
	return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}
