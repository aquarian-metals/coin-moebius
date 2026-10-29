# @aquarian-metals/coin-moebius-bitcoin-cash

Self-hosted Bitcoin Cash provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**. No custodial third-party gateway, no API keys to a payment processor, no merchant-tax-form-collecting middleman. The merchant runs `bitcoind`, this package supplies everything else.

Two entries in one package:

- `@aquarian-metals/coin-moebius-bitcoin-cash` — **browser** entry. Modal-rendering provider that posts to your own checkout endpoint and shows the buyer a fresh Bitcoin Cash address, the exact amount, and a `bitcoincash:` link.
- `@aquarian-metals/coin-moebius-bitcoin-cash/server` — **server** entry. `createBitcoinCashCreator` (a fresh address per checkout, watched under its payment id), `createBitcoinCashVerifier` (validates indexer webhooks), `createBitcoinCashIndexer` (the long-running chain watcher). **Never import this from browser code.**

## Why a self-hosted Bitcoin Cash provider

Custodial gateways (Cryptomus, NOWPayments, BTCPay-as-a-service) ask you to trust them with your money, your KYC, and your geo-availability. Self-hosting Bitcoin Cash gives you:

- **No counterparty.** Funds land directly in a wallet you control. No "gateway froze our account" thread ends with your store.
- **No third-party API keys.** Nothing on a vendor's dashboard can be revoked from under you.
- **No geo limits.** Cryptomus is geo-blocked in the US; NOWPayments is fine but is a custodian. Self-hosted has no political surface.
- **No fee skim.** The only fee is the Bitcoin Cash network fee, which the buyer pays.

The trade-off is operational: you (or your VPS) run a Bitcoin Cash node. This package makes the wiring on top of that as small as possible.

## Install

```bash
npm install @aquarian-metals/coin-moebius-bitcoin-cash
```

The server entry uses Web Crypto (`crypto.subtle`) for HMAC and `fetch` for the node's JSON-RPC — works in Node 18+, Cloudflare Workers, Deno, and Bun. Addresses are derived with `@bitauth/libauth`, installed with the package.

## Use — browser

```ts
import { createBitcoinCashProvider } from '@aquarian-metals/coin-moebius-bitcoin-cash';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createBitcoinCashProvider({
      checkoutEndpoint: '/api/checkout/bitcoin-cash',
      statusEndpoint: '/api/payment-status',
    }),
  ],
});

document.getElementById('buy-with-bitcoin-cash')?.addEventListener('click', () => {
  payments.initiate({ productId: 'ebook-42', amount: 19.99, currency: 'USD' });
});
```

## Use — server (overview)

Three serverless functions / handlers, plus one long-running indexer:

1. `POST /api/checkout/bitcoin-cash` — the browser posts here; you call `createBitcoinCashCreator(...)` and return its result.
2. `POST /api/payment-webhook` — the **indexer** posts here; you call `verifierRegistry.verify(...)` and fulfill orders on `'success'`.
3. `GET /api/payment-status?paymentId=…` — the browser polls here; you return the current `PaymentRecord` from your store.
4. **The indexer process** — see "Running the indexer" below.

```js
// /api/checkout/bitcoin-cash
import { createBitcoinCashCreator } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { myProductionStore } from './store.js';

const create = createBitcoinCashCreator({
  rpcUrl: process.env.BCH_RPC_URL,
  wallet: 'shop',
  rpcUser: process.env.BCH_RPC_USER,
  rpcPassword: process.env.BCH_RPC_PASSWORD,
  xpub: process.env.BCH_XPUB,
  store: myProductionStore,
  bchPerUnit: async (currency) => {
    // You decide where prices come from — CoinGecko, Kraken ticker,
    // pinned constant. Coin Moebius does not call any oracle.
    return 1 / (await fetchBitcoinCashPriceFromMyOracle(currency));
  },
});

export default async (req) => {
  const { productId, metadata } = await req.json();
  // Price from your own catalog, never from the request: the browser is the
  // buyer's, and a buyer can send any amount they like.
  const price = await priceOf(productId);
  if (!price) return new Response('Unknown product', { status: 404 });
  return Response.json(await create({ productId, ...price, metadata }));
};
```

