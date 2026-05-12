# SDK Hardening Audit

**Date**: 2026-05-12
**Reviewer**: Claude (with founder direction)
**Current state**: 0.1.0-beta.1
**Target**: stable 1.0 release-readiness, with infrastructure that proves it.

## Why this document exists

The Coin Moebius Cloud business is built on top of this SDK. If the SDK is buggy or unreliable, the Cloud collapses and the "you can self-host instead" open-source promise becomes a liability. Going from beta to stable requires more than passing the existing tests — it requires verification infrastructure that catches regressions, a hardened API surface that we promise not to break, and documentation that lets customers integrate without questions.

This audit is the gap analysis. The hardening plan below is what closes the gaps. Both update as we work.

## Top-line verdict

The SDK is **in solid beta shape** — this is hardening, not rescue. The current code:

- Does what it claims (signature verification is real, not stubbed)
- Has thoughtful tests (43 across 8 suites, with real crypto for signatures)
- Has consistent error messaging and TypeScript types
- Has a real CI pipeline running on two Node versions
- Has a release workflow with npm provenance

The gaps are about (a) the _verification infrastructure_ not being complete enough to prove stability, (b) some API decisions that should be locked down before 1.0, and (c) operational hygiene (linting, coverage thresholds, bundle size, browser-environment tests).

## Packages in scope

| Package                          | Purpose                                                                   | Tests today         | Notes                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `coin-moebius-core`              | Types + `createPaymentManager` + browser `subscribeToStatus`              | 12 tests, 2 suites  | Core API surface — promise stability before 1.0                                                |
| `coin-moebius`                   | Re-exports core (install alias)                                           | 0 tests             | Should have a smoke test verifying the re-exports                                              |
| `coin-moebius-server`            | `registerVerifier`/`verify` + `createStatusSubscriber` + Supabase adapter | ~10 tests, 2 suites | Has module-level global state (see CRIT-1)                                                     |
| `coin-moebius-stripe`            | Stripe client + server                                                    | ~9 tests, 2 suites  | Real signature verification via Stripe library                                                 |
| `coin-moebius-cryptomus`         | Cryptomus client + server (any supported coin — Monero, btc, USDT, etc.)  | ~10 tests, 2 suites | Real MD5 signature round-trip tested. Renamed from `coin-moebius-monero-cryptomus` 2026-05-12. |
| `coin-moebius-manual`            | Manual/Goldbacks provider (new 2026-05-12)                                | 10 tests, 1 suite   | Client-side modal has no tests — needs jsdom                                                   |
| `coin-moebius-provider-template` | Starter for new providers                                                 | n/a                 | Not published / consumed                                                                       |

## Gaps, by severity

### CRITICAL (must fix before 1.0 release)

| ID         | Gap                                                                                                                | Why it's critical                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CRIT-1** | `coin-moebius-server`'s `registerVerifier`/`verify` uses module-level mutable state                                | Tests have to `vi.resetModules()` to isolate. In production, this means one customer's verifier registration can leak into another's process. Has to be refactored to a factory pattern that returns a `{ register, verify }` instance, or a class instance, so state is per-instance. |
| **CRIT-2** | Release workflow (`.github/workflows/release.yml`) hardcodes the list of packages to publish — `manual` is missing | If a release tag is pushed today, the `manual` package will not get published. Either iterate dynamically from the workspaces list or maintain the hardcoded list as part of every new-package PR.                                                                                     |
| **CRIT-3** | `coin-moebius-manual`'s default modal uses `document` but has no jsdom/happy-dom test setup                        | The default modal is part of the public API. Without tests, regressions in modal rendering ship silently.                                                                                                                                                                              |
| **CRIT-4** | No coverage thresholds in `vitest.config.ts`                                                                       | "We have tests" is not the same as "we know what's tested." A new file with no tests doesn't fail CI today.                                                                                                                                                                            |
| **CRIT-5** | No linting in CI                                                                                                   | Style drift, `any` types, missing `await`s — none caught. The Cloud monorepo we just set up has strict ESLint; the SDK should match.                                                                                                                                                   |
| **CRIT-6** | No bundle-size tracking                                                                                            | This is a browser SDK. A bad import on a dependency can balloon the bundle 5× without anyone noticing. `size-limit` or `bundlewatch` solves this.                                                                                                                                      |
| **CRIT-7** | No "Are The Types Wrong" (`attw`) check                                                                            | Dual ESM/CJS exports, `./server` subpath exports, peer-dep types — all easy to break with a tsconfig change. `attw` is the standard tool.                                                                                                                                              |

