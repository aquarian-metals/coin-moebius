import { createBitcoinCashIndexer } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { myStore } from './_store.js';

const indexer = createBitcoinCashIndexer({
	rpcUrl: process.env.BCH_RPC_URL,
	wallet: process.env.BCH_WALLET,
	rpcUser: process.env.BCH_RPC_USER,
	rpcPassword: process.env.BCH_RPC_PASSWORD,
	store: myStore,
	webhookUrl: process.env.BCH_WEBHOOK_URL,
	hmacSecret: process.env.BCH_HMAC_SECRET,
	requiredConfirmations: Number(process.env.BCH_REQUIRED_CONFIRMATIONS ?? 6),
	pollIntervalMs: Number(process.env.BCH_POLL_INTERVAL_MS ?? 30_000),
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
		msg: 'bitcoin cash indexer started',
		rpcUrl: process.env.BCH_RPC_URL,
		wallet: process.env.BCH_WALLET,
		webhookUrl: process.env.BCH_WEBHOOK_URL,
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
