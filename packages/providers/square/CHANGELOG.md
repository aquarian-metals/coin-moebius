# @aquarian-metals/coin-moebius-square

## 0.8.0

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

## 2.0.0

### Minor Changes

- f31ec23: Initial release. Ships a Square (Block) provider against the Payment Link redirect flow + Webhooks signature scheme. The in-page Web Payments SDK and Cash App Pay variants are out of scope for v1 and may land later under separate subpath exports.

  **Client (`@aquarian-metals/coin-moebius-square`):**
  - `createSquareProvider({ sessionEndpoint })` returns a `PaymentProvider` registered as `id: 'square'`. Fires `onPending`, then navigates to the hosted checkout URL returned by the session endpoint (the `payment_link.url` value from `POST /v2/online-checkout/payment-links`).

  **Server (`@aquarian-metals/coin-moebius-square/server`):**
  - `createSquareVerifier({ signatureKey, notificationUrl })` verifies the `x-square-hmacsha256-signature` header. Square HMAC-SHA256s over `notificationUrl + rawBody` (concatenated, no separator) and base64-encodes the result. The `notificationUrl` field is required because Square includes the public URL in the signed payload, and workers behind a proxy or Cloudflare typically cannot recover that URL from the inbound request — the merchant passes it explicitly.
  - `computeSquareSignature(notificationUrl, rawBody, signatureKey)` exported for callers that want to verify with the same routine without going through the registry path.
  - Status mapping covers the 9 documented event paths: `payment.created` → `pending`; `payment.updated` with inner status `COMPLETED` → `success`, `APPROVED` → `pending`, `FAILED` / `CANCELED` → `failed`; `refund.created` → `pending`; `refund.updated` with inner status `COMPLETED` → `refunded`, `FAILED` / `REJECTED` → `failed`; `dispute.created` and `dispute.state.updated` → `disputed`. Other signed events return `null`.

  **Known gap:** Square's signature scheme has no timestamp, so the verifier cannot enforce a replay window. Applications sensitive to replays should deduplicate at the application layer using `event_id`. Documented in the README.

  **Currency:** read from `amount_money.currency` in the payload; minor-unit integer amounts are converted to major-unit decimals (`/100` for typical currencies). No mode flag — the scheme is identical in sandbox and production.

  **Bundle size:** browser entry ~1.5 KB minified before gzip (under the 4 KB budget).

### Patch Changes

- Updated dependencies [fb7c94e]
- Updated dependencies [6f28eef]
  - @aquarian-metals/coin-moebius-core@2.0.0
