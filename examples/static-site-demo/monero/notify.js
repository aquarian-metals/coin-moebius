/**
 * Hook script for `monero-wallet-rpc --tx-notify`. Wallet RPC fires this
 * with the tx hash whenever it sees an incoming transaction. The
 * indexer's `processTx(hash)` then emits a webhook immediately, before
 * the polling loop catches it.
 *
 * The polling loop in `indexer.js` is still required — it counts
 * confirmations as they accumulate and acts as the backstop for any
 * notification the wallet might miss.
 *
 *   monero-wallet-rpc ... --tx-notify "/usr/bin/node /opt/coin-moebius/notify.js %s"
 */
import { createMoneroIndexer } from '@aquarian-metals/coin-moebius-monero/server';
import { myStore } from './_store.js';

const indexer = createMoneroIndexer({
	walletRpcUrl: process.env.MONERO_WALLET_RPC_URL,
	store: myStore,
	webhookUrl: process.env.MONERO_WEBHOOK_URL,
	hmacSecret: process.env.MONERO_HMAC_SECRET,
	requiredConfirmations: Number(process.env.MONERO_REQUIRED_CONFIRMATIONS ?? 10),
});

const txHash = process.argv[2];
if (!txHash) {
	console.error('notify.js: missing tx hash argument');
	process.exit(1);
}

try {
	await indexer.processTx(txHash);
	process.exit(0);
} catch (err) {
	console.error('notify.js: processTx failed:', err);
	process.exit(2);
}