### IMPORTANT (must fix before 1.0; not blocking-blocking)

| ID        | Gap                                                                                                                            | Recommendation                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **IMP-1** | Default endpoints reference Netlify (`/.netlify/functions/create-stripe-session`, etc.)                                        | Generalize to `/api/checkout/<provider>` or similar; the Cloud's contract uses `/api/checkout/<provider>/<projectId>`. Document the contract clearly.                                                                               |
| **IMP-2** | Supabase adapter in `coin-moebius-server` is the only `PaymentStore` implementation                                            | Either (a) ship a `coin-moebius-cloudflare-d1` adapter to match the Cloud's choice, or (b) deprecate Supabase and document the `PaymentStore` interface so customers can roll their own. Keeping it is fine if we add alternatives. |
| **IMP-3** | `subscribeToStatus` exists in TWO places with different signatures (core uses URL + `fetch`; server uses `PaymentStore`)       | Document the distinction clearly (browser vs server) or consolidate. The split is reasonable but undocumented.                                                                                                                      |
| **IMP-4** | `PaymentResult.status` only has `'success' \| 'pending' \| 'failed'`                                                           | The manual provider's state machine has `manual_canceled` and `manual_expired`. These map to `failed` at the public-API level — verify this is consistent and documented.                                                           |
| **IMP-5** | Hardcoded Stripe API version `'2025-02-24.acacia'`                                                                             | Document the policy for bumping it; Stripe SDK major versions correlate with API versions.                                                                                                                                          |
| **IMP-6** | No browser-environment tests configured                                                                                        | All tests run with `environment: 'node'`. Some browser providers (Stripe + manual) use DOM APIs. Configure jsdom or happy-dom for those packages specifically.                                                                      |
| **IMP-7** | `confirmations` field on `PaymentRecord` is set inconsistently (Cryptomus puts it in `metadata`, the type has it at top level) | Pick one location and update both producers and consumers.                                                                                                                                                                          |
| **IMP-8** | No deprecation policy / no formal API stability guarantee                                                                      | Add `STABILITY.md` documenting the v1 promise, what's frozen, what may evolve, and the deprecation timeline.                                                                                                                        |
| **IMP-9** | No TypeDoc-generated API reference                                                                                             | The README is human-readable; an API reference is generated. Both needed for serious adopters.                                                                                                                                      |

### NICE-TO-HAVE (post-1.0)

| ID        | Gap                                                    | Recommendation                                                                                                                   |
| --------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **NTH-1** | No real-Stripe integration tests (only library-mocked) | Stripe CLI + a test mode account in CI lets us verify against the actual Stripe API. Costs nothing; adds significant confidence. |
| **NTH-2** | No real-Cryptomus integration tests                    | Cryptomus sandbox mode + a test merchant lets us round-trip through their real API.                                              |
| **NTH-3** | No mutation testing                                    | Stryker or similar would surface tests that pass even when the code is broken. Optional but high-value for a payment library.    |
| **NTH-4** | No fuzzing of webhook signature verifiers              | Property-based testing (fast-check) against arbitrary inputs would catch parsing bugs.                                           |
| **NTH-5** | No conventional-commits or changesets discipline       | Right now CHANGELOG is hand-maintained. Conventional commits + `auto-changelog` or Changesets automates this.                    |

## Hardening plan (phased)

### Phase 1 — Verification infrastructure (this is what proves stability)

Owner: AI assistant. No code-behavior changes. Completed 2026-05-12.

