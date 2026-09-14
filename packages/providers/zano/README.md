# @aquarian-metals/coin-moebius-zano

Self-hosted Zano provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**. No custodial gateway, no API keys to a payment processor, no middleman. The merchant runs `zanod` + `simplewallet`, this package supplies everything else. Takes ZANO and any Zano asset the merchant accepts, Freedom Dollar (fUSD) included.

Two entries in one package:

- `@aquarian-metals/coin-moebius-zano`: **browser** entry. Modal-rendering provider that posts to your own checkout endpoint and shows the buyer an integrated address, the exact amount, the asset, and a `zano:` link.
- `@aquarian-metals/coin-moebius-zano/server`: **Node-only** entry. `createZanoCreator` (mints integrated addresses), `createZanoVerifier` (validates indexer webhooks), `createZanoIndexer` (the long-running wallet watcher). **Never import this from browser code.**

The full self-hosting walkthrough, from a bare box to a confirmed payment, is in [`docs/self-hosted-zano.md`](https://github.com/aquarian-metals/coin-moebius/blob/main/docs/self-hosted-zano.md). This README covers the package surface.

## Why a self-hosted Zano provider

- **No counterparty.** Funds land in a wallet you control.
- **Stablecoin payments with no processor.** Freedom Dollar is a stablecoin on Zano. A buyer pays 19.99 fUSD, you receive 19.99 fUSD, and nobody in between can freeze it.
- **No third-party API keys.** Nothing on a vendor's dashboard can be revoked from under you.
- **No fee skim.** The only fee is the network fee, which the buyer pays.

The trade-off is operational: you (or your VPS) run a Zano node and a wallet in RPC mode. This package makes the wiring on top of that as small as possible.

## Install

```bash
npm install @aquarian-metals/coin-moebius-zano
```

The server entry uses Web Crypto (`crypto.subtle`) for HMAC and for the wallet's JWT auth. Works in Node 18+, Cloudflare Workers, Deno, and Bun. No additional crypto dependency.

## Use: browser

One provider instance pays in one asset. Register a second instance with its own `id` to offer a second asset.

```ts
import { createZanoProvider, FREEDOM_DOLLAR_ASSET_ID } from '@aquarian-metals/coin-moebius-zano';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createZanoProvider({
      checkoutEndpoint: '/api/checkout/zano',
      statusEndpoint: '/api/payment-status',
    }),
    createZanoProvider({
      id: 'fusd',
      name: 'Freedom Dollar',
      assetId: FREEDOM_DOLLAR_ASSET_ID,
      checkoutEndpoint: '/api/checkout/zano',
      statusEndpoint: '/api/payment-status',
    }),
  ],
});

payments.onSuccess((result) => {
  // Fires when the indexer's webhook lands and the buyer's status poll
  // sees `status: 'success'`. Unlock the download, fire confetti, etc.
});

document.getElementById('buy-with-zano')?.addEventListener('click', () => {
  payments.initiate({ providerId: 'zano', productId: 'ebook-42', amount: 19.99, currency: 'USD' });
});

document.getElementById('buy-with-fusd')?.addEventListener('click', () => {
  payments.initiate({ providerId: 'fusd', productId: 'ebook-42', amount: 19.99, currency: 'USD' });
});
```

The browser POSTs `{ productId, amount, currency, assetId?, metadata }` to your checkout endpoint. `assetId` is present only on an instance that pinned one.

## Use: server (overview)

Three serverless functions / handlers, plus one long-running indexer:

1. `POST /api/checkout/zano`: the browser posts here; you call `createZanoCreator(...)` and return its result.
2. `POST /api/payment-webhook`: the **indexer** posts here; you call `verifierRegistry.verify(...)` and fulfill orders on `'success'`.
3. `GET /api/payment-status?paymentId=…`: the browser polls here; you return the current `PaymentRecord` from your store.
4. **The indexer process**: see "Running the indexer" below.

```js
// /api/checkout/zano
import { createZanoCreator, FREEDOM_DOLLAR_ASSET_ID } from '@aquarian-metals/coin-moebius-zano/server';
import { myProductionStore } from './store.js';

const create = createZanoCreator({
  walletRpcUrl: process.env.ZANO_WALLET_RPC_URL,
  jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
  store: myProductionStore,
  rate: async (currency, asset) => {
    // Units of `asset` per one unit of `currency`. Not called when the
    // invoice currency already is the asset (ZANO in ZANO, FUSD in fUSD).
    if (asset.assetId === FREEDOM_DOLLAR_ASSET_ID && currency === 'USD') return 1;
    // ZANO floats. You decide where the price comes from: CoinGecko,
    // an exchange ticker, a pinned constant. Coin Moebius calls no oracle.
    return 1 / (await fetchZanoPriceFromMyOracle(currency));
  },
});

export default async (req) => {
  const { productId, amount, currency, assetId, metadata } = await req.json();
  const instructions = await create({ productId, amount, currency, assetId, metadata });
  return Response.json(instructions);
};
```

```js
// /api/payment-webhook
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createZanoVerifier } from '@aquarian-metals/coin-moebius-zano/server';

const verifiers = createVerifierRegistry();
verifiers.register('zano', createZanoVerifier({ hmacSecret: process.env.ZANO_HMAC_SECRET }).verify);

export default async (req) => {
  const result = await verifiers.verify(await req.text(), Object.fromEntries(req.headers));
  if (result?.status === 'success') {
    // Fulfill the order. This handler MUST be idempotent, like every
    // webhook receiver: a duplicate can arrive under indexer restarts.
  }
  return new Response('', { status: 200 });
};
```

## How a payment is matched

Every checkout gets a fresh 8-byte payment id, folded into an **integrated address** by the merchant's own wallet (`make_integrated_address`). The buyer pastes one thing. When the payment lands, the wallet reports it under that payment id in `get_recent_txs_and_info3`, grouped by asset, so the indexer knows both **which order** and **which asset** without any bookkeeping of its own.

Only money in the invoiced asset counts. ZANO sent to a Freedom Dollar invoice is never credited, because one Zano address takes every asset and a wallet that ignores the link's `asset_id` falls back to ZANO.

Wrong-asset money on its own sends no webhook — the indexer logs a warning and the invoice stays open, since nothing has settled. It is named under `otherAssets` on the next webhook that invoice does send, so you see it once the invoiced asset arrives too. Watch the logger for `payment received in an asset that was not invoiced` if you want to know at the time.

A payment settles at `requiredConfirmations` (default 10, which is what Zano's own integration guide asks for; blocks are a minute apart). While it gathers confirmations the indexer posts `status: 'pending'` webhooks with the count, once per change, so a checkout can show "3 of 10".

## Running the indexer

The indexer is the long-running process that watches `simplewallet` and converts payments into webhook posts. **It must run inside the same private network as the wallet RPC**: same box for hobbyists, same VPC or tailnet for businesses. It never accepts inbound traffic; it only makes outbound calls to the wallet RPC (private network) and to your webhook endpoint (HTTPS).

```js
// indexer.js
import { createZanoIndexer } from '@aquarian-metals/coin-moebius-zano/server';
import { myProductionStore } from './store.js';

const indexer = createZanoIndexer({
  walletRpcUrl: process.env.ZANO_WALLET_RPC_URL,
  jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
  store: myProductionStore,
  webhookUrl: process.env.ZANO_WEBHOOK_URL,
  hmacSecret: process.env.ZANO_HMAC_SECRET,
  requiredConfirmations: 10,
  pollIntervalMs: 30_000,
});

const stop = indexer.start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

Run it under your favorite process manager. For systemd and Docker, see `examples/static-site-demo/zano/`. The library deliberately does not ship a Docker image; that would make us responsible for Zano upgrades and CVEs.

Zano's wallet has no push hook, so polling is the whole mechanism. The indexer is **catch-up by design**: if it is offline for a stretch, the next tick reads everything it missed inside its lookback window and emits the webhooks then.

### Expiring unpaid invoices

A Zano wallet keeps no record of the payment ids it hands out, so your store is the only list of open invoices. Implement the optional `listPending(provider)` method on your `PaymentStore` and the indexer announces unpaid invoices `failed` once they pass `expiresAt`. Without it, paid invoices still settle normally; an invoice nobody pays simply stays `pending`. The in-memory reference store implements it.

## Wallet RPC auth

Zano's wallet RPC refuses to start without authentication unless you pass `--unsecure-no-auth`. Start it with `--jwt-secret <secret>` instead and hand the same value to the creator and the indexer as `jwtSecret`. Every call then carries the one-time `Zano-Access-Token` the wallet checks (an HS256 JWT over the request body's SHA-256, a random salt, and a one-minute expiry). `zanoAccessToken(body, secret)` is exported for custom transports.

## Freedom Dollar

`FREEDOM_DOLLAR_ASSET_ID` is exported from both entries. The asset's decimals (4) and ticker are read from your wallet at checkout through `assets_whitelist_add`, which is also what makes the wallet report incoming fUSD at all. The whitelist is stored with the wallet file and resets on a resync, so the creator re-adds the asset on every checkout; the call is a cheap no-op once it is known.

Any other Zano asset works the same way: pass its `asset_id`. Nothing in this package needs a code change for a new asset.

## Related

- Self-hosting guide: [`docs/self-hosted-zano.md`](https://github.com/aquarian-metals/coin-moebius/blob/main/docs/self-hosted-zano.md).
- For self-hosted Monero, see `@aquarian-metals/coin-moebius-monero`.
- For custodial crypto on a hosted gateway, see `@aquarian-metals/coin-moebius-nowpayments` or `@aquarian-metals/coin-moebius-cryptomus`.

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start, and `examples/static-site-demo/zano/` for a copy-paste deployment.

## License

MIT, see [LICENSE](./LICENSE).
