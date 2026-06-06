# @aquarian-metals/coin-moebius-nowpayments

## 0.8.0

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

## 2.0.0

### Minor Changes

- 6f28eef: **Breaking:** Rename `createNowPaymentsCreator` → `createNowPaymentsProvider` (and the config type `NowPaymentsCreatorConfig` → `NowPaymentsProviderConfig`).

  The old name was an outlier — every other browser-side provider factory in the SDK uses the `createXProvider` shape (`createStripeProvider`, `createCryptomusProvider`). Naming the NOWPayments equivalent `Creator` made it read as a different concept rather than the same `PaymentProvider` factory the other packages expose.

  **Migration:**

  ```diff
  -import { createNowPaymentsCreator } from '@aquarian-metals/coin-moebius-nowpayments';
  +import { createNowPaymentsProvider } from '@aquarian-metals/coin-moebius-nowpayments';

  -const nowpayments = createNowPaymentsCreator({
  +const nowpayments = createNowPaymentsProvider({
     checkoutEndpoint: '/.netlify/functions/create-nowpayments-payment',
   });
  ```

  And, where the config type was imported by name:

  ```diff
  -import type { NowPaymentsCreatorConfig } from '@aquarian-metals/coin-moebius-nowpayments';
  +import type { NowPaymentsProviderConfig } from '@aquarian-metals/coin-moebius-nowpayments';
  ```

  The server-side `createNowPaymentsVerifier` is unchanged. Behavior is unchanged — this is a pure rename.

- fb7c94e: Add recurring-billing event support across the SDK.

  **Core (`@aquarian-metals/coin-moebius-core`):**
  - New `SubscriptionEvent` interface and `SubscriptionEventType` union covering `subscription.created`, `subscription.renewed`, `subscription.payment_failed`, `subscription.canceled`, `subscription.updated`.
  - New `SubscriptionStatus` union (`active` / `past_due` / `canceled` / `paused` / `unknown`).
  - New `WebhookEvent` discriminated union with `kind: 'payment' | 'subscription'`. Every provider verifier now returns this union from `verify()`. The `kind: 'payment'` variant is structurally identical to the previous `PaymentResult` shape with an added `kind` field, so existing consumers keep type-checking after adding the discriminator check.
  - New `asPayment(event)` and `asSubscription(event)` narrowing helpers that strip the `kind` field and return the inner shape (or `null` if the event is the other variant).

  **Per-provider:**

  Provider verifiers gain subscription-event recognition where the underlying provider supports recurring billing. The first wave covers Stripe; PayPal, Square, and Authorize.net follow in subsequent changesets. Crypto providers (NOWPayments, Cryptomus, Monero) are not affected — recurring crypto is intentionally out of scope.

  **Migration:**

  If you currently read `result.status` directly off a verifier return value, add a discriminator check:

  ```diff
  -if (result.status === 'success') { /* … */ }
  +if (result.kind === 'payment' && result.status === 'success') { /* … */ }
  ```

  Or use `asPayment(event)` to narrow once and reuse. See `MIGRATION.md` section 8 for the full recipe.

  **No runtime behavior change** for one-time payment flows. The verifier emits payment events exactly as before, now wrapped with `kind: 'payment'`.

- 6f28eef: **Breaking:** Extend `PaymentResult.status` to surface post-payment events.

  Adds three new values to the status enum:
  - `refunded` — full or partial refund of a previous payment. `amount` is the refunded amount (not the original total).
  - `disputed` — chargeback / dispute opened. `metadata.reason` carries the provider's stated reason where available.
  - `partial` — buyer paid less than the invoiced amount. `amount` reflects what was actually received; `metadata.invoicedAmount` carries the original.

  **Per-provider mappings:**
  - **Stripe:** `charge.refunded` → `refunded` (uses `amount_refunded` so partial refunds report the cumulative slice). `charge.dispute.created` → `disputed`. Both events resolve `paymentId` to the original PaymentIntent id so consumers can match the post-payment event back to the original transaction. `checkout.session.completed` now also uses the PaymentIntent id as `paymentId` (was the Session id) for the same linking purpose; falls back to the Session id if no PaymentIntent is present.
  - **NOWPayments:** `partially_paid` IPN → `partial` (with `amount` set to `actually_paid` and `metadata.invoicedAmount` set to `price_amount`). `refunded` IPN → `refunded` (was previously `failed`).

  **Migration:**
  - Consumers that switch on `result.status` need new branches for `'refunded'`, `'disputed'`, `'partial'`. TypeScript will flag missing cases when consumers compile against the new type.
  - Stripe consumers that stored the Checkout Session id as their primary key need to migrate to keying by PaymentIntent id (or add an index on `payment_intent` and look up that way).
  - NOWPayments consumers that grouped `refunded` under "failed" should now expect a distinct `refunded` value. Update dashboard filters / status displays accordingly.

### Patch Changes

- Updated dependencies [fb7c94e]
- Updated dependencies [6f28eef]
  - @aquarian-metals/coin-moebius-core@2.0.0

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
