/**
 * Long-running indexer process. Runs next to `bitcoind`, polls your
 * watch-only wallet, and POSTs HMAC-signed webhooks to your payment-webhook
 * endpoint as payments gather confirmations and settle.
 *
 * Run under systemd (see `bitcoin-indexer.service`), pm2, supervisord,
 * Docker, or whatever fits your ops. The indexer is catch-up by design: if
 * it's offline for a stretch, the next tick sees the missed payments and
 * emits the webhooks then.
 */
import { createBitcoinIndexer } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myStore } from './_store.js';

const indexer = createBitcoinIndexer({
	rpcUrl: process.env.BITCOIN_RPC_URL,
	wallet: process.env.BITCOIN_WALLET,
	rpcUser: process.env.BITCOIN_RPC_USER,
	rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
	store: myStore,
	webhookUrl: process.env.BITCOIN_WEBHOOK_URL,
	hmacSecret: process.env.BITCOIN_HMAC_SECRET,
	requiredConfirmations: Number(process.env.BITCOIN_REQUIRED_CONFIRMATIONS ?? 1),
	pollIntervalMs: Number(process.env.BITCOIN_POLL_INTERVAL_MS ?? 30_000),
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
		msg: 'bitcoin indexer started',
		rpcUrl: process.env.BITCOIN_RPC_URL,
		wallet: process.env.BITCOIN_WALLET,
		webhookUrl: process.env.BITCOIN_WEBHOOK_URL,
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
