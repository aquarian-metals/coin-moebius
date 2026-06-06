# @aquarian-metals/coin-moebius-provider-template

## 0.8.0

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

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

### Patch Changes

- Updated dependencies [fb7c94e]
- Updated dependencies [6f28eef]
  - @aquarian-metals/coin-moebius-core@2.0.0

## 0.3.0

### Minor Changes

- Lockstep release. Template itself is unchanged; new sibling packages this cycle are `@aquarian-metals/coin-moebius-nowpayments` (US-friendly crypto provider) and `@aquarian-metals/coin-moebius-element` (the `<coin-moebius-buy>` custom element).

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
