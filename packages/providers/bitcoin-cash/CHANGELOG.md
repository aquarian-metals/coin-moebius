# @aquarian-metals/coin-moebius-bitcoin-cash

## 4.5.1

### Patch Changes

- **A short payment that is topped up now settles.** Once the indexer had reported an order as `partial`, it stopped looking at that order, so the rest of the money was never reported and the store was never told to deliver. It now keeps watching and reports `success` when the confirmed total reaches the invoice.
- **The server entry loads its key library only when the creator first hands out an address.** The library compiles its hashing and key code as WebAssembly the moment it is imported, and some JavaScript runtimes refuse WebAssembly compiled at run time, so a program that only verifies webhooks could not import the entry at all. The verifier and `computeBitcoinCashSignature` now load without it. A bad xpub is reported on the first checkout instead of when the creator is made.

## 4.5.0

### Minor Changes

- **New:** `@aquarian-metals/coin-moebius-bitcoin-cash`, the self-hosted Bitcoin Cash provider. No third-party gateway, no custodial keys. The merchant runs `bitcoind` and a small indexer; this package supplies the browser provider, the server-side creator (a fresh address per checkout, labeled with its payment id), the webhook verifier, and the indexer factory (`.tick()`, `.start()`, `.status()`).

  Talks to `bitcoind` over its JSON-RPC with HTTP Basic auth (`rpcUser` / `rpcPassword`, or the node's cookie). Settles on six confirmations by default, reports the payment as `pending` from the moment it reaches the network and then as its confirmations climb, never counts a conflicted transaction, and checks the node directly before failing an expired invoice so money that landed outside the lookback window is never reported missing.

  See `docs/self-hosted-bitcoin-cash.md` for the full self-hosting guide, including a regtest recipe, and `examples/static-site-demo/bitcoin-cash/` for a copy-paste deployment.
