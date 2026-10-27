# @aquarian-metals/coin-moebius-bitcoin

## 4.4.0

### Minor Changes

- **New:** `@aquarian-metals/coin-moebius-bitcoin`, the self-hosted Bitcoin provider. No third-party gateway, no custodial keys. The merchant runs `bitcoind` and a small indexer; this package supplies the browser provider, the server-side creator (a fresh address per checkout, labeled with its payment id), the webhook verifier, and the indexer factory (`.tick()`, `.start()`, `.status()`).

  Talks to `bitcoind` over its JSON-RPC with HTTP Basic auth (`rpcUser` / `rpcPassword`, or the node's cookie). Settles on one confirmation by default, reports confirmation progress as `pending` webhooks, never counts a conflicted transaction, and checks the node directly before failing an expired invoice so money that landed outside the lookback window is never reported missing.

  See `docs/self-hosted-bitcoin.md` for the full self-hosting guide, including a regtest recipe, and `examples/static-site-demo/bitcoin/` for a copy-paste deployment.
