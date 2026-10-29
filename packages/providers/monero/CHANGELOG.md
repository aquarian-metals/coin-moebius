# @aquarian-metals/coin-moebius-monero

## 4.5.1

### Patch Changes

- **A short payment that is topped up now settles.** Once the indexer had reported an order as `partial`, it stopped looking at that order, so the rest of the money was never reported and the store was never told to deliver. It now keeps watching and reports `success` when the confirmed total reaches the invoice.

## 4.5.0

### Patch Changes

- **Never settles an order whose stored amount is missing.** A missing `atomicAmount` used to read as zero, so any payment counted as paid in full. The indexer now refuses and reports why. A whole-number `atomicAmount` handed back by a store as a number is read as the same amount.
- **A confirmed, full payment settles even while another transfer to the same invoice is unconfirmed.** One unconfirmed transfer can no longer hold a paid order open; a short payment still waits for every transfer before it is called `partial`.
- **The verifier refuses a message whose `provider` is not `monero`**, so a secret reused across indexers cannot pass another provider's message off as a Monero payment.
- **Wallet calls and webhook deliveries time out after 30 seconds** (`requestTimeoutMs`).
- **Checkout metadata can no longer seed the fields the indexer owns** (`confirmations`, `txHash`, `receivedAtomic`), which silenced the progress webhooks.
- **A late payment on an expired invoice settles even when the store cannot claim announcements.** The fallback only let a `pending` invoice through.
- **The invoice amount on the settle and late-payment webhooks comes from the stored invoice**, so a handler that overwrote the order with a `failed` event no longer zeroes it.
- **An invoice whose money landed outside the lookback window is never failed.** Before failing it, the indexer asks the wallet for that subaddress's transfers; money found there keeps the invoice open and logs a warning to raise the lookback.
- **Webhooks name the product** (`productId` on the payload).
- **Payment ids end in sixteen hex characters from the platform's cryptographic random source**, so two checkouts in the same millisecond never collide and no buyer can guess another buyer's id.
- **The expiry sweep reads the store's open invoices (`listPending`) instead of every labeled subaddress in the wallet**, so a tick no longer grows with the shop's history.
- **The README's checkout code takes the price from your own product list, never from the request.**

## 4.2.0

### Minor Changes

- **The indexer reports confirmation progress while a payment settles.** It used to count confirmations on every sweep and say nothing until the payment was final, which left a buyer watching a checkout with no sign that anything was happening. It now POSTs a `status: 'pending'` webhook as the count climbs, and the payment record stays `pending` the whole time: this announces progress, it never decides an outcome. The last announced count is stored, so a sweep that finds nothing new posts nothing, and an indexer catching up after downtime sends one webhook instead of one per missed block.
- **`MoneroWebhookPayload.requiredConfirmations`** rides along with the count, so a checkout can show "3 of 10" instead of a bare number. Optional on the wire, so a hand-written indexer built against an earlier version still compiles and still delivers.
- **`MoneroWebhookPayload.status` accepts `'pending'`** alongside the terminal `'success'`, `'partial'`, and `'failed'`. Handle it as "on the chain, still settling" and keep polling.

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
