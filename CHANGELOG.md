# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version line stays in `0.1.0-beta.x`, all six packages move in lockstep
and any release may break shape; pin a caret range like `^0.1.0-beta.1` so a
single bump rolls the whole family forward.

## [Unreleased]

### Added

- **Recurring-billing event support across the SDK.** New `SubscriptionEvent` interface and `SubscriptionEventType` union in `@aquarian-metals/coin-moebius-core` covering `subscription.created`, `subscription.renewed`, `subscription.payment_failed`, `subscription.canceled`, and `subscription.updated`. Provider verifiers now emit these events alongside one-time payment events, normalized through the same dispatch path. Stripe ships first; PayPal, Square, and Authorize.net follow.
- **`WebhookEvent` discriminated union.** Every provider's `verify()` now returns `WebhookEvent | null` instead of `PaymentResult | null`. The union is `{ kind: 'payment' } & PaymentResult` or `{ kind: 'subscription' } & SubscriptionEvent`. Branch on `event.kind` to narrow, or use the new `asPayment(event)` / `asSubscription(event)` helpers.
- **`getStripePortalUrl()` helper** in `@aquarian-metals/coin-moebius-stripe/server`. Returns a Stripe-hosted Customer Portal URL so buyers can cancel, update cards, and download receipts inside Stripe's UI — no portal page to host yourself. Pass `{ secretKey, customerId, returnUrl }`.
- **Stripe subscription event mapping.** `createStripeVerifier()` now recognizes `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded` (cycle), and `invoice.payment_failed`, mapping them to the normalized event types above. Subscription-mode `checkout.session.completed` is intentionally skipped to avoid double-counting signups (the canonical signup event is `customer.subscription.created`).
- **PayPal subscription event mapping.** `createPaypalVerifier()` recognizes `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.UPDATED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, and `PAYMENT.SALE.COMPLETED` (with `billing_agreement_id` set). The merchant's opaque buyer ID lands on the event's `metadata.customerRef` when passed via PayPal's `custom_id`.
- **Square subscription event mapping.** `createSquareVerifier()` recognizes `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.deactivated`, `invoice.payment_made` (with `subscription_id` set), and `invoice.scheduled_charge_failed`.
- **Authorize.Net ARB event mapping.** `createAuthorizenetVerifier()` recognizes the seven ARB subscription event types plus `net.authorize.payment.authcapture.created` with a `subscriptionId` field as the renewal signal.
- **`getPaypalPortalUrl()`, `getSquarePortalUrl()`, `getAuthorizenetPortalUrl()` helpers** alongside the existing `getStripePortalUrl()`. PayPal returns the buyer's autopay page; Square and Authorize.Net return the merchant dashboard URL since neither provider exposes a buyer-facing portal for subscriptions.
- **`docs/subscriptions.md`** — full walkthrough of the pass-through subscriptions model: event lifecycle, normalized event shape, narrowing helpers, hosted portal flow, and per-provider support matrix.

### Changed

- **`Verifier` return type widened to `Promise<WebhookEvent | null>`.** Existing consumers that read `result.status` directly need to add a discriminator check (`if (result.kind === 'payment') …`), or wrap the call with `asPayment()` for backwards-compatible narrowing. Runtime behavior for one-time payment flows is unchanged — payment events are now wrapped with `kind: 'payment'`, with no other shape changes. See `MIGRATION.md` section 8.
- **`SubscriptionEvent.customerRef` carries the provider's customer id** (Stripe's `cus_…`, etc.) when the provider includes one on the event. The SDK does not store anything itself — it just passes what the provider sent. Consumers decide what to persist; the SDK doesn't impose a privacy posture.

## [0.2.0] — 2026-05-12

### Added

- **`@aquarian-metals/coin-moebius-manual`** — manual / async payment provider for Goldbacks, cash in mail, wire transfer, personal check, barter, and any other "I'll confirm receipt by hand" payment method. Browser entry renders a default modal with mailing instructions and a reference code; the `./server` subpath exposes a reference-code generator and the `pending_manual` → `succeeded` / `manual_canceled` / `manual_expired` state machine. No signature verifier — manual confirmations come from authenticated dashboard clicks, not external webhooks.

### Changed (breaking)

- **Renamed `@aquarian-metals/coin-moebius-monero-cryptomus` → `@aquarian-metals/coin-moebius-cryptomus`** along with the provider id (`monero-cryptomus` → `cryptomus`), factory function (`createMoneroCryptomusProvider` → `createCryptomusProvider`), config type (`MoneroCryptomusConfig` → `CryptomusConfig`), and all error-message prefixes. The package routes any Cryptomus-supported coin, not just Monero — the original name was misleading.
- **Cryptomus client now forwards `options.currency` to the backend create-endpoint** instead of hardcoding `'XMR'`. The `PaymentResult` returned to the SDK callback now reports the actual requested currency. The `metadata.amountXMR` field was renamed to `metadata.cryptomusAmount`.
- **`CryptomusCreateInput.currency` is now required** (was optional with `'XMR'` default). Callers must specify the coin explicitly.
- **`@aquarian-metals/coin-moebius-server`'s `registerVerifier` and `verify` top-level functions removed in favor of `createVerifierRegistry()`.** The previous API used module-level mutable state, which leaked across consumers in multi-tenant runtimes and forced tests to `vi.resetModules()` for isolation. The factory pattern returns an isolated `{ register, verify }` instance per call. See migration note below.

### Migration

**Cryptomus rename:** Find-and-replace `monero-cryptomus` → `cryptomus`, `MoneroCryptomus` → `Cryptomus`, `createMoneroCryptomusProvider` → `createCryptomusProvider` in your integration. Update `package.json` dependencies from `@aquarian-metals/coin-moebius-monero-cryptomus` to `@aquarian-metals/coin-moebius-cryptomus`. If you were not passing `currency` to `createCryptomusCreator`, add `currency: 'XMR'` to preserve the previous default behavior.

**Server registry factory:** Replace `import { verify, registerVerifier } from '@aquarian-metals/coin-moebius-server'` with `import { createVerifierRegistry }`. Create a registry at module load:

```typescript
// Before
import { verify, registerVerifier } from '@aquarian-metals/coin-moebius-server';
registerVerifier('stripe', createStripeVerifier({ ... }));
const result = await verify(req.body, req.headers);

