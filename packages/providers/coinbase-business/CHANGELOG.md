# @aquarian-metals/coin-moebius-coinbase-business

## 0.8.0

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

## 2.0.0

### Minor Changes

- f31ec23: Initial release. Ships a Coinbase Business provider targeting the current Checkout API surface (Coinbase Commerce was sunset for new merchants on 2026-03-31; the legacy `coinbase-commerce-node` SDK is unsupported).

  **Client (`@aquarian-metals/coin-moebius-coinbase-business`):**
  - `createCoinbaseBusinessProvider({ sessionEndpoint })` returns a `PaymentProvider` registered as `id: 'coinbase-business'`. Fires `onPending` immediately, then navigates to the `hosted_url` returned by the session endpoint.

  **Server (`@aquarian-metals/coin-moebius-coinbase-business/server`):**
  - `createCoinbaseBusinessVerifier({ webhookSecret, maxAgeSeconds?, now? })` verifies Hook0 v1 webhook deliveries (header `x-hook0-signature`, HMAC-SHA256 over `${t}.${h}.${headerValues.join('.')}.${rawBody}`, hex-encoded — matches Coinbase Business's webhook delivery via Hook0).
  - `computeCoinbaseBusinessSignature(t, headerNames, headerValues, rawBody, secret)` and `parseHook0Signature(header)` exported for callers that want to verify or inspect signatures without going through the full registry path.
  - Replay-window guard defaults to 300 seconds (Hook0's documented default); override with `maxAgeSeconds` for fixture testing.
  - Status mapping: `checkout.payment.success` → `success`; `checkout.payment.failed` / `checkout.payment.expired` → `failed`; other recognized events → `null` (skipped, but signature still verified). Coinbase Business does not emit an in-flight `pending` event.

  **Subscription (`@aquarian-metals/coin-moebius-coinbase-business/subscription`):**
  - `createCoinbaseBusinessSubscription({ cdpKeyId, cdpPrivateKeyPem, mode? })` exposes a `subscribe({ callbackUrl, eventTypes? })` method that creates the webhook subscription via the CDP API. The signing secret is returned only on the create response and must be persisted by the caller; Coinbase does not surface it later.
  - `signCdpJwt({ keyId, privateKeyPem, method, url })` is exported for callers that need the same JWT for other CDP endpoints. ES256 (ECDSA P-256 + SHA-256) via Web Crypto, edge-runtime safe.

  **Geography:** Coinbase Business supports US and Singapore merchants only at this time. Merchants outside those jurisdictions cannot use this provider until Coinbase expands eligibility.

  **Bundle size:** browser entry ~1.5 KB minified before gzip (under the 4 KB budget).

### Patch Changes

- Updated dependencies [fb7c94e]
- Updated dependencies [6f28eef]
  - @aquarian-metals/coin-moebius-core@2.0.0
