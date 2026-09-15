# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Every public package in this repo moves in lockstep on one version number, so a
caret range like `^4.2.0` rolls the whole family forward together.

## [Unreleased]

## [4.3.0] — 2026-09-14

### Changed

- **A quote is rounded to six significant digits rather than six decimal places, and Monero is rounded too.** A fixed count of decimal places cannot be right for every coin, because the last place is worth whatever the coin is worth. Six decimals of ZANO is a hundredth of a cent, which is nothing. Six decimals of a coin priced like Bitcoin is about eight cents, and on a five dollar sale that rounds the buyer up by more than one percent. It fails the other way too: on a small invoice in an expensive coin, most of those six places are leading zeros and the real digits fall off the end.

  Counting significant digits scales on its own. One rule reads `1.62075` on ZANO and `0.0000633` on something expensive, and it holds the same relative accuracy however small the invoice is. The coin's own precision is still the ceiling, so Freedom Dollar's four places are untouched.

  Monero had no rounding at all and quoted the raw conversion, so a ten dollar order asked the buyer for `0.066666666667`. It now uses the same rule and asks for `0.0666667`. Rounding stays **up** on both rails, so the merchant is never left a fraction short.

## [4.2.3] — 2026-09-14

### Changed

- **A Zano quote is rounded up to six decimal places.** ZANO carries twelve, so an exact conversion reached the buyer as `1.62074554295` for a ten dollar order. Nobody can check or retype that, and the trailing digits are false precision on a rate that moves while they read it. Quotes now stop at six places, or at the asset's own precision when that is coarser, so Freedom Dollar's four are untouched.

  Rounding is always **up**. Down would leave the merchant a fraction short on every order, and a buyer sending the displayed figure would land on `partial`. Up costs a rounding error far below a cent. The atomic amount, the wallet link, and the settlement check all use the rounded figure, so the number shown is exactly the number that settles.

## [4.2.2] — 2026-09-14

### Fixed

- **The Zano provider could not authenticate to a wallet at all.** The access token was encoded base64url, the way a JWT normally is. Zano's `simplewallet` decodes it with a plain base64 decoder, so any token carrying a `-` or a `_` came back `401 Invalid input: not within alphabet`. A signature is 32 random bytes, so almost every token carried one, and almost every call failed. Nothing worked: no address could be minted, no payment could be seen. The token is now standard base64, padding included. Verified against `simplewallet v2.2.1.506`, where the same request returns 200 signed this way and 401 signed the old way.

  The existing test normalized both alphabets before decoding, so it passed either way and never saw this. It now asserts the wire format, and new tests check fifty consecutive tokens for a base64url character and for the padding a strict decoder needs.

## [4.2.1] — 2026-09-14

No code changes. Every package is identical to 4.2.0.

This release exists to put the whole family back on one version number. During
the 4.2.0 publish, npm accepted `@aquarian-metals/coin-moebius-nowpayments` and
then stranded it in its own staging step: the version never appeared on the
registry, and it can never be uploaded again, because npm refuses a second
publish at a version it has already staged. That left fifteen packages at 4.2.0
and one at 4.1.0.

Nothing was broken for anyone installing. No package depends on the NOWPayments
package, and its 4.1.0 remained installable throughout. What broke was the
promise the release tooling makes, that one version number describes the whole
family, so `npm run check:sync` had no true answer to give.

If you are on 4.2.0, there is no reason to move except to keep that promise
true. `4.2.0` of the NOWPayments package does not exist and never will.

## [4.2.0] — 2026-09-14

### Added

