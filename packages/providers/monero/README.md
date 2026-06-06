# @aquarian-metals/coin-moebius-monero

Self-hosted Monero provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**. No custodial third-party gateway, no API keys to a payment processor, no merchant-tax-form-collecting middleman. The merchant runs `monerod` + `monero-wallet-rpc`, this package supplies everything else.

Two entries in one package:

- `@aquarian-metals/coin-moebius-monero` — **browser** entry. Modal-rendering provider that posts to your own checkout endpoint and shows the buyer a Monero subaddress + amount + QR-friendly URI.
- `@aquarian-metals/coin-moebius-monero/server` — **Node-only** entry. `createMoneroCreator` (mints subaddresses), `createMoneroVerifier` (validates indexer webhooks), `createMoneroIndexer` (the long-running chain watcher). **Never import this from browser code.**

## Why a self-hosted Monero provider

Custodial gateways (Cryptomus, NOWPayments, BTCPay-as-a-service) ask you to trust them with your money, your KYC, and your geo-availability. Self-hosting Monero gives you:

- **No counterparty.** Funds land directly in a wallet you control. No "gateway froze our account" thread on r/Monero ends with your store.
- **No third-party API keys.** Nothing on a vendor's dashboard can be revoked from under you.
- **No geo limits.** Cryptomus is geo-blocked in the US; NOWPayments is fine but is a custodian. Self-hosted has no political surface.
- **No fee skim.** The only fee is the Monero network fee, which the buyer pays.

The trade-off is operational: you (or your VPS) run a Monero daemon and a wallet RPC. This package makes the wiring on top of that as small as possible.

## Install

```bash
npm install @aquarian-metals/coin-moebius-monero
```

The server entry uses Web Crypto (`crypto.subtle`) for HMAC — works in Node 18+, Cloudflare Workers, Deno, and Bun. No additional crypto dependency.

## Use — browser

```ts
import { createMoneroProvider } from '@aquarian-metals/coin-moebius-monero';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createMoneroProvider({
      checkoutEndpoint: '/api/checkout/monero',
      statusEndpoint: '/api/payment-status',
    }),
  ],
});

payments.onSuccess((result) => {
  // Fires when the indexer's webhook lands and the buyer's status poll
  // sees `status: 'success'`. Unlock the download, fire confetti, etc.
});

document.getElementById('buy-with-monero')?.addEventListener('click', () => {
  payments.initiate({ productId: 'ebook-42', amount: 0.1, currency: 'XMR' });
});
```

## Use — server (overview)

Three serverless functions / handlers, plus one long-running indexer:

1. `POST /api/checkout/monero` — the browser posts here; you call `createMoneroCreator(...)` and return its result.
2. `POST /api/payment-webhook` — the **indexer** posts here; you call `verifierRegistry.verify(...)` and fulfill orders on `'success'`.
3. `GET /api/payment-status?paymentId=…` — the browser polls here; you return the current `PaymentRecord` from your store.
4. **The indexer process** — see "Running the indexer" below.

```js
// /api/checkout/monero
import { createMoneroCreator } from '@aquarian-metals/coin-moebius-monero/server';
import { myProductionStore } from './store.js';

const create = createMoneroCreator({
  walletRpcUrl: process.env.MONERO_WALLET_RPC_URL,
  store: myProductionStore,
  xmrPerUnit: async (currency) => {
    if (currency === 'XMR') return 1;
    // You decide where prices come from — CoinGecko, Kraken ticker,
    // pinned constant. Coin Moebius does not call any oracle.
    return await fetchXmrPriceFromMyOracle(currency);
  },
});

export default async (req) => {
  const { productId, amount, currency, metadata } = await req.json();
  const instructions = await create({ productId, amount, currency, metadata });
  return Response.json(instructions);
};
```

```js
// /api/payment-webhook
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createMoneroVerifier } from '@aquarian-metals/coin-moebius-monero/server';

const verifiers = createVerifierRegistry();
verifiers.register(
  'monero',
  createMoneroVerifier({
    hmacSecret: process.env.MONERO_HMAC_SECRET,
  }).verify,
);

export default async (req) => {
  const result = await verifiers.verify(await req.text(), Object.fromEntries(req.headers));
  if (result?.status === 'success') {
    // Fulfill the order. This handler MUST be idempotent — like every
    // webhook receiver, you may get a duplicate (rare, but possible
    // under indexer restarts or HA configurations).
  }
  return new Response('', { status: 200 });
};
```

## Running the indexer

The indexer is the long-running process that watches `monero-wallet-rpc` and converts on-chain events into webhook posts. **It must run inside the same private network as `monero-wallet-rpc`** — same box for hobbyists, same VPC/tailnet for businesses, same cluster for tier-3 deployments. It never accepts inbound network traffic; it only makes outbound calls to wallet RPC (private network) and to your webhook endpoint (HTTPS).

The simplest entrypoint:

