---
'@aquarian-metals/coin-moebius-stripe': minor
'@aquarian-metals/coin-moebius-server': minor
---

**Breaking:** Stripe webhook verifier — drop the `payment_intent.succeeded` handler and the fall-through fake-pending result; return `null` for any event that isn't a `checkout.session.completed`.

Previously, the verifier treated both `checkout.session.completed` AND `payment_intent.succeeded` as successful payments. Stripe fires both events for one Checkout-mode purchase, so consumers subscribed to both event types recorded every payment **twice** — see HARDENING_AUDIT CRIT-8.

Separately, the verifier's fall-through emitted a fake `{status: 'pending', amount: 0}` result for every unrecognized event type (`product.created`, `price.created`, `charge.succeeded`, …) instead of signaling "not a payment event," polluting consumer transaction stores with zero-amount rows — see HARDENING_AUDIT IMP-10.

**New contract:** `Verifier` and `VerifierRegistry.verify` now return `Promise<PaymentResult | null>`. `null` means "signature was valid, but this event isn't one to act on" — callers should respond 200 to the provider and skip insert. Non-Checkout direct-PaymentIntent integrations need a separate verifier; this one is Checkout-only.

**Migration:**

- Update consumers reading the verifier result to handle `null` (`if (!result) return ignored;`).
- If you were relying on `payment_intent.succeeded` from this verifier, configure your Stripe webhook to send `checkout.session.completed` instead.
- If you were subscribed to broader event types like `product.*` / `charge.*` / `invoice.*`, those will now return `null` rather than fake-pending rows — most consumers want this. Subscribe only to `checkout.session.completed` if you're using Stripe Checkout.
