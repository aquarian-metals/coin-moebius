# @aquarian-metals/coin-moebius-monero

## 0.8.0

### Patch Changes

- @aquarian-metals/coin-moebius-core@0.8.0

## 2.0.0

### Minor Changes

- 6f28eef: **New:** `@aquarian-metals/coin-moebius-monero` — direct self-hosted Monero provider. No third-party gateway, no custodial keys, no API tokens. The merchant runs `monerod` + `monero-wallet-rpc` + a small indexer; this package supplies the browser provider, the server-side creator (subaddress minting), the webhook verifier, and the indexer factory (with `.tick()`, `.start()`, `.status()`, and `processTx(hash)` for `monero-wallet-rpc --tx-notify` push mode).

  Three deployment tiers documented in the package README:
  - **Tier 1 (solo)** — one VPS, `node indexer.js` under systemd.
  - **Tier 2 (small business)** — private VPC, docker-compose with split services.
  - **Tier 3 (scale)** — Kubernetes, single-replica indexer with `/health` exposing `indexer.status()`, cold-spend separation.

  The indexer is **catch-up by design**: if it's offline for a stretch, the next tick sees the missed transfers and emits the webhooks then. Operational SLA is "eventually consistent within a few minutes," not "five-nines."

  **Also added (additive, non-breaking):** an optional `markStatusAnnounced(paymentId, status)` method on the `PaymentStore` interface in `@aquarian-metals/coin-moebius-server`. The Monero indexer uses it when present to guarantee exactly-once webhook emission across HA replicas; falls back to a read-then-write idempotency check when absent. Existing `PaymentStore` implementations (including the in-repo `createMemoryStore`) continue to satisfy the interface without changes — the new method is optional. Production stores planning to run the Monero indexer in HA mode should implement it.

  See `examples/static-site-demo/monero/` for a copy-paste deployment with `create-monero-payment.js`, `payment-webhook.js`, `indexer.js`, `notify.js` for `--tx-notify`, a systemd unit, and an optional `docker-compose.yml`.

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
