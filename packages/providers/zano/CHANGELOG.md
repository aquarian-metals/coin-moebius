# @aquarian-metals/coin-moebius-zano

## Unreleased

### Minor Changes

- **New:** `@aquarian-metals/coin-moebius-zano`, the self-hosted Zano provider. No third-party gateway, no custodial keys. The merchant runs `zanod` + `simplewallet` in RPC mode and a small indexer; this package supplies the browser provider, the server-side creator (integrated addresses with a fresh payment id per checkout), the webhook verifier, and the indexer factory (`.tick()`, `.start()`, `.status()`).

  Pays in ZANO or in any Zano asset the merchant accepts. Freedom Dollar ships with its asset id exported as `FREEDOM_DOLLAR_ASSET_ID`; the asset's decimals are read from the merchant's own wallet at checkout, never from a table in this package. Money that arrives on a payment id in the wrong asset is reported on the webhook as `otherAssets` and never counted toward the invoice.

  Speaks the wallet's JWT auth: pass the value given to `simplewallet --jwt-secret` as `jwtSecret` and every call carries the one-time `Zano-Access-Token` header the wallet requires.

  See `docs/self-hosted-zano.md` for the full self-hosting guide and `examples/static-site-demo/zano/` for a copy-paste deployment.
