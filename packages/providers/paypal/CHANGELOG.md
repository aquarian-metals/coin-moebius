# @aquarian-metals/coin-moebius-paypal

## 0.8.0

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

## 2.0.0

### Minor Changes

- f31ec23: Initial release. Ships a PayPal provider against the current Orders v2 + Webhooks REST surface (legacy Express Checkout, Braintree, and the archived `@paypal/checkout-server-sdk` are not used).

  **Client (`@aquarian-metals/coin-moebius-paypal`):**
  - `createPaypalProvider({ sessionEndpoint })` returns a `PaymentProvider` registered as `id: 'paypal'`. Fires `onPending` immediately, then navigates to the PayPal-hosted approval URL returned by the session endpoint.

  **Server (`@aquarian-metals/coin-moebius-paypal/server`) — two verifier implementations of the same contract:**
  - `createPaypalVerifier({ clientId, clientSecret, webhookId, mode, tokenCache? })` — REST-endpoint verifier. POSTs to PayPal's `/v1/notifications/verify-webhook-signature` with the transmission fields and parsed event body. OAuth tokens cached for the returned `expires_in` (typically 9 hours) so steady-state is one verify call per webhook. Default choice for most callers.
  - `createPaypalManualVerifier({ webhookId, mode, certCache? })` — local verifier. Computes the canonical signed payload (`transmissionId|transmissionTime|webhookId|crc32(body)`), fetches PayPal's signing cert (cached), extracts the SubjectPublicKeyInfo via a minimal ASN.1 walk, and verifies the RSA-SHA256 signature via Web Crypto. Safe by default: refuses any `paypal-cert-url` whose origin is not the mode-appropriate PayPal host before any fetch occurs, so a forged cert URL cannot trick the verifier.
  - `crc32` exported for callers that want to compute the body checksum the same way.

  **Mode flag:** `'live'` (default) → `api-m.paypal.com` for REST and `api.paypal.com` for cert hosts; `'sandbox'` → `api-m.sandbox.paypal.com` and `api.sandbox.paypal.com`.

  **Status mapping:** `CHECKOUT.ORDER.APPROVED` → `pending`; `PAYMENT.CAPTURE.COMPLETED` → `success`; `PAYMENT.CAPTURE.DENIED` / `PAYMENT.CAPTURE.DECLINED` → `failed`; `PAYMENT.CAPTURE.REFUNDED` / `PAYMENT.CAPTURE.REVERSED` → `refunded`; `CUSTOMER.DISPUTE.CREATED` → `disputed`; `CUSTOMER.DISPUTE.RESOLVED` and unrecognized events → `null` (signature still verified). `paymentId` prefers the underlying order id from `supplementary_data.related_ids.order_id` so capture, refund, and dispute events on the same order share a stable id.

  **Scope notes:** one-off Orders v2 only. PayPal subscriptions / billing agreements and the PayPal Buttons JS SDK are out of scope; if the buttons SDK is wanted later, it will land under a separate subpath export.

  **Bundle size:** browser entry ~1.5 KB minified before gzip (well under the 4 KB budget).

### Patch Changes

- Updated dependencies [fb7c94e]
- Updated dependencies [6f28eef]
  - @aquarian-metals/coin-moebius-core@2.0.0