// After
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
const verifiers = createVerifierRegistry();
verifiers.register('stripe', createStripeVerifier({ ... }));
const result = await verifiers.verify(req.body, req.headers);
```

### Added

- **`@aquarian-metals/coin-moebius-manual`** modal now has jsdom-based test coverage — 12 tests covering ARIA attributes, focus management, button clicks, Escape key, focus restoration, XSS escaping, and the custom-renderer override path.
- **`@aquarian-metals/coin-moebius`** (the re-export alias) now has a smoke test verifying that every symbol from `coin-moebius-core` is reachable through the alias with the same identity.
- **`createVerifierRegistry()` in `@aquarian-metals/coin-moebius-server`** — per-instance verifier registries (replaces the module-level state described above).
- **`createMemoryStore()` in `@aquarian-metals/coin-moebius-server`** — minimal zero-dependency in-memory `PaymentStore` implementation. Useful for tests, prototypes, and getting-started examples. Not production-viable (state is lost on process restart); production consumers implement `PaymentStore` against their own backing store.

### Removed (breaking)

- **Supabase adapter removed from `@aquarian-metals/coin-moebius-server`.** `createSupabaseStore`, `SupabaseStoreConfig`, the `./supabase` subpath export, and the runtime dependency on `@supabase/supabase-js` are all gone. The SDK is strictly vendor-neutral: it ships the `PaymentStore` interface plus a minimal in-memory reference adapter (`createMemoryStore`), and concrete vendor-coupled adapters live in consumers' own code or in separately-published packages. Anyone who needs Supabase persistence implements `PaymentStore` against the Supabase client directly (~30 lines).
- **`PaymentRecord.confirmations` field removed.** The top-level `confirmations?: number` is gone. Provider-specific fields like blockchain confirmation counts now live consistently in `metadata` (where the Cryptomus verifier already puts them). The `PaymentRecord` interface only extends `PaymentResult` with `createdAt`/`updatedAt` server-side timestamps.

### Changed

- **Default checkout endpoints generalized.** `coin-moebius-stripe`'s `sessionEndpoint` defaults to `/api/checkout/stripe` (was `/.netlify/functions/create-stripe-session`); `coin-moebius-cryptomus`'s `createEndpoint` defaults to `/api/checkout/cryptomus` (was `/.netlify/functions/create-cryptomus-payment`). REST-style, vendor-neutral; matches the existing `/api/checkout/manual` default. Netlify users override via the config option to preserve the old paths.

### Documented

- **`PaymentStore` interface** in `coin-moebius-server`'s `types.ts` now has TSDoc covering the contract (`upsert` + `get`), where provider-specific fields go (`metadata`), and how `createdAt`/`updatedAt` interact.
- **`subscribeToStatus` split** between browser (`coin-moebius-core`'s `payments.subscribeToStatus`) and server (`coin-moebius-server`'s `createStatusSubscriber(store)`) — both functions now have TSDoc explaining which environment to pick.
- **Manual provider status mapping** — new README section in `coin-moebius-manual` documenting how the internal four-state machine (`pending_manual`, `succeeded`, `manual_canceled`, `manual_expired`) projects onto the public three-value `PaymentResult.status` enum.
- **Stripe API version policy** — `coin-moebius-stripe`'s `DEFAULT_API_VERSION` constant and `apiVersion` config option now document the quarterly manual-bump cadence (no auto-bumping via Renovate/dependabot — Stripe API changes warrant a manual review against their upgrade guide).

## [0.1.0-beta.1] — 2026-05-08

Initial public beta. Six packages, all under the `@aquarian-metals/` scope, all
publishing under the `beta` dist-tag on npm.

### Added

- **`@aquarian-metals/coin-moebius-core`** — provider-agnostic payment manager
  (`createPaymentManager`), shared `PaymentProvider` / `PaymentResult` /
  `InitiateOptions` types, and a browser-side `subscribeToStatus` poller for
  delayed payments (Monero confirmations, etc.). Browser-safe — no Node imports.
- **`@aquarian-metals/coin-moebius`** — friendly install alias that re-exports
  the core. `npm install @aquarian-metals/coin-moebius` is the recommended
  one-liner.
- **`@aquarian-metals/coin-moebius-server`** — Node-only webhook dispatch
  (`registerVerifier` / `verify`), a `PaymentStore`-backed status subscriber,
  and a Supabase-backed `PaymentStore` reachable at the `./supabase` subpath.
- **`@aquarian-metals/coin-moebius-stripe`** — Stripe provider. Browser entry
  redirects to Stripe Checkout via a configurable `sessionEndpoint`. The
  `./server` subpath verifies webhooks using `webhooks.constructEventAsync`,
  which works on Node, Cloudflare Workers, Deno, and other edge runtimes.
  The Stripe SDK is an _optional_ peer dependency, so browser bundles never
  pull in `node:crypto`.
- **`@aquarian-metals/coin-moebius-monero-cryptomus`** — Monero (via Cryptomus)
  provider. Browser entry posts to a configurable `createEndpoint` you control;
  the API key never ships to the browser. The `./server` subpath exposes
  `createCryptomusCreator` (signs + posts to Cryptomus) and
  `createCryptomusVerifier` (validates incoming webhooks). Both directions use
  the documented `md5(base64(jsonBody) + paymentApiKey)` signature scheme.
- **`@aquarian-metals/coin-moebius-provider-template`** — copy-and-rename
  starter for community providers. `coin-moebius-core` is declared as a peer
  dependency so the template's consumers install it once.

### Tested

- 43 Vitest unit tests across 8 suites cover the manager, status subscriber,
  webhook dispatch, both providers (client + server), and the full
  Cryptomus signature round-trip (creator → verifier).
- GitHub Actions CI (`.github/workflows/ci.yml`) runs the suite on Node 20 and
  22 against every PR and push to `main`.

### Released via

- GitHub Actions release workflow (`.github/workflows/release.yml`) triggered
  on `v*` git tags. Publishes packages in dependency order with npm provenance
  enabled; prerelease versions ship under `beta`, stable versions under
  `latest`.
