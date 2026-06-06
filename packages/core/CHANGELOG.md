# @aquarian-metals/coin-moebius-core

## 0.8.0

## 2.0.0

### Minor Changes

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

## 0.3.0

### Minor Changes

- Lockstep release with two new sibling packages. No breaking changes in `-core` itself; this version aligns its number with the rest of the monorepo:
  - **NEW** `@aquarian-metals/coin-moebius-nowpayments` — US-friendly crypto provider (Cryptomus is geo-blocked in the US). Hosted invoice flow + IPN webhook verifier (HMAC-SHA512 over recursively-sorted JSON).
  - **NEW** `@aquarian-metals/coin-moebius-element` — `<coin-moebius-buy>` custom element. Drop-in HTML element with a self-initializing button + provider-picker modal. CSS-customizable via custom properties and `::part()` selectors. Full focus trap, Escape-to-close, Tab/Shift+Tab cycling, ARIA dialog/group semantics.

## 0.2.0

### Minor Changes

- Post-hardening release. Brings every package from `0.1.0-beta.1` to `0.2.0` after a four-phase verification and refactor pass. Full per-change detail is in `CHANGELOG.md` and `MIGRATION.md`; this entry summarizes the headline items.

  **New**
  - `@aquarian-metals/coin-moebius-manual` — manual / async payment provider for Goldbacks, cash, wire transfer, check, barter, IOU. Default modal + reference-code generator + state-machine helpers.
  - `@aquarian-metals/coin-moebius-server` — `createVerifierRegistry()` factory (per-instance webhook verifier dispatch) and `createMemoryStore()` (minimal in-memory `PaymentStore` for tests and prototypes).

  **Breaking changes** — see `MIGRATION.md` for side-by-side diffs.
  - Renamed `coin-moebius-monero-cryptomus` → `coin-moebius-cryptomus` (the package routes any Cryptomus-supported coin, not just Monero). Provider id, factory function, config type, and metadata field names all updated.
  - `coin-moebius-server` factory pattern: `registerVerifier`/`verify` top-level exports removed, replaced by `createVerifierRegistry()` returning a per-instance `{ register, verify }`.
  - Supabase adapter removed from `coin-moebius-server`. SDK is now strictly vendor-neutral; the `PaymentStore` interface stays + a zero-dependency `createMemoryStore` reference adapter ships. Vendor-specific stores live in consumers' own code.
  - `PaymentRecord.confirmations` top-level field removed; provider-specific confirmation counts live in `metadata` consistently.
  - Default checkout endpoints generalized: Stripe `/api/checkout/stripe`, Cryptomus `/api/checkout/cryptomus` (was `/.netlify/functions/...`). Override via the config option for Netlify-style hosts.
  - `CryptomusCreateInput.currency` is now required (was optional with `'XMR'` default).

  **Hardening infrastructure**
  - Strict ESLint (no `any`, no unsafe-\*, consistent-type-imports, etc.) running in CI.
  - Coverage thresholds enforced: 90% statements, 85% branches, 95% functions, 90% lines.
  - `@arethetypeswrong/cli` running on every CI build, ESM-only profile.
  - `size-limit` budgets on every client-side bundle.
  - Happy-DOM for browser-environment tests; 12 new jsdom-based tests for the manual modal.
  - TypeDoc-generated API reference (`npm run docs`).
  - `STABILITY.md` documenting the v1 freeze line and `MIGRATION.md` documenting the upgrade path.