```js
// indexer.js
import { createMoneroIndexer } from '@aquarian-metals/coin-moebius-monero/server';
import { myProductionStore } from './store.js';

const indexer = createMoneroIndexer({
  walletRpcUrl: process.env.MONERO_WALLET_RPC_URL,
  store: myProductionStore,
  webhookUrl: process.env.MONERO_WEBHOOK_URL,
  hmacSecret: process.env.MONERO_HMAC_SECRET,
  requiredConfirmations: 10,
  pollIntervalMs: 30_000,
});

const stop = indexer.start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

Run it under your favorite process manager. For systemd, see the `examples/static-site-demo/monero/` folder; for Docker, ditto. The library deliberately does not ship a Docker image — that would make us responsible for `monerod` upgrades and CVEs.

### Push-mode with `--tx-notify`

For lower latency, hook the indexer up to `monero-wallet-rpc --tx-notify`:

```bash
monero-wallet-rpc \
  --wallet-file /var/lib/monero/view-only.wallet \
  --rpc-bind-port 18083 \
  --disable-rpc-login \
  --tx-notify "/usr/bin/node /opt/indexer/notify.js %s"
```

```js
// notify.js
import { createMoneroIndexer } from '@aquarian-metals/coin-moebius-monero/server';
import { myProductionStore } from './store.js';

const indexer = createMoneroIndexer({
  /* same config as above */
});
const txHash = process.argv[2];
await indexer.processTx(txHash);
```

`processTx` produces the webhook the same way `tick()` does. The `.start()` polling loop continues as the backstop that catches missed notifications and counts confirmations as they accumulate.

## Self-host tiers

The library is the same across tiers; only the deployment topology changes.

### Tier 1 — Solo developer / cypherpunk

One VPS, home server, or even a Pi. `monerod`, `monero-wallet-rpc`, and the indexer all on the same box. Outbound HTTPS to your webhook endpoint (which can be a Netlify/Cloudflare/Vercel function — same as your static site). Recipe: `node indexer.js` under systemd.

### Tier 2 — Small business

Private VPC (Hetzner Cloud, AWS, Fly private networking, Tailscale tailnet). `monerod` on a chain-storage node, `monero-wallet-rpc` on a small node, the indexer as a container in the same VPC. The indexer reaches wallet RPC over private DNS; webhooks go out to your existing serverless functions. Recipe: docker-compose with split services, or a Fly.io machines deployment.

### Tier 3 — Scale

Kubernetes (or equivalent). `monerod` as a StatefulSet with a persistent volume (~250GB for a pruned node). `monero-wallet-rpc` as a singleton Deployment (the wallet file is naturally singleton — two processes reading it will corrupt state). Indexer as a single-replica Deployment with liveness/readiness probes hitting `/health` (which exposes `indexer.status()`), structured logs to your observability stack, and **cold-spend separation** (view-only wallet on the hot box; spend key on a cold signer used only to sweep the receiving wallet periodically).

Tier-3 merchants should also implement `PaymentStore.markStatusAnnounced(...)` on their backing store so the indexer can run with multiple replicas without double-emitting webhooks. The in-memory reference implementation in `@aquarian-metals/coin-moebius-server` shows the contract.

## Why downtime is cheap

The indexer is **catch-up by design**. If it's offline for an hour, the next tick queries wallet RPC for the missed block range and emits the webhooks then. Buyers see a stale "pending" during the outage; nothing is lost, nothing requires manual reconciliation.

Compared to a hosted gateway, where downtime on the gateway's end means missed events and refund tickets, your operational SLA for self-hosted Monero is "eventually consistent within a few minutes." That's a much easier bar to meet than "five-nines uptime," and it's the property that makes self-hosting realistic for indie merchants who don't run an ops team.

## Wallet RPC setup notes

The minimum the merchant needs running, in production:

```bash
# Run a Monero daemon (or point at a remote one — receive flow only
# needs the daemon for sync; spend keys never have to be exposed).
monerod \
  --data-dir /var/lib/monero \
  --restricted-rpc \
  --prune-blockchain

# Run a wallet-rpc against a VIEW-ONLY wallet. The spend key stays on
# a cold box you sweep with periodically.
monero-wallet-rpc \
  --wallet-file /var/lib/monero/view-only.wallet \
  --password-file /var/lib/monero/wallet.password \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port 18083 \
  --disable-rpc-login \
  --daemon-address 127.0.0.1:18081
```

Bind wallet RPC to localhost (Tier 1) or to a private interface (Tier 2/3). **Never expose wallet RPC to the public internet.** If you need auth between the indexer and wallet RPC, put nginx in front with basic auth, or wrap your `fetcher` to perform HTTP Digest (wallet RPC's native auth scheme).

## Related

- For custodial crypto on a hosted gateway, see `@aquarian-metals/coin-moebius-nowpayments` (US-friendly) or `@aquarian-metals/coin-moebius-cryptomus` (outside US).
- For fiat (Stripe), see `@aquarian-metals/coin-moebius-stripe`.
- For Goldbacks, cash, check, or barter, see `@aquarian-metals/coin-moebius-manual`.

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start, and `examples/static-site-demo/monero/` for a copy-paste deployment.

## License

MIT — see [LICENSE](./LICENSE).
