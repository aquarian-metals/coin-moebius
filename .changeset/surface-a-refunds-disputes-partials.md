---
'@aquarian-metals/coin-moebius-core': minor
'@aquarian-metals/coin-moebius-stripe': minor
'@aquarian-metals/coin-moebius-nowpayments': minor
---

**Breaking:** Extend `PaymentResult.status` to surface post-payment events.

Adds three new values to the status enum:

- `refunded` — full or partial refund of a previous payment. `amount` is the refunded amount (not the original total).
- `disputed` — chargeback / dispute opened. `metadata.reason` carries the provider's stated reason where available.
- `partial` — buyer paid less than the invoiced amount. `amount` reflects what was actually received; `metadata.invoicedAmount` carries the original.

**Per-provider mappings:**

- **Stripe:** `charge.refunded` → `refunded` (uses `amount_refunded` so partial refunds report the cumulative slice). `charge.dispute.created` → `disputed`. Both events resolve `paymentId` to the original PaymentIntent id so consumers can match the post-payment event back to the original transaction. `checkout.session.completed` now also uses the PaymentIntent id as `paymentId` (was the Session id) for the same linking purpose; falls back to the Session id if no PaymentIntent is present.
- **NOWPayments:** `partially_paid` IPN → `partial` (with `amount` set to `actually_paid` and `metadata.invoicedAmount` set to `price_amount`). `refunded` IPN → `refunded` (was previously `failed`).

**Migration:**

- Consumers that switch on `result.status` need new branches for `'refunded'`, `'disputed'`, `'partial'`. TypeScript will flag missing cases when consumers compile against the new type.
- Stripe consumers that stored the Checkout Session id as their primary key need to migrate to keying by PaymentIntent id (or add an index on `payment_intent` and look up that way). For Coin Moebius Cloud, this is a fresh-deploy change; pre-existing customer integrations should match the new behavior on next deploy.
- NOWPayments consumers that grouped `refunded` under "failed" should now expect a distinct `refunded` value. Update dashboard filters / status displays accordingly.
