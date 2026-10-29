# @aquarian-metals/coin-moebius-bitcoin-cash

## Unreleased

### Minor Changes

- **New:** `@aquarian-metals/coin-moebius-bitcoin-cash`, the self-hosted Bitcoin Cash provider. No third-party gateway, no custodial keys. The merchant runs `bitcoind` and a small indexer; this package supplies the browser provider, the server-side creator (a fresh address per checkout, labeled with its payment id), the webhook verifier, and the indexer factory (`.tick()`, `.start()`, `.status()`).

  Talks to `bitcoind` over its JSON-RPC with HTTP Basic auth (`rpcUser` / `rpcPassword`, or the node's cookie). Settles on six confirmations by default, reports the payment as `pending` from the moment it reaches the network and then as its confirmations climb, never counts a conflicted transaction, and checks the node directly before failing an expired invoice so money that landed outside the lookback window is never reported missing.

  See `docs/self-hosted-bitcoin-cash.md` for the full self-hosting guide, including a regtest recipe, and `examples/static-site-demo/bitcoin-cash/` for a copy-paste deployment.
