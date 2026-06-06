# @aquarian-metals/coin-moebius-stripe

## 0.8.0

### Minor Changes

- Stripe: surface paid one-off and manual invoices as payment events.

  `invoice.payment_succeeded` events for invoices that aren't tied to a
  subscription (for example an out-of-band charge billed directly to a customer)
  were previously dropped. They now emit a normalized payment event carrying the
  invoice id, billing reason, price id, and the invoice's own metadata, so
  consumers can react to the paid signal instead of losing it.

  Subscription and subscription-invoice events now also include `priceId` in
  their metadata.

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

## 2.0.0

### Minor Changes

- 6f28eef: **Breaking:** Stripe webhook verifier — drop the `payment_intent.succeeded` handler and the fall-through fake-pending result; return `null` for any event that isn't a `checkout.session.completed`.

  Previously, the verifier treated both `checkout.session.completed` AND `payment_intent.succeeded` as successful payments. Stripe fires both events for one Checkout-mode purchase, so consumers subscribed to both event types recorded every payment **twice** — see HARDENING_AUDIT CRIT-8.

  Separately, the verifier's fall-through emitted a fake `{status: 'pending', amount: 0}` result for every unrecognized event type (`product.created`, `price.created`, `charge.succeeded`, …) instead of signaling "not a payment event," polluting consumer transaction stores with zero-amount rows — see HARDENING_AUDIT IMP-10.

  **New contract:** `Verifier` and `VerifierRegistry.verify` now return `Promise<PaymentResult | null>`. `null` means "signature was valid, but this event isn't one to act on" — callers should respond 200 to the provider and skip insert. Non-Checkout direct-PaymentIntent integrations need a separate verifier; this one is Checkout-only.

  **Migration:**
  - Update consumers reading the verifier result to handle `null` (`if (!result) return ignored;`).
  - If you were relying on `payment_intent.succeeded` from this verifier, configure your Stripe webhook to send `checkout.session.completed` instead.
  - If you were subscribed to broader event types like `product.*` / `charge.*` / `invoice.*`, those will now return `null` rather than fake-pending rows — most consumers want this. Subscribe only to `checkout.session.completed` if you're using Stripe Checkout.

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

- Lockstep release with two new sibling packages. Stripe integration itself is unchanged; this version aligns its number with the rest of the monorepo:
  - **NEW** `@aquarian-metals/coin-moebius-nowpayments` — US-friendly crypto provider.
  - **NEW** `@aquarian-metals/coin-moebius-element` — `<coin-moebius-buy>` drop-in custom element.

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

### Patch Changes

- Updated dependencies []:
  - @aquarian-metals/coin-moebius-core@1.0.0