```js
// /api/payment-webhook
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createBitcoinCashVerifier } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';

const verifiers = createVerifierRegistry();
verifiers.register('bitcoin-cash', createBitcoinCashVerifier({ hmacSecret: process.env.BCH_HMAC_SECRET }).verify);

export default async (req) => {
  const result = await verifiers.verify(await req.text(), Object.fromEntries(req.headers));
  if (result?.status === 'success') {
    // Fulfill the order. This handler MUST be idempotent — like every
    // webhook receiver, you may get a duplicate.
  }
  return new Response('', { status: 200 });
};
```

## Running the indexer

The indexer is the long-running process that watches the node's wallet and converts on-chain events into webhook posts. **It must run inside the same private network as `bitcoind`.** It never accepts inbound network traffic; it only makes outbound calls to the node's RPC (private network) and to your webhook endpoint (HTTPS).

```js
// indexer.js
import { createBitcoinCashIndexer } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { myProductionStore } from './store.js';

const indexer = createBitcoinCashIndexer({
  rpcUrl: process.env.BCH_RPC_URL,
  wallet: 'shop',
  rpcUser: process.env.BCH_RPC_USER,
  rpcPassword: process.env.BCH_RPC_PASSWORD,
  store: myProductionStore,
  webhookUrl: process.env.BCH_WEBHOOK_URL,
  hmacSecret: process.env.BCH_HMAC_SECRET,
  requiredConfirmations: 6,
  pollIntervalMs: 30_000,
});

const stop = indexer.start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

## Why downtime is cheap

The indexer is **catch-up by design**. If it's offline for an hour, the next tick queries the node for the missed block range and emits the webhooks then. Buyers see a stale "pending" during the outage; nothing is lost, nothing requires manual reconciliation.

Compared to a hosted gateway, where downtime on the gateway's end means missed events and refund tickets, your operational SLA for self-hosted Bitcoin Cash is "eventually consistent within a few minutes." That's a much easier bar to meet than "five-nines uptime," and it's the property that makes self-hosting realistic for indie merchants who don't run an ops team.

## Node setup notes

The minimum the merchant needs running, in production:

```bash
# bitcoin.conf
server=1
prune=550
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcuser=shop
rpcpassword=<long random password>
```

```bash
# A watch-only wallet. It holds no keys; the creator adds each checkout's address to it.
bitcoin-cli -named createwallet wallet_name=shop disable_private_keys=true blank=true
```

The creator derives each checkout's address from the account-level extended public key (`m/44'/145'/0'`) your wallet shows, and has the node watch it with `importaddress`.

**Never expose the node's RPC to the public internet.** See [`docs/self-hosted-bitcoin-cash.md`](https://github.com/aquarian-metals/coin-moebius/blob/main/docs/self-hosted-bitcoin-cash.md) for the full walkthrough, including where the extended public key comes from, a regtest recipe for trying it without real money, and troubleshooting.

## Related

- For self-hosted Bitcoin, Monero, or Zano, see `@aquarian-metals/coin-moebius-bitcoin`, `@aquarian-metals/coin-moebius-monero`, and `@aquarian-metals/coin-moebius-zano`.
- For custodial crypto on a hosted gateway, see `@aquarian-metals/coin-moebius-nowpayments`.
- For fiat (Stripe), see `@aquarian-metals/coin-moebius-stripe`.
- For Goldbacks, cash, check, or barter, see `@aquarian-metals/coin-moebius-manual`.

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start, and `examples/static-site-demo/bitcoin-cash/` for a copy-paste deployment.

## License

MIT — see [LICENSE](./LICENSE).