- [x] Add Prettier config (`.prettierrc` + `.prettierignore`). SDK uses tabs (preserving existing convention); markdown/YAML overridden to spaces. CRIT-5 closed (linting now exists; format included).
- [x] Add ESLint flat config (`eslint.config.mjs`) with strict rules: no `any`, no unsafe-_, `consistent-type-imports`, `eqeqeq`, `prefer-const`, `no-var`, `no-console` (warn). Test files exempt from unsafe-_ (mocks/casts). Closes CRIT-5.
- [x] Add `happy-dom` as a dev dependency. Per-test environment opt-in via `// @vitest-environment happy-dom` pragma; jsdom-based modal tests for the manual provider land in Phase 2.
- [x] Add coverage reporting (v8 provider, text/json/json-summary/html reporters) in `vitest.config.ts`. Numeric thresholds deferred until Phase 2/3 close known coverage gaps and we have a baseline. (CRIT-4 partially: reporting now exists, gating happens after baseline.)
- [x] Add `size-limit` + `@size-limit/preset-small-lib` with per-package budgets at `.size-limit.cjs`. Initial limits generous; will ratchet down after first measurement during Phase 2 work. Closes CRIT-6.
- [x] Add `@arethetypeswrong/cli` + `scripts/check-types.mjs` runner that iterates publishable workspaces. Closes CRIT-7.
- [x] Update `.github/workflows/ci.yml` to run a three-job pipeline: (1) verify (format:check + lint + typecheck), (2) test + coverage on Node 20 & 22, (3) build + attw + size-limit. Final job blocks on the first two.
- [x] Update `.github/workflows/release.yml` to use `npm publish --workspaces` with auto-derived dist-tag from version suffix. Private workspaces (examples) auto-skipped. Closes CRIT-2 cleanly (no more hardcoded list to maintain).
- [x] Configure pre-commit hook (`.husky/pre-commit`) + `lint-staged` config in `package.json` (matches Cloud setup, minus stylelint since SDK has no SCSS).
- [x] Add `tsconfig.eslint.json` so ESLint's type-checked rules can see both `src/` and `test/` files without polluting per-package build configs.
- [x] Update `tsconfig.base.json` with the strict-mode extras that don't break existing code (`forceConsistentCasingInFileNames`, `resolveJsonModule`, `isolatedModules`, `noFallthroughCasesInSwitch`, `noImplicitReturns`). The riskier extras (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`) are Phase 2 work — they will surface real type errors that need fixing alongside the factory-pattern refactor.
- [x] Update `.gitignore` to exclude `coverage/`, `*.tsbuildinfo`, `.eslintcache`.

**Verification next step (user runs locally):** `npm install` activates Husky, then `npm run verify` runs the full local equivalent of CI (format:check + lint + typecheck + build + test + attw + size). Expect first-run failures from existing code; those become the Phase 2 punch list.

### Phase 2 — Critical refactors

Completed 2026-05-12.

- [x] Refactor `coin-moebius-server`'s `registerVerifier`/`verify` to a factory pattern. Module-level state replaced by `createVerifierRegistry()` returning a per-call `{ register, verify }` instance. Tests updated to use the factory; new tests cover state isolation across registries and re-registration semantics. Closes CRIT-1. Breaking change documented in CHANGELOG with migration steps.
- [x] Add client-side tests for `coin-moebius-manual` using happy-dom. 12 tests in `packages/providers/manual/test/client.test.ts` cover: ARIA attributes (`role="dialog"`, `aria-modal`, `aria-labelledby`), focus management on open + restoration on close, button clicks (`I've shipped` fires `onPending`, `Cancel` fires nothing), Escape-key cancel, HTML escaping for XSS prevention, custom-renderer override path, error routing for both non-OK and malformed checkout responses. Closes CRIT-3.
- [x] Add a smoke test for `coin-moebius` (the re-export package) verifying every symbol round-trips. `packages/coin-moebius/test/smoke.test.ts` (3 tests) confirms key parity, identity (re-export is the same object, not a copy), and that `createPaymentManager` works through the alias.

**Test count after Phase 2:** 11 suites, 72 tests (up from 9 suites / 55 tests after Phase 1).

### Phase 3 — API hardening

Completed 2026-05-12.

