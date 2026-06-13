# @aquarian-metals/coin-moebius-dodopayments

## 4.1.0

### Minor Changes

- Add `createDodoSubscriptionCheckout` to the server entry
  (`@aquarian-metals/coin-moebius-dodopayments/server`). It creates a Dodo-hosted
  Checkout Session for a subscription against a pre-built recurring Dodo product
  and returns the hosted `checkout_url` and `sessionId`. The buyer is anonymous —
  Dodo's hosted page collects their details — and the subscription auto-renews
  (no `on_demand` mandate), so Dodo charges each period itself. Buyers self-manage
  (cancel, update card) through the Customer Portal via the existing
  `getDodoPortalUrl`.

## 1.0.0

### Minor Changes

- Add the Dodo Payments provider.

  Dodo Payments is a Merchant of Record that hosts the checkout page, collects
  sales tax, and remits to the merchant. A single Dodo checkout session can mix
  one-time and subscription products, so this one package covers both flows.

  **Client (`@aquarian-metals/coin-moebius-dodopayments`):**
  - `createDodoPaymentsProvider({ checkoutEndpoint })` returns a `PaymentProvider`
    registered as `id: 'dodopayments'`. It POSTs to your own checkout endpoint,
    fires `onPending`, then redirects the buyer to Dodo's hosted `checkout_url`.
    Redirect URLs are scheme-checked (http/https only) before navigation.

  **Server (`@aquarian-metals/coin-moebius-dodopayments/server`):**
  - `createDodoPaymentsVerifier({ webhookSecret })` verifies webhooks using the
    Standard Webhooks scheme: base64 HMAC-SHA256 over
    `${webhook-id}.${webhook-timestamp}.${rawBody}`, keyed by the base64-decoded
    `whsec_…` secret, compared against each `v1,<sig>` token in the
    `webhook-signature` header (constant time, rotation-aware). Replay-protected
    by a configurable timestamp tolerance window (default 5 minutes). Requires the
    raw request body (string or bytes) and fails closed on a pre-parsed object.
  - `computeDodoSignature(id, timestamp, body, secret)` exported for callers with
    non-standard rawBody pipelines.
  - Event mapping: `payment.succeeded` → `success`, `payment.processing` →
    `pending`, `payment.failed`/`payment.cancelled` → `failed`, `refund.succeeded`
    → `refunded`, `dispute.opened` → `disputed`; `subscription.active` →
    `subscription.created`, `subscription.renewed` → `subscription.renewed`,
    `subscription.failed` → `subscription.payment_failed`,
    `subscription.cancelled`/`subscription.expired` → `subscription.canceled`,
    other `subscription.*` → `subscription.updated`. Refund and dispute events key
    on the original `payment_id` for cross-event linking. Amounts convert from
    Dodo's minor units. Unmodeled events (payouts, license keys, `refund.failed`,
    dispute resolution follow-ups) resolve to `null`.

### Patch Changes

- @aquarian-metals/coin-moebius-core@1.0.0
