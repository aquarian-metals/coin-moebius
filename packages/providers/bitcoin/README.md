# @aquarian-metals/coin-moebius-bitcoin

Self-hosted Bitcoin provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**. No custodial third-party gateway, no API keys to a payment processor. The merchant runs Bitcoin Core with a watch-only wallet, and this package supplies everything else.

Two entries in one package:

- `@aquarian-metals/coin-moebius-bitcoin` — **browser** entry. Modal-rendering provider that posts to your own checkout endpoint and shows the buyer a fresh Bitcoin address, the exact amount, and a `bitcoin:` link.
- `@aquarian-metals/coin-moebius-bitcoin/server` — **server** entry. `createBitcoinCreator` (mints a labeled address per checkout), `createBitcoinVerifier` (validates indexer webhooks), `createBitcoinIndexer` (the long-running chain watcher). **Never import this from browser code.**

## Why a self-hosted Bitcoin provider

- **No counterparty.** Funds land directly in a wallet you control.
- **No third-party API keys.** Nothing on a vendor's dashboard can be revoked from under you.
- **No spending keys on the server.** The node holds a watch-only wallet made from your public key. It can hand out addresses and see payments, and it cannot spend.
- **No fee skim.** The only fee is the Bitcoin network fee, which the buyer pays.

The trade-off is operational: you (or your VPS) run Bitcoin Core. A pruned node is enough, because the shop wallet only ever looks at new payments.

## Install

```bash
npm install @aquarian-metals/coin-moebius-bitcoin
```

The server entry uses Web Crypto (`crypto.subtle`) for HMAC and `fetch` for the node's JSON-RPC — works in Node 18+, Cloudflare Workers, Deno, and Bun. No additional dependency.

## Use — browser

```ts
import { createBitcoinProvider } from '@aquarian-metals/coin-moebius-bitcoin';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createBitcoinProvider({
      checkoutEndpoint: '/api/checkout/bitcoin',
      statusEndpoint: '/api/payment-status',
    }),
  ],
});

document.getElementById('buy-with-bitcoin')?.addEventListener('click', () => {
  payments.initiate({ productId: 'ebook-42', amount: 19.99, currency: 'USD' });
});
```

## Use — server (overview)

Three serverless functions / handlers, plus one long-running indexer:

1. `POST /api/checkout/bitcoin` — the browser posts here; you call `createBitcoinCreator(...)` and return its result.
2. `POST /api/payment-webhook` — the **indexer** posts here; you call `verifierRegistry.verify(...)` and fulfill orders on `'success'`.
3. `GET /api/payment-status?paymentId=…` — the browser polls here; you return the current `PaymentRecord` from your store.
4. **The indexer process** — see "Running the indexer" below.

```js
// /api/checkout/bitcoin
import { createBitcoinCreator } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myProductionStore } from './store.js';

const create = createBitcoinCreator({
  rpcUrl: process.env.BITCOIN_RPC_URL,
  wallet: 'shop',
  rpcUser: process.env.BITCOIN_RPC_USER,
  rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
  store: myProductionStore,
  btcPerUnit: async (currency) => {
    // You decide where prices come from — CoinGecko, Kraken ticker,
    // pinned constant. Coin Moebius does not call any oracle.
    return 1 / (await fetchBitcoinPriceFromMyOracle(currency));
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
import { createBitcoinVerifier } from '@aquarian-metals/coin-moebius-bitcoin/server';

const verifiers = createVerifierRegistry();
verifiers.register('bitcoin', createBitcoinVerifier({ hmacSecret: process.env.BITCOIN_HMAC_SECRET }).verify);

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
import { createBitcoinIndexer } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myProductionStore } from './store.js';

const indexer = createBitcoinIndexer({
  rpcUrl: process.env.BITCOIN_RPC_URL,
  wallet: 'shop',
  rpcUser: process.env.BITCOIN_RPC_USER,
  rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
  store: myProductionStore,
  webhookUrl: process.env.BITCOIN_WEBHOOK_URL,
  hmacSecret: process.env.BITCOIN_HMAC_SECRET,
  requiredConfirmations: 1,
  pollIntervalMs: 30_000,
});

const stop = indexer.start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

How it decides:

- **Matching.** Every checkout's address is labeled with its payment id in the wallet. The indexer reads the wallet's incoming transactions with `listsinceblock` and groups them by label.
- **Confirmations** come from the node, so a block that is reorganized away lowers the count. A transaction the node reports as conflicted (double-spent) is never counted. One confirmation settles by default; raise `requiredConfirmations` for bigger sales.
- **Progress.** While a payment waits for its block, the indexer posts `status: 'pending'` webhooks as the confirmation count moves, so a checkout can show it.
- **Catch-up.** Each tick looks back `requiredConfirmations + scanLookbackBlocks` blocks (144 extra by default, about a day), so an indexer that was offline sends what it missed when it returns.
- **Expiry.** When the store implements `listPending`, unpaid invoices past `expiresAt` are announced `failed`, after one last `getreceivedbyaddress` check confirms nothing ever reached the address. A late payment on a failed invoice still settles.

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
# A watch-only wallet holding only your public descriptor.
bitcoin-cli -named createwallet wallet_name=shop disable_private_keys=true blank=true load_on_startup=true
bitcoin-cli -rpcwallet=shop importdescriptors '[{"desc":"wpkh([…]xpub…/0/*)#…","active":true,"range":[0,999],"timestamp":"now"}]'
```

**Never expose the node's RPC to the public internet.** See [`docs/self-hosted-bitcoin.md`](https://github.com/aquarian-metals/coin-moebius/blob/main/docs/self-hosted-bitcoin.md) for the full walkthrough, including where the descriptor comes from, a regtest recipe for trying it without real money, and troubleshooting.

## Related

- For self-hosted Monero or Zano, see `@aquarian-metals/coin-moebius-monero` and `@aquarian-metals/coin-moebius-zano`.
- For custodial crypto on a hosted gateway, see `@aquarian-metals/coin-moebius-nowpayments`.
- For fiat (Stripe), see `@aquarian-metals/coin-moebius-stripe`.
- For Goldbacks, cash, check, or barter, see `@aquarian-metals/coin-moebius-manual`.

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start, and `examples/static-site-demo/bitcoin/` for a copy-paste deployment.

## License

MIT — see [LICENSE](./LICENSE).