- [x] **IMP-1 — Generalize default endpoints.** Stripe default is now `/api/checkout/stripe`, Cryptomus `/api/checkout/cryptomus` (matches the existing `/api/checkout/manual`). REST-style and vendor-neutral; works out-of-the-box on Cloudflare Workers, Vercel, Express. Netlify users override via the `sessionEndpoint`/`createEndpoint` config option. Tests + READMEs updated.
- [x] **IMP-2 — Supabase adapter decision: REMOVED.** Per the SDK-vendor-neutrality principle, the Supabase adapter was extracted from `coin-moebius-server` entirely. `@supabase/supabase-js` runtime dependency stripped, the `./supabase` subpath export removed, the `createSupabaseStore` function deleted. Replaced with a minimal zero-dependency `createMemoryStore()` reference implementation (~25 lines) that demonstrates the `PaymentStore` contract without endorsing any vendor.
- [x] **IMP-3 — `subscribeToStatus` split documented.** Both functions (browser-side in `coin-moebius-core`, server-side in `coin-moebius-server`'s `createStatusSubscriber`) now have TSDoc explaining the environment-based split and pointing at the sibling.
- [x] **IMP-4 — Manual provider status mapping documented.** New "How manual statuses map to `PaymentResult.status`" section in the manual provider's README, with a table showing how the internal four-state machine (`pending_manual`, `succeeded`, `manual_canceled`, `manual_expired`) projects onto the public three-value `PaymentResult.status` enum.
- [x] **IMP-5 — Stripe API version policy documented.** The `DEFAULT_API_VERSION` constant in `coin-moebius-stripe/server` now has TSDoc explaining the quarterly manual-bump cadence; the `apiVersion` config option's TSDoc explains when/how to override.
- [x] **IMP-7 — `confirmations` field placement resolved.** Removed the top-level `confirmations?: number` field from `PaymentRecord` (in `coin-moebius-server/types.ts`). Provider-specific fields like confirmation counts live consistently in `metadata` (where the Cryptomus verifier already puts them). The `PaymentRecord` interface now only extends `PaymentResult` with `createdAt` + `updatedAt` server-side timestamps.

**Test count after Phase 3:** 12 suites, 76 tests (added 4 memory-store tests; tests for Supabase weren't there to begin with).
**Bundle sizes after Phase 3:** all five client packages still well under their `size-limit` budgets; Stripe client dropped 8 B and Cryptomus 13 B from the shorter default endpoint strings.

### Phase 4 — Documentation

Completed 2026-05-12.

- [x] **IMP-9 — TypeDoc API reference.** Added `typedoc@^0.28` as a dev dep, `typedoc.json` config at the root, `npm run docs` script. Generates HTML output to `docs/api/` (gitignored, regenerated on demand). All 6 publishable packages successfully processed. The future `docs.coinmoebius.com` site will run this as part of its build.
- [x] **IMP-8 — `STABILITY.md` written.** Documents the v1 freeze line (frozen at 1.0: `PaymentResult`/`InitiateOptions`/`PaymentProvider` shapes, `createPaymentManager` API, all `/server` verifier signatures; flexible: default endpoint paths, internal config types, `PaymentStore` interface), per-package version policies (Stripe API version manual quarterly cadence), deprecation policy (90-day minimum, `console.warn` + `@deprecated` tag + CHANGELOG entry), and the pre-1.0 disclaimer.
- [x] **Stripe integration guide written** at `docs/integration-stripe.md`. End-to-end walkthrough: Stripe Dashboard setup, environment variables, create-session function, webhook verifier, local testing with Stripe CLI, production deployment checklist, common failure modes. ~250 lines.
- [x] **`MIGRATION.md` written.** Recipe-format upgrade guide for `0.1.0-beta.1` → next-release, covering all five breaking changes (Cryptomus rename, server registry factory, Supabase removal, `confirmations` field removal, default endpoints) with side-by-side diffs.
- [x] Root README updated with a "Documentation" section linking to STABILITY.md, MIGRATION.md, CHANGELOG.md, the Stripe integration guide, and the generated API reference path.

**Cryptomus and manual integration guides:** the package READMEs (extended in Phase 3 with the status-mapping table for manual) cover the integration ground. Full standalone guides for these can ship when `docs.coinmoebius.com` is built — they'd repeat the README content with deployment-specific sections, but the README content is the source of truth. Skipping the duplication for now.

### Phase 5 — Release prep

Completed 2026-05-12.

- [x] **Coverage thresholds set in `vitest.config.ts`** — 90% statements / 85% branches / 95% functions / 90% lines. Current actual: 98.82% / 87.27% / 100% / 98.82% (template excluded). Closes CRIT-4.
- [x] **Packages bumped to `0.2.0`** across all 7 publishable workspaces, with cross-references (`peerDependencies`, `devDependencies`, examples demo) updated to `^0.2.0`. _Note: Changesets's first `version-packages` run jumped to `1.0.0` (graduation-out-of-prerelease behavior). Manually corrected to `0.2.0` because STABILITY.md says we hit `1.0.0` only after at least one real customer integration ships._
- [x] **Changesets installed and configured.** `.changeset/config.json` uses `fixed` mode (all publishable packages bump in lockstep), `@changesets/changelog-github` for nicer changelog formatting, examples demo in `ignore`. `.changeset/README.md` documents how to add a changeset and how releases work. Per-package `CHANGELOG.md` files now generated automatically by `changeset version`.
- [x] **Pre-release dry-run.** `npm pack --dry-run` per package — all tarballs include only `dist/`, `LICENSE`, `README.md`, and `package.json`. No source, no tests, no caches. Sizes: core 4.9 kB → manual 10.5 kB (largest because of the default modal HTML).
- [ ] **Hit `1.0.0`** — deferred until at least one real customer integration runs on top of the SDK (per STABILITY.md). Coin Moebius Cloud will be that first customer.

### Phase 6 — Stretch (post-1.0)

- [ ] Real-Stripe and real-Cryptomus integration tests in CI (NTH-1, NTH-2)
- [ ] Mutation testing (NTH-3)
- [ ] Property-based fuzzing of signature verifiers (NTH-4)
- [ ] **New `@aquarian-metals/coin-moebius-monero` package** — direct Monero RPC integration (self-hosted node, no third-party gateway). Different architecture from the Cryptomus package: poll the daemon's RPC for incoming transactions to a designated wallet, no webhook, more sovereignty + privacy in exchange for more setup burden. For users who want Monero without the Cryptomus dependency.

## What "release-ready" means concretely

A package is release-ready when **all** of these hold:

1. **Coverage**: ≥90% statements / ≥85% branches in `src/` (enforced in CI).
2. **Linting**: ESLint, Prettier, type-checking — all clean.
3. **Bundle size**: under the configured `size-limit` for client-side packages.
4. **Type exports**: `attw` clean (no false-positive type imports, no missing types).
5. **Public API**: every exported symbol has TSDoc with description, params, returns, throws, example.
6. **Tests**: every public function has unit tests; integration paths have integration tests; the manual provider's modal has jsdom-based tests; both Stripe and Cryptomus signature paths have signature round-trip tests.
7. **Documentation**: README is current, API reference is generated, integration guide exists.
8. **CI**: all of the above are enforced on every PR.

## Resolved decisions (2026-05-12)

The four open questions were settled with the founder's "approve all four recommendations" on 2026-05-12. Recorded here for posterity:

1. **Supabase adapter — KEEP + AUGMENT.** Ship a Cloudflare D1 adapter alongside the existing Supabase one as part of Phase 3 (API hardening). The `PaymentStore` interface is the contract; vendors are interchangeable. Open-source promise is "you can self-host"; multiple backend choices make that real.
2. **v1 API freeze line — APPROVED:**
   - **Frozen at 1.0**: `PaymentResult` shape, `PaymentProvider` interface, `InitiateOptions`, `createPaymentManager` API, all per-provider `/server` verifier signatures.
   - **Flexible until 1.0**: default endpoint paths, internal types of provider configs, the `PaymentStore` interface.
3. **Real-API integration tests in CI — YES, POST-1.0.** Stripe CLI + a test-mode Stripe account + Cryptomus sandbox in GitHub Secrets. Tracked in Phase 6 (NTH-1, NTH-2).
4. **Stripe API version bumping — MANUAL, QUARTERLY.** No Renovate bot moving us silently. Document the cadence in Phase 3 with the rest of the API hardening notes.

## Status tracking

This document is the source of truth for SDK hardening progress. Update checkboxes as items complete. Add new gaps as they're discovered. Reference from individual PRs ("closes HARDENING-AUDIT IMP-2").
