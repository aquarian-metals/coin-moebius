# API Stability Policy

The Coin Moebius SDK uses Semantic Versioning (`MAJOR.MINOR.PATCH`) and a deliberate distinction between API surface that is **frozen at 1.0** and surface that remains **flexible** until at least 2.0. This document tells you which is which, so you can integrate against the SDK without worrying about which APIs are about to move.

## The 1.0 freeze line

Once we hit `1.0.0`, the following are **frozen** — we will not change them without bumping to `2.0.0` and giving at least 90 days' notice:

### Core types (`@aquarian-metals/coin-moebius-core`)

- **`PaymentResult` shape** — the canonical object every payment provider produces on the client side. Three-value `status` enum (`'success' | 'pending' | 'failed'`), `paymentId`, `provider`, `amount`, `currency`, `metadata`, `timestamp`, and optional `raw`.
- **`InitiateOptions` shape** — the arguments to `payments.initiate()`.
- **`PaymentProvider` interface** — the contract every provider package implements. Adding a new optional field to this interface is a minor change; renaming or removing anything is a major.
- **`createPaymentManager(config)` API** — the constructor signature, the returned manager's methods (`initiate`, `onSuccess`, `onPending`, `onError`, `subscribeToStatus`), and their signatures.

### Provider verifier signatures (`*/server`)

Each provider package exposes one or more `create*Verifier` functions on its `./server` subpath. The **input contract** (raw body + headers) and **output contract** (`Promise<PaymentResult>`) of each verifier function is frozen. Adding new config options to a verifier is a minor change; renaming or removing a verifier is a major.

This applies to:

- `createStripeVerifier` in `@aquarian-metals/coin-moebius-stripe/server`
- `createCryptomusVerifier` in `@aquarian-metals/coin-moebius-cryptomus/server`
- (And every future provider's `/server` verifier — same input/output contract is part of the deal.)

## Flexible surface (may change without major bump)

The following may evolve in `1.x` releases. Treat as integration points to override or wrap, not to depend on the precise default behavior of:

- **Default endpoint paths** in client-side providers (`/api/checkout/stripe`, `/api/checkout/cryptomus`, `/api/checkout/manual`). Override via the config option when you need a stable path; we may change the defaults to better fit common host conventions.
- **Internal types of provider configs** beyond the documented public fields. We may add optional fields, narrow type unions, etc., as we tighten typing.
- **`PaymentStore` interface** in `@aquarian-metals/coin-moebius-server`. Currently two methods (`upsert`, `get`). We may add optional methods or refine return types as real-world implementations surface gaps. Any change will be additive; the existing two methods stay.
- **Error messages**. The error envelope (`new Error(...)` from a verifier) is stable as a _thrown error_, but the exact wording of the message may change. Don't pattern-match on error message text.

## Provider-package-specific notes

- **Stripe API version**: pinned via the `apiVersion` config (and a default internal constant). Bumped on a deliberate **quarterly manual review cadence** against Stripe's upgrade guide. Not auto-bumped via Renovate/dependabot — Stripe API changes can have subtle behavior differences worth eyeballing. The default may move between minor versions of this package.
- **Cryptomus signature scheme**: `md5(base64(json) + paymentApiKey)`. This matches Cryptomus's documented protocol; we follow whatever they ship.
- **Manual provider state machine**: the four-state model (`pending_manual`, `succeeded`, `manual_canceled`, `manual_expired`) is frozen. The mapping to `PaymentResult.status` is documented in the manual package's README.

## Deprecation policy

When we deprecate an API:

1. We emit a `console.warn()` from the deprecated function the first time it's called per process. The warning identifies the function and the replacement.
2. The TSDoc on the function gets a `@deprecated` tag with the same information.
3. The CHANGELOG entry for the release announces the deprecation, the replacement, and the target removal version.
4. **Minimum 90 days** between deprecation and removal. Removals are always in major-version bumps.

## Pre-1.0 reality

While the version line is in `0.x.x`, the rules above are aspirational targets, not contractual promises. We're using the `0.x` window to:

- Iterate on the API based on early adopters' feedback.
- Resolve the open items listed as "Important" or "Nice-to-have" in `docs/HARDENING_AUDIT.md`.
- Validate that the SDK works in production for at least one real-world consumer before locking the surface.

Every `0.x` release may break shape. Pin a caret range like `^0.2.0` so a single bump rolls the whole family forward. Once we hit `1.0.0`, the freeze line above takes effect for real.

## Reporting stability concerns

If you find an API surface that **should** be in the freeze line but isn't, or vice versa, open an issue on the GitHub repo with the proposal. We'd rather hear about it before 1.0 than after.
