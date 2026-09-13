/**
 * In-process simulator for `simplewallet` in RPC mode. Implements just
 * enough of the JSON-RPC surface for {@link createZanoCreator} and
 * {@link createZanoIndexer} to run end-to-end without a Zano node:
 *
 *   - `assets_whitelist_add({ asset_id })`: returns the asset's descriptor (Freedom Dollar is known).
 *   - `make_integrated_address({ payment_id })`: folds the payment id into a fake address.
 *   - `get_recent_txs_and_info3({ offset, count, … })`: serves simulated transfers newest first.
 *
 * Exposes {@link simulateBuyerPayment} for the dev-only `/api/mock/pay-zano`
 * endpoint to inject a transfer that satisfies a given payment record.
 */

const FREEDOM_DOLLAR_ASSET_ID = '86143388bd056a8f0bab669f78f14873fac8e2dd8d57898cdb725a2d5e2e4f8f';

const KNOWN_ASSETS = new Map([
	[
		FREEDOM_DOLLAR_ASSET_ID,
		{
			ticker: 'fUSD',
			full_name: 'Freedom Dollar',
			decimal_point: 4,
			current_supply: 120000000000,
			total_max_supply: 10000000000000000000,
			owner: '497d6b7acd06401c59b2d52a3967968e8ca507a25f80e44d2bb4b5f8a348c7c1',
			meta_info: '',
			hidden_supply: false,
		},
	],
]);

const STATE = {
	height: 3_900_000,
	heightOffsetStart: Date.now(),
	transfers: [],
};

function currentHeight() {
	const elapsedMinutes = Math.floor((Date.now() - STATE.heightOffsetStart) / 60_000);
	return STATE.height + elapsedMinutes;
}

function fakeTxHash() {
	let hex = '';
	for (let i = 0; i < 64; i++) hex += Math.floor(Math.random() * 16).toString(16);
	return hex;
}

export async function handleZanoWalletRpc(method, params) {
	switch (method) {
		case 'assets_whitelist_add': {
			const descriptor = KNOWN_ASSETS.get(String(params.asset_id ?? ''));
			if (!descriptor) return { status: 'NOT_FOUND', asset_descriptor: {} };
			return { status: 'OK', asset_descriptor: descriptor };
		}

		case 'make_integrated_address': {
			const paymentId = String(params.payment_id ?? '');
			return {
				integrated_address: `iZMockZanoIntegrated${paymentId}TheRestIsPaddingToLookLikeAnAddress`,
				payment_id: paymentId,
			};
		}

		case 'get_recent_txs_and_info3': {
			const offset = Number(params.offset ?? 0);
			const count = Number(params.count ?? 50);
			const height = currentHeight();
			const ordered = [...STATE.transfers].sort((a, b) => b.height - a.height);
			return {
				pi: { curent_height: height, balance: 0, unlocked_balance: 0 },
				total_transfers: ordered.length,
				last_item_index: Math.min(ordered.length, offset + count),
				transfers: ordered.slice(offset, offset + count).map((t) => ({
					tx_hash: t.txHash,
					height: t.height,
					timestamp: t.timestamp,
					fee: 10000000000,
					is_mining: false,
					is_service: false,
					subtransfers_by_pid: [
						{
							payment_id: t.paymentReference,
							subtransfers: [{ amount: t.amount, is_income: true, asset_id: t.assetId }],
						},
					],
				})),
			};
		}

		default:
			throw new Error(`mock-zano-wallet-rpc: method "${method}" not implemented`);
	}
}

/**
 * Inject a transfer on the given payment id, in the given asset, mature
 * enough to pass the demo's `requiredConfirmations: 1` on the next tick.
 */
export function simulateBuyerPayment({ paymentReference, assetId, atomicAmount }) {
	STATE.transfers.push({
		txHash: fakeTxHash(),
		height: currentHeight() - 5,
		timestamp: Math.floor(Date.now() / 1000),
		paymentReference,
		assetId,
		amount: String(atomicAmount),
	});
}
