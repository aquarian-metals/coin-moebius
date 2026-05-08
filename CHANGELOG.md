# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version line stays in `0.1.0-beta.x`, all six packages move in lockstep
and any release may break shape; pin a caret range like `^0.1.0-beta.1` so a
single bump rolls the whole family forward.

## [Unreleased]

## [0.1.0-beta.1] — 2026-05-08

Initial public beta. Six packages, all under the `@aquarian-metals/` scope, all
publishing under the `beta` dist-tag on npm.

### Added

- **`@aquarian-metals/coin-moebius-core`** — provider-agnostic payment manager
  (`createPaymentManager`), shared `PaymentProvider` / `PaymentResult` /
  `InitiateOptions` types, and a browser-side `subscribeToStatus` poller for
  delayed payments (Monero confirmations, etc.). Browser-safe — no Node imports.
- **`@aquarian-metals/coin-moebius`** — friendly install alias that re-exports
  the core. `npm install @aquarian-metals/coin-moebius` is the recommended
  one-liner.
- **`@aquarian-metals/coin-moebius-server`** — Node-only webhook dispatch
  (`registerVerifier` / `verify`), a `PaymentStore`-backed status subscriber,
  and a Supabase-backed `PaymentStore` reachable at the `./supabase` subpath.
- **`@aquarian-metals/coin-moebius-stripe`** — Stripe provider. Browser entry
  redirects to Stripe Checkout via a configurable `sessionEndpoint`. The
  `./server` subpath verifies webhooks using `webhooks.constructEventAsync`,
  which works on Node, Cloudflare Workers, Deno, and other edge runtimes.
  The Stripe SDK is an *optional* peer dependency, so browser bundles never
  pull in `node:crypto`.
- **`@aquarian-metals/coin-moebius-monero-cryptomus`** — Monero (via Cryptomus)
  provider. Browser entry posts to a configurable `createEndpoint` you control;
  the API key never ships to the browser. The `./server` subpath exposes
  `createCryptomusCreator` (signs + posts to Cryptomus) and
  `createCryptomusVerifier` (validates incoming webhooks). Both directions use
  the documented `md5(base64(jsonBody) + paymentApiKey)` signature scheme.
- **`@aquarian-metals/coin-moebius-provider-template`** — copy-and-rename
  starter for community providers. `coin-moebius-core` is declared as a peer
  dependency so the template's consumers install it once.

### Tested

- 43 Vitest unit tests across 8 suites cover the manager, status subscriber,
  webhook dispatch, both providers (client + server), and the full
  Cryptomus signature round-trip (creator → verifier).
- GitHub Actions CI (`.github/workflows/ci.yml`) runs the suite on Node 20 and
  22 against every PR and push to `main`.

### Released via

- GitHub Actions release workflow (`.github/workflows/release.yml`) triggered
  on `v*` git tags. Publishes packages in dependency order with npm provenance
  enabled; prerelease versions ship under `beta`, stable versions under
  `latest`.
