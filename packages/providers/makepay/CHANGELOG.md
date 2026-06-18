# @aquarian-metals/coin-moebius-makepay

## 4.1.0

### Minor Changes

- Initial release. Ships a MakePay crypto-payment provider — hosted checkout
  (payment links) with direct self-custody wallet settlement.

  **Client (`@aquarian-metals/coin-moebius-makepay`):**
  - `createMakepayProvider(config)` returns a `PaymentProvider` registered as
    `id: 'makepay'`. Fires `onPending` immediately, then navigates to MakePay's
    hosted checkout URL (`publicUrl`).

  **Server (`@aquarian-metals/coin-moebius-makepay/server`):**
  - `createMakepayVerifier({ webhookSecret })` verifies signed webhooks. Header
    `X-MakePay-Signature` carries `t=<unixSeconds>,v1=<hexSignature>`; the
    signature is hex HMAC-SHA256 over `` `${t}.${rawBody}` `` keyed by the
    webhook secret, with a 300-second replay window by default (matches
    MakePay's official SDK).
  - `computeMakepaySignature(timestamp, rawBody, secret)` and
    `parseMakepaySignatureHeader(header)` exported for callers that verify
    without the registry.
  - Normalizes both documented payloads: payment deliveries map from
    `session.status` (`complete` → `success`; the link's own `active`/`paused`
    status is its catalog lifecycle, not the payment state), and subscription
    deliveries map `active`/`paused`/`overdue`/`cancelled` onto the SDK's
    `SubscriptionEvent`. `success` is returned ONLY for `complete`, so an
    unconfirmed string can never trigger a false "paid".
  - Surfaces the `x-makepay-delivery-id` as `metadata.deliveryId` for
    exactly-once handling, and the merchant reference as
    `metadata.merchantOrderId`.
