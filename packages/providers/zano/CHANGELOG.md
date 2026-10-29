# @aquarian-metals/coin-moebius-zano

## 4.5.0

### Patch Changes

- **Never settles an order whose stored amount is missing.** A missing `atomicAmount` used to read as zero, so any payment counted as paid in full. The indexer now refuses and reports why. A whole-number `atomicAmount` handed back by a store as a number is read as the same amount.
- **A confirmed, full payment settles even while another transfer to the same invoice is unconfirmed.** One unconfirmed transfer can no longer hold a paid order open; a short payment still waits for every transfer before it is called `partial`.
- **The verifier refuses a message whose `provider` is not `zano`**, so a secret reused across indexers cannot pass another provider's message off as a Zano payment.
- **Wallet calls and webhook deliveries time out after 30 seconds** (`requestTimeoutMs`).
- **Checkout metadata can no longer seed the fields the indexer owns** (`confirmations`, `txHash`, `receivedAtomic`), which silenced the progress webhooks.
- **A late payment on an expired invoice settles even when the store cannot claim announcements.** The fallback only let a `pending` invoice through.
- **The invoice amount on the settle and late-payment webhooks comes from the stored invoice**, so a handler that overwrote the order with a `failed` event no longer zeroes it.
- **An invoice whose money landed outside the lookback window is never failed.** Before failing it, the indexer asks the wallet for that payment id's payments; money found there keeps the invoice open and logs a warning to raise the lookback.
- **Webhooks name the product** (`productId` on the payload).
- **Checkout metadata can no longer seed `otherAssets`** along with the other indexer-owned fields.
- **The README's checkout code takes the price from your own product list, never from the request.**

## 4.2.0

### Minor Changes

- **New:** `@aquarian-metals/coin-moebius-zano`, the self-hosted Zano provider. No third-party gateway, no custodial keys. The merchant runs `zanod` + `simplewallet` in RPC mode and a small indexer; this package supplies the browser provider, the server-side creator (integrated addresses with a fresh payment id per checkout), the webhook verifier, and the indexer factory (`.tick()`, `.start()`, `.status()`).

  Pays in ZANO or in any Zano asset the merchant accepts. Freedom Dollar ships with its asset id exported as `FREEDOM_DOLLAR_ASSET_ID`; the asset's decimals are read from the merchant's own wallet at checkout, never from a table in this package. Money that arrives on a payment id in the wrong asset is reported on the webhook as `otherAssets` and never counted toward the invoice.

  Speaks the wallet's JWT auth: pass the value given to `simplewallet --jwt-secret` as `jwtSecret` and every call carries the one-time `Zano-Access-Token` header the wallet requires.

  See `docs/self-hosted-zano.md` for the full self-hosting guide and `examples/static-site-demo/zano/` for a copy-paste deployment.
