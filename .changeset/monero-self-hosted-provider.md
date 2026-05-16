---
'@aquarian-metals/coin-moebius-monero': minor
'@aquarian-metals/coin-moebius-server': minor
---

**New:** `@aquarian-metals/coin-moebius-monero` — direct self-hosted Monero provider. No third-party gateway, no custodial keys, no API tokens. The merchant runs `monerod` + `monero-wallet-rpc` + a small indexer; this package supplies the browser provider, the server-side creator (subaddress minting), the webhook verifier, and the indexer factory (with `.tick()`, `.start()`, `.status()`, and `processTx(hash)` for `monero-wallet-rpc --tx-notify` push mode).

Three deployment tiers documented in the package README:

- **Tier 1 (solo)** — one VPS, `node indexer.js` under systemd.
- **Tier 2 (small business)** — private VPC, docker-compose with split services.
- **Tier 3 (scale)** — Kubernetes, single-replica indexer with `/health` exposing `indexer.status()`, cold-spend separation.

The indexer is **catch-up by design**: if it's offline for a stretch, the next tick sees the missed transfers and emits the webhooks then. Operational SLA is "eventually consistent within a few minutes," not "five-nines."

**Also added (additive, non-breaking):** an optional `markStatusAnnounced(paymentId, status)` method on the `PaymentStore` interface in `@aquarian-metals/coin-moebius-server`. The Monero indexer uses it when present to guarantee exactly-once webhook emission across HA replicas; falls back to a read-then-write idempotency check when absent. Existing `PaymentStore` implementations (including the in-repo `createMemoryStore`) continue to satisfy the interface without changes — the new method is optional. Production stores planning to run the Monero indexer in HA mode should implement it.

See `examples/static-site-demo/monero/` for a copy-paste deployment with `create-monero-payment.js`, `payment-webhook.js`, `indexer.js`, `notify.js` for `--tx-notify`, a systemd unit, and an optional `docker-compose.yml`.
