# @aquarian-metals/coin-moebius-nowpayments

## 0.3.0

### Minor Changes

- Initial release. Ships a NOWPayments crypto-payment provider as a US-friendly alternative to `@aquarian-metals/coin-moebius-cryptomus` (Cryptomus's API is geo-blocked in the US).

  **Client (`@aquarian-metals/coin-moebius-nowpayments`):**
  - `createNowPaymentsCreator(config)` returns a `PaymentProvider` registered as `id: 'nowpayments'`. Fires `onPending` immediately, then navigates to the hosted invoice URL.

  **Server (`@aquarian-metals/coin-moebius-nowpayments/server`):**
  - `createNowPaymentsVerifier({ ipnSecret })` verifies IPN webhooks (header `x-nowpayments-sig`, HMAC-SHA512 over recursively-sorted JSON, hex-encoded — matches NOWPayments' canonical reference implementation).
  - `computeNowPaymentsSignature(payload, ipnSecret)` exported for callers that want to verify the same way without going through the full registry path.
  - Status mapping: `finished` → `success`; `failed / refunded / expired` → `failed`; everything else (`waiting / confirming / confirmed / sending / partially_paid`) → `pending`.

  **Bundle size:** ~3 KB brotlied (well under the 3 KB budget).

  Cryptomus stays published for non-US SDK consumers; the two packages are interchangeable in customer-facing dashboards.
