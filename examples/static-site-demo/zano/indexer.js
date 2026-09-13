/**
 * Long-running indexer process. Runs next to `simplewallet`, polls its
 * transfer history, and POSTs HMAC-signed webhooks to your payment-webhook
 * endpoint as payments gather confirmations and settle.
 *
 * Run under systemd (see `zano-indexer.service`), pm2, supervisord, Docker,
 * or whatever fits your ops. The indexer is catch-up by design: if it's
 * offline for a stretch, the next tick sees the missed payments and emits
 * the webhooks then.
 */
import { createZanoIndexer } from '@aquarian-metals/coin-moebius-zano/server';
import { myStore } from './_store.js';

const indexer = createZanoIndexer({
	walletRpcUrl: process.env.ZANO_WALLET_RPC_URL,
	jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
	store: myStore,
	webhookUrl: process.env.ZANO_WEBHOOK_URL,
	hmacSecret: process.env.ZANO_HMAC_SECRET,
	requiredConfirmations: Number(process.env.ZANO_REQUIRED_CONFIRMATIONS ?? 10),
	pollIntervalMs: Number(process.env.ZANO_POLL_INTERVAL_MS ?? 30_000),
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
		msg: 'zano indexer started',
		walletRpcUrl: process.env.ZANO_WALLET_RPC_URL,
		webhookUrl: process.env.ZANO_WEBHOOK_URL,
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