- **`@aquarian-metals/coin-moebius-zano`**, the self-hosted Zano provider. No third-party gateway, no custodial keys. The merchant runs `zanod` + `simplewallet` in RPC mode and a small indexer; the package supplies the browser provider, the server-side creator (an integrated address with a fresh 8-byte payment id per checkout), the webhook verifier, and the indexer factory (`.tick()`, `.start()`, `.status()`). Pays in ZANO or in any Zano asset the merchant accepts; Freedom Dollar ships as `FREEDOM_DOLLAR_ASSET_ID`, and an asset's decimals are read from the merchant's own wallet at checkout, never from a table. Money that arrives on a payment id in the wrong asset is reported on the webhook as `otherAssets` and never credited. Speaks the wallet's JWT auth (`jwtSecret` on the creator and indexer). Guide in `docs/self-hosted-zano.md`; copy-paste deployment in `examples/static-site-demo/zano/`; the static-site demo gains offline Zano and Freedom Dollar tiles behind `ZANO_MOCK=true`.
- **Optional `PaymentStore.listPending(provider)`** in `@aquarian-metals/coin-moebius-server`. A Zano wallet keeps no record of the payment ids it hands out, so the store is the only list of open invoices; the Zano indexer uses this method, when present, to announce unpaid invoices `failed` at `expiresAt`. Existing stores keep satisfying the interface without changes. `createMemoryStore` implements it.
- **Optional `PaymentStore.unmarkStatusAnnounced(paymentId, status)`** in `@aquarian-metals/coin-moebius-server`, the inverse of `markStatusAnnounced`. An indexer calls it when it won the claim to announce a payment but could not deliver the webhook, so the announcement is retried on the next tick instead of being lost. Optional, so existing stores are unaffected; a store that implements `markStatusAnnounced` should implement this one too. `createMemoryStore` implements it.
- **Confirmation progress from the self-hosted Monero indexer.** The indexer used to compute a payment's confirmation count on every sweep and stay silent until that payment settled, which left a buyer watching a checkout with nothing to read. It now POSTs a `status: 'pending'` webhook while the payment gathers confirmations, and the payment record stays `pending` throughout: this announces progress, it never decides an outcome. Delivery is bounded by the count itself. The last announced count is stored on the record, so a sweep that finds nothing new posts nothing, and an indexer catching up after downtime sends one webhook rather than one per block it missed.
- **`MoneroWebhookPayload.requiredConfirmations`.** The indexer now reports how many confirmations a payment needs alongside how many it has, so a checkout can show "3 of 10" instead of a bare count. Named to match the existing `requiredConfirmations` option on `MoneroIndexerConfig`. Optional on the wire, so a hand-written indexer built against an earlier version still compiles and still delivers; consumers should render a count with no target rather than assuming one is present.

### Fixed

- **A failed webhook no longer loses a real payment.** Both self-hosted indexers claim the right to announce a settlement before they deliver it, so that two indexers cannot announce the same thing twice. A delivery that then failed used to spend the claim anyway: the money was on the chain and confirmed, no later tick would retry, and the merchant was eventually told at expiry that nothing had arrived. A claim that is not delivered is now handed back, so the next tick tries again. Stores that implement `markStatusAnnounced` were the ones affected; stores without it already retried.
- **The amount shown to a Zano buyer is now the amount that settles the invoice.** The quote came from the rate calculation while the invoice required that amount rounded up to the asset's smallest unit, so the modal could print more decimal places than the asset carries. A buyer whose wallet truncated those extra places, or who typed the number by hand, underpaid and got a partial. Every amount is now read back from the atomic value, and the modal prints it as an exact decimal string. Freedom Dollar felt this most, at four decimal places.
- **A wallet reply carrying an awkward number no longer stops the Zano indexer.** Wallet replies are pre-scanned so 64-bit amounts survive `JSON.parse`. The scanner looked only at what followed a run of digits, so the tail of a long decimal, or the digits after a minus sign, were quoted mid-number and the result would not parse. Every wallet call goes through that scanner, so one such reply threw on every tick from then on and the indexer went quiet for good.
- **The Zano checkout modal validates every field it renders.** `assetAmount`, `decimalPoint`, and `expiresAt` were used but never checked, so a checkout endpoint that omitted one showed the buyer the word `undefined` where the amount belongs, or `NaN minutes` on the expiry line.

### Changed

- **`MoneroWebhookPayload.status` accepts `'pending'`** in addition to the terminal `'success'`, `'partial'`, and `'failed'`. The verifier already passed the value straight through, so this widens a type rather than changing behavior. Consumers that switch on the status should handle `'pending'` as "on the chain, still settling" and keep polling; `createMoneroVerifier()` maps it to a `PaymentResult` carrying the invoice amount, with the observed confirmation count on `metadata.confirmations`.

## [4.1.0] — 2026-06-18

### Added

- **`@aquarian-metals/coin-moebius-makepay`**, the MakePay provider. MakePay creates a hosted checkout link, the buyer pays on MakePay's page in any of 70+ coins, and the money settles straight to the merchant's own wallet — MakePay never holds it. A signed webhook reports the result back.
- **`createDodoSubscriptionCheckout()`** in `@aquarian-metals/coin-moebius-dodopayments/server`. Opens a Dodo-hosted recurring checkout, so Dodo joins Stripe and PayPal as a rail where the buyer manages their own subscription in the provider's portal. Subscription-creation calls live in the provider package, never in the vendor-neutral core.

## [4.0.1] — 2026-06-06

### Fixed

- Packaging and CI only: the lockfile is pinned to npm 11 so `npm ci` resolves vitest 4's nested `vite`/`esbuild` the same way local development does. No runtime change in any package.

## [4.0.0] — 2026-06-06

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
