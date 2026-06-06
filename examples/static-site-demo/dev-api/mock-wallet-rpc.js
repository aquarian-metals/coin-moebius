/**
 * In-process simulator for `monero-wallet-rpc`. Implements just enough of
 * the JSON-RPC surface for {@link createMoneroCreator} and
 * {@link createMoneroIndexer} to run end-to-end without a real Monero node:
 *
 *   - `create_address(account_index, label)` — mints a subaddress, stores the label.
 *   - `get_height()` — returns a virtual block height that ticks forward over time.
 *   - `get_address({ account_index })` — enumerates the labels (paymentId map).
 *   - `get_transfers({ in, ... })` — returns simulated incoming transfers.
 *
 * Exposes {@link simulateBuyerPayment} for the dev-only `/api/mock/pay-monero`
 * endpoint to inject a transfer that satisfies a given payment record.
 */

const STATE = {
	height: 1_000_000,
	heightOffsetStart: Date.now(),
	subaddresses: new Map(),
	nextAddressIndex: 1,
	transfers: [],
};

function currentHeight() {
	const elapsedSeconds = Math.floor((Date.now() - STATE.heightOffsetStart) / 2);
	return STATE.height + elapsedSeconds;
}

function fakeAddress(index) {
	const padded = String(index).padStart(8, '0');
	return `4MockMoneroSubAddr${padded}TheRestIsJustPaddingToLookLikeAnXMRAddress`;
}

function fakeTxHash() {
	let hex = '';
	for (let i = 0; i < 64; i++) hex += Math.floor(Math.random() * 16).toString(16);
	return hex;
}

export async function handleWalletRpc(method, params) {
	switch (method) {
		case 'create_address': {
			const accountIndex = Number(params.account_index ?? 0);
			const label = String(params.label ?? '');
			const addressIndex = STATE.nextAddressIndex++;
			const address = fakeAddress(addressIndex);
			STATE.subaddresses.set(addressIndex, { address, label, accountIndex });
			return { address, address_index: addressIndex };
		}

		case 'get_height': {
			return { height: currentHeight() };
		}

		case 'get_address': {
			const accountIndex = Number(params.account_index ?? 0);
			const addresses = [{ address: fakeAddress(0), address_index: 0, label: '', used: false }];
			for (const [addressIndex, info] of STATE.subaddresses) {
				if (info.accountIndex !== accountIndex) continue;
				addresses.push({
					address: info.address,
					address_index: addressIndex,
					label: info.label,
					used: false,
				});
			}
			return { address: fakeAddress(0), addresses };
		}

		case 'get_transfers': {
			const wantsIn = Boolean(params.in);
			if (!wantsIn) return {};
			const accountIndex = Number(params.account_index ?? 0);
			const height = currentHeight();
			const result = STATE.transfers
				.filter((t) => t.accountIndex === accountIndex)
				.map((t) => ({
					txid: t.txid,
					amount: t.amount,
					height: t.height,
					confirmations: Math.max(0, height - t.height),
					subaddr_index: { major: t.accountIndex, minor: t.addressIndex },
					address: fakeAddress(t.addressIndex),
				}));
			return { in: result };
		}

		default:
			throw new Error(`mock-wallet-rpc: method "${method}" not implemented`);
	}
}

/**
 * Inject a transfer that matches the given subaddress + amount, immediately
 * mature enough to pass the indexer's `requiredConfirmations` check on the
 * very next tick.
 */
export function simulateBuyerPayment({ addressIndex, accountIndex, atomicAmount }) {
	const height = currentHeight();
	STATE.transfers.push({
		txid: fakeTxHash(),
		amount: String(atomicAmount),
		addressIndex,
		accountIndex,
		height: height - 5,
	});
}
