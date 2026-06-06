# @aquarian-metals/coin-moebius-authorizenet

## 0.8.0

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

## 2.0.0

### Minor Changes

- f31ec23: Initial release. Ships an Authorize.Net provider against the current Accept Hosted + Webhooks surface (the deprecated SIM integration is not used; the in-page Accept.js flow is deferred to a future subpath export).

  **Client (`@aquarian-metals/coin-moebius-authorizenet`):**
  - `createAuthorizenetProvider({ sessionEndpoint, fetcher?, submitForm? })` returns a `PaymentProvider` registered as `id: 'authorizenet'`. Fires `onPending`, then form-POSTs the hosted-form token to Authorize.Net's Accept Hosted endpoint. Unlike the GET-redirect providers, the session endpoint must return `{ url, token }` (and optionally `paymentId`); the provider builds a hidden form and submits it. From the consumer's perspective the flow is identical to other providers — same `PaymentProvider` contract, same `onPending` / `onSuccess` / `onError` semantics — only the navigation mechanic differs.

  **Server (`@aquarian-metals/coin-moebius-authorizenet/server`):**
  - `createAuthorizenetVerifier({ signatureKey })` verifies HMAC-SHA512 webhook signatures. Header `X-ANET-Signature` (case-insensitive lookup); accepts both the documented `sha512=<hex>` form and the bare hex form; compares hex case-insensitively.
  - `computeAuthorizenetSignature(rawBody, signatureKey)` exported for callers that want to verify with the same routine without going through the registry path.
  - Signature Key (distinct from the Transaction Key) is generated in the Merchant Interface under Account → Settings → Security Settings.
  - Status mapping covers all nine documented event types: `authorization.created` and `fraud.held` → `pending`; `authcapture.created` / `capture.created` / `priorAuthCapture.created` / `fraud.approved` → `success`; `refund.created` → `refunded`; `void.created` / `fraud.declined` → `failed`. Other recognized events return `null` (signature still verified).

  **Currency posture:** Authorize.Net's webhook payloads do not carry a currency field. The verifier returns `'USD'` by default to reflect the most common US-account case; non-USD merchants can override via metadata or by reading `raw`.

  **Bundle size:** browser entry ~1.5 KB minified before gzip (under the 4 KB budget).

### Patch Changes

- Updated dependencies [fb7c94e]
- Updated dependencies [6f28eef]
  - @aquarian-metals/coin-moebius-core@2.0.0
