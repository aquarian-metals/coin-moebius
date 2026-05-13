# @aquarian-metals/coin-moebius

## 0.3.0

### Minor Changes

- Lockstep release with two new sibling packages. The umbrella package itself is unchanged; this version aligns its number with the rest of the monorepo:
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

### Patch Changes

- Updated dependencies []:
  - @aquarian-metals/coin-moebius-core@1.0.0
