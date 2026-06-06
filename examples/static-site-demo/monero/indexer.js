/**
 * Long-running indexer process. Runs next to `monero-wallet-rpc`, polls
 * for incoming transfers, and POSTs HMAC-signed webhooks to your
 * payment-webhook endpoint when payments confirm.
 *
 * Run under systemd (see `monero-indexer.service`), pm2, supervisord,
 * Docker, or whatever fits your ops. The indexer is catch-up by design
 * — if it's offline for a stretch, the next tick will see the missed
 * transfers and emit the webhooks then. Operational SLA is "eventually
 * consistent within a few minutes," not "five-nines uptime."
 */
import { createMoneroIndexer } from '@aquarian-metals/coin-moebius-monero/server';
import { myStore } from './_store.js';

const indexer = createMoneroIndexer({
	walletRpcUrl: process.env.MONERO_WALLET_RPC_URL,
	store: myStore,
	webhookUrl: process.env.MONERO_WEBHOOK_URL,
	hmacSecret: process.env.MONERO_HMAC_SECRET,
	requiredConfirmations: Number(process.env.MONERO_REQUIRED_CONFIRMATIONS ?? 10),
	pollIntervalMs: Number(process.env.MONERO_POLL_INTERVAL_MS ?? 30_000),
	accountIndex: Number(process.env.MONERO_ACCOUNT_INDEX ?? 0),
	logger: {
		info: (m, ctx) => console.log(JSON.stringify({ level: 'info', msg: m, ...ctx })),
		warn: (m, ctx) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...ctx })),
		error: (m, ctx) => console.error(JSON.stringify({ level: 'error', msg: m, ...ctx })),
	},
});

const stop = indexer.start();
console.log(
	JSON.stringify({
		level: 'info',
		msg: 'monero indexer started',
		walletRpcUrl: process.env.MONERO_WALLET_RPC_URL,
		webhookUrl: process.env.MONERO_WEBHOOK_URL,
	}),
);

process.on('SIGTERM', () => {
	stop();
	process.exit(0);
});
process.on('SIGINT', () => {
	stop();
	process.exit(0);
});

// Optionally expose `indexer.status()` over a tiny HTTP endpoint so your
// ops team can scrape it. Uncomment and adapt:
//
// import http from 'node:http';
// http.createServer((req, res) => {
//   if (req.url === '/health') {
//     res.writeHead(200, { 'Content-Type': 'application/json' });
//     res.end(JSON.stringify(indexer.status()));
//     return;
//   }
//   res.writeHead(404).end();
// }).listen(9090);
