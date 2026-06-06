# Subscriptions

The Coin Moebius SDK supports recurring billing on fiat providers that have their own subscription APIs. This page is about how the SDK exposes those events to your code.

## What's supported

| Provider                                          | Subscriptions in SDK                                 |
| ------------------------------------------------- | ---------------------------------------------------- |
| Stripe                                            | Yes (Phase 4.2, shipped)                             |
| PayPal                                            | Coming soon (Phase 4.4)                              |
| Square                                            | Coming soon (Phase 4.5)                              |
| Authorize.net                                     | Coming soon (Phase 4.6)                              |
| NOWPayments, Cryptomus, Monero, Coinbase Business | No. Crypto subscriptions are not on the roadmap.     |
| Manual                                            | No. The reference-code flow is single-use by design. |

## The pass-through model

The provider owns the buyer relationship. Cards are stored on Stripe. Renewal schedules run on Stripe. Failed-payment retries happen on Stripe's dunning rails. The SDK's job is to give your server-side code a clean, normalized event stream for the lifecycle moments you care about.

You configure the recurring price once (interval, optional trial). After that:

- The provider charges the buyer on schedule.
- The provider emails the buyer a receipt for each cycle.
- The provider runs dunning when a card fails.
- The provider hosts the cancellation UI in its customer portal.
- You get webhooks for each lifecycle change. The SDK normalizes them.

You don't store card details, run cron jobs, or maintain renewal schedules. That's the whole point of the abstraction.

## Event types

Every subscription-aware provider's webhook verifier emits one of five normalized event types:

| Event type                    | When it fires                                                                    | Typical handler                                                    |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `subscription.created`        | New signup. Carries the first cycle's amount.                                    | Grant access.                                                      |
| `subscription.renewed`        | Non-initial cycle succeeded.                                                     | Extend access through `currentPeriodEnd`.                          |
| `subscription.payment_failed` | A cycle failed to charge.                                                        | Log for visibility. Provider's dunning will retry on its schedule. |
| `subscription.canceled`       | Terminal cancellation (buyer canceled, dunning exhausted, or merchant canceled). | Revoke access.                                                     |
| `subscription.updated`        | Status change, plan change, card update.                                         | Inspect `status` and re-sync.                                      |

## Event shape

```typescript
interface SubscriptionEvent {
  type: SubscriptionEventType;
  subscriptionId: string;
  provider: string;
  productId: string | null; // your merchant-facing product reference
  customerRef: string | null; // provider's customer id (cus_… for Stripe)
  status: 'active' | 'past_due' | 'canceled' | 'paused' | 'unknown';
  currentPeriodEnd: number | null; // unix seconds
  amount: number;
  currency: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  raw?: unknown; // full provider payload, untouched
}
```

Provider-specific reason codes (Stripe's `past_due` cause, PayPal's billing-agreement state codes) go into `metadata` untouched. The normalized `status` enum stays small and neutral so the same handler code works across providers.

## Reading the discriminated event union

`verify()` returns a `WebhookEvent | null`. `WebhookEvent` is a discriminated union:

```typescript
type WebhookEvent = ({ kind: 'payment' } & PaymentResult) | ({ kind: 'subscription' } & SubscriptionEvent);
```

Branch on `kind` to narrow:

```typescript
const event = await verifier.verify(rawBody, headers);

if (event?.kind === 'payment') {
  // event.status is PaymentStatus, event.paymentId is set
}

if (event?.kind === 'subscription') {
  // event.type is SubscriptionEventType, event.subscriptionId is set
}
```

Or use the helper functions for code that only cares about one variant:

```typescript
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';

const payment = asPayment(event);
if (payment?.status === 'success') {
  // payment is PaymentResult-shaped, no `kind` field
}

const sub = asSubscription(event);
if (sub?.type === 'subscription.renewed') {
  // sub is SubscriptionEvent-shaped, no `kind` field
}
```

## Identifying buyers without storing them

The SDK normalizes whatever the provider sends. Stripe puts the buyer's email and customer id on subscription events; the SDK passes those through to your handler. What you do with them is up to you. If you want the same data on the SDK's `SubscriptionEvent.customerRef`, it's there. If you'd rather identify buyers by your own opaque user id without holding the provider's, pass your own identifier as `customer-ref` when the buy element initiates checkout — the element forwards it as `metadata.customerRef` on the checkout request:

```html
<coin-moebius-buy
  endpoint="https://your-backend.example.com"
  project-id="proj_YOUR_ID"
  product-id="pro-plan"
  customer-ref="user_bob_42"
></coin-moebius-buy>
```

Or, if you're calling the SDK directly:

```typescript
payments.initiate({
  productId: 'pro-plan',
  providerId: 'stripe',
  metadata: { customerRef: 'user_bob_42' },
});
```

That opaque string is what you use to identify Bob in your own system. The SDK passes it to the provider as subscription metadata, and the provider returns it on every webhook event. Your `verify()` handler reads it back from `event.metadata.customerRef`. To the SDK it's a string with no meaning; to your application it's the foreign key into your user database. The two only meet at that one identifier.

For deep buyer detail (email, card last-four, dispute history), drill into the provider's own dashboard. The provider holds the customer record; the SDK doesn't try to mirror it.

## Cancellation: link out to the provider's portal

The SDK does not host a cancellation UI. Each provider has one of its own: for Stripe, the Customer Portal; for PayPal, the buyer's PayPal account page; and so on. The SDK exposes a small helper to fetch a portal URL you can drop a buyer into:

```typescript
import { getStripePortalUrl } from '@aquarian-metals/coin-moebius-stripe/server';

const url = await getStripePortalUrl({
  secretKey: process.env.STRIPE_SECRET_KEY,
  customerId: 'cus_buyer_abc', // from event.customerRef
  returnUrl: 'https://you.example/account',
});

// Redirect or anchor the buyer to `url`.
```

The buyer manages everything (cancellation, card updates, downloading receipts) inside Stripe's UI. They land back on your `returnUrl` when they're done.

## What you need on the provider side

The provider has to be set up to actually run the subscription. The SDK does not provision Products or Prices for you; you either do that ahead of time in the provider's dashboard or hand the right shape on each `checkout.sessions.create({ mode: 'subscription', ... })` call from your own serverless function.

For Stripe specifically, you also need to **enable the Customer Portal** once in your Stripe Dashboard before `getStripePortalUrl()` will succeed. Stripe gives a clear error message if it's not configured.

## What you don't have to do

For completeness, here's everything subscription handling does NOT require from you:

- No card storage.
- No cron jobs to charge buyers on a schedule.
- No retry logic when a card fails.
- No dunning emails to buyers.
- No proration logic for plan changes.
- No invoice or receipt generation.
- No tax handling beyond what your provider's Tax product does for you.
- No customer-facing portal UI.

Everything in this list is the provider's job. The SDK gives you the events; the provider does the work.

## Testing

For Stripe, the Stripe CLI streams real subscription events from a sandbox account into your local server. The flow is identical to one-time payment testing. Just trigger subscription events instead:

```bash
stripe trigger customer.subscription.created
stripe trigger invoice.payment_succeeded
stripe trigger customer.subscription.deleted
```

The SDK's own tests use signed fixtures captured from these triggers; you can crib from `packages/providers/stripe/test/server.test.ts` for shape examples.
