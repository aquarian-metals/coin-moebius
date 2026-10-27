# @aquarian-metals/coin-moebius-bitcoin

## 4.4.1

### Patch Changes

- **Never settles an order whose stored amount is missing.** A missing `atomicAmount` used to read as zero, so any payment counted as paid in full. The indexer now refuses and reports why.
- **A confirmed, full payment settles even while another output to the same address is unconfirmed.** One unconfirmed output can no longer hold a paid order open.
- **The verifier refuses a message whose `provider` is not `bitcoin`**, so a secret reused across indexers cannot pass another provider's message off as a Bitcoin payment.
- **Node calls and webhook deliveries time out after 30 seconds** (`requestTimeoutMs`).
- **Webhooks name the product** (`productId` on the payload and on the event's metadata).

## 4.4.0

### Minor Changes

- **New:** `@aquarian-metals/coin-moebius-bitcoin`, the self-hosted Bitcoin provider. No third-party gateway, no custodial keys. The merchant runs `bitcoind` and a small indexer; this package supplies the browser provider, the server-side creator (a fresh address per checkout, labeled with its payment id), the webhook verifier, and the indexer factory (`.tick()`, `.start()`, `.status()`).

  Talks to `bitcoind` over its JSON-RPC with HTTP Basic auth (`rpcUser` / `rpcPassword`, or the node's cookie). Settles on one confirmation by default, reports confirmation progress as `pending` webhooks, never counts a conflicted transaction, and checks the node directly before failing an expired invoice so money that landed outside the lookback window is never reported missing.

  See `docs/self-hosted-bitcoin.md` for the full self-hosting guide, including a regtest recipe, and `examples/static-site-demo/bitcoin/` for a copy-paste deployment.
