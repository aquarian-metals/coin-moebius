# Stripe Integration Guide

End-to-end walkthrough for accepting Stripe payments on a static site via the Coin Moebius SDK. About 15 minutes from a fresh Stripe account to a working webhook.

The package READMEs cover the surface API; this guide covers the deployment-shaped details: Stripe Dashboard setup, environment variables, common failure modes, and a worked example you can copy.

## What you'll build

```
Buyer's browser  ──┐
                   │ 1. payments.initiate(stripe)
                   ▼
            Your /api/checkout/stripe   ──── 2. Creates session via Stripe API ──→  Stripe
                   │                                                                   │
                   │ 3. Returns sessionId                                               │
                   ▼                                                                    │
            Stripe Checkout (hosted by Stripe)  ←──── 4. Browser redirected ────────────┘
                   │
                   │ 5. Buyer pays, Stripe redirects to your success URL
                   ▼
            Stripe ──── 6. Async webhook to /api/webhook ────→  Your server
                                                                       │
                                                                       │ 7. createStripeVerifier
                                                                       ▼
                                                                  Fulfill the order
```

## Prerequisites

- A Stripe account (test mode is fine to start).
- A hosting platform that can run two serverless functions (Cloudflare Workers, Vercel, Netlify, Express, Cloud Run — any of them).
- Your static site already loads the SDK (`coin-moebius` + `coin-moebius-stripe`).

## Step 1 — Stripe Dashboard setup

In the [Stripe Dashboard](https://dashboard.stripe.com/):

1. **Get your API keys** under _Developers → API keys_:
   - `pk_test_...` (publishable key) — ships to the browser, safe.
   - `sk_test_...` (secret key) — server-side only. Never put this in a `VITE_*` env var.

2. **Configure a webhook endpoint** under _Developers → Webhooks → Add endpoint_:
   - URL: `https://your-site.example/api/webhook` (the route you'll create in step 3).
   - Events to listen for: `checkout.session.completed` and `payment_intent.succeeded`.
   - After saving, Stripe shows the **webhook signing secret** (`whsec_...`). Copy it.

## Step 2 — Environment variables

Set three environment variables on your hosting platform:

| Name                          | Value         | Used by                                |
| ----------------------------- | ------------- | -------------------------------------- |
| `VITE_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` | Browser (compiled into bundle)         |
| `STRIPE_SECRET_KEY`           | `sk_test_...` | Serverless: `create-session` function  |
| `STRIPE_WEBHOOK_SECRET`       | `whsec_...`   | Serverless: `payment-webhook` function |

Naming with `VITE_*` is a Vite convention; rename for other build tools.

## Step 3 — Wire the browser side

```typescript
import { createPaymentManager } from '@aquarian-metals/coin-moebius';
import createStripeProvider from '@aquarian-metals/coin-moebius-stripe';

const payments = createPaymentManager({
  providers: [
    createStripeProvider({
      publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
      // Default `/api/checkout/stripe` works on most hosts. Override for Netlify:
      // sessionEndpoint: '/.netlify/functions/create-stripe-session',
    }),
  ],
});

payments.onSuccess((result) => {
  // Note: this fires on the redirect-back page, not in this initial handler.
  // Most integrations also rely on the server-side webhook for fulfillment.
  unlockDownload(result);
});

document.querySelector('#buy')?.addEventListener('click', () => {
  payments.initiate({
    productId: 'ebook-42',
    amount: 19.99,
    currency: 'USD',
    // Identify the buyer with your own opaque id. This threads through
    // Stripe's subscription/customer metadata and comes back on every
    // event, so you can join Coin Moebius's records to your own user
    // database without us storing anything about the buyer.
    metadata: { customerRef: 'user_bob_42' },
  });
});
```

The SDK redirects the browser to Stripe Checkout. Stripe redirects back to the URL you configured in the Checkout Session (created in step 4).

## Step 4 — Create-session serverless function

Lives at the path your provider's `sessionEndpoint` points at (default `/api/checkout/stripe`). This function holds your `STRIPE_SECRET_KEY` and creates the Checkout Session.

```typescript
// /api/checkout/stripe (Cloudflare Workers / Vercel Function / Express handler)
import Stripe from 'stripe';

export default async function handler(req: Request): Promise<Response> {
  const { productId, amount, currency, metadata } = await req.json();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2025-02-24.acacia',
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: productId },
          unit_amount: Math.round(amount * 100), // cents
        },
        quantity: 1,
      },
    ],
    success_url: 'https://your-site.example/success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://your-site.example/cancel',
    metadata,
  });

  return Response.json({ sessionId: session.id });
}
```

The SDK's `createStripeProvider` POSTs `{ productId, amount, currency, metadata }` to this endpoint and expects `{ sessionId }` back.

## Step 5 — Webhook verifier serverless function

Lives at the path you configured in the Stripe Dashboard (step 1). This function holds your `STRIPE_WEBHOOK_SECRET` and verifies the incoming signature before trusting the payload.

```typescript
// /api/webhook
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createStripeVerifier } from '@aquarian-metals/coin-moebius-stripe/server';

// Module-level setup: registered once on cold start.
const verifiers = createVerifierRegistry();
verifiers.register(
  'stripe',
  createStripeVerifier({
    endpointSecret: process.env.STRIPE_WEBHOOK_SECRET,
  }),
);

export default async function handler(req: Request): Promise<Response> {
  // IMPORTANT: pass the *raw* body, not parsed JSON. Stripe's signature
  // verification needs the exact bytes that were signed.
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());

  // Tell the registry which provider this is — Stripe uses `Stripe-Signature`
  // header, no `x-provider`, so we pass it explicitly via the headers shim:
  const event = await verifiers.verify(rawBody, { ...headers, 'x-provider': 'stripe' });

  if (event?.kind === 'payment' && event.status === 'success') {
    // One-time payment: fulfill the order.
    await markPaid(event.paymentId, event.amount);
  }

  if (event?.kind === 'subscription') {
    // Recurring billing event. The provider owns the schedule and dunning;
    // you just react to state changes.
    switch (event.type) {
      case 'subscription.created':
        await grantAccess(event.subscriptionId, event.customerRef);
        break;
      case 'subscription.renewed':
        await extendAccess(event.subscriptionId, event.currentPeriodEnd);
        break;
      case 'subscription.payment_failed':
        // Stripe's dunning will retry — you usually don't need to act
        // immediately. Log it for visibility.
        break;
      case 'subscription.canceled':
        await revokeAccess(event.subscriptionId);
        break;
      case 'subscription.updated':
        await syncSubscriptionState(event.subscriptionId, event.status);
        break;
    }
  }

  return new Response('OK', { status: 200 });
}
```

If you only care about one-time payments today, narrow with the `asPayment` helper:

```typescript
import { asPayment } from '@aquarian-metals/coin-moebius-core';

const payment = asPayment(await verifiers.verify(rawBody, headers));
if (payment?.status === 'success') {
  await markPaid(payment.paymentId, payment.amount);
}
```

A few subtleties worth knowing:

- **Raw body is non-negotiable.** Stripe's HMAC signature is computed over the exact request body bytes. If your framework JSON-parses the body before your handler sees it, the signature check will fail. Cloudflare Workers gives you raw `request.text()` by default. Express needs `express.raw({ type: 'application/json' })` middleware. Vercel needs `export const config = { api: { bodyParser: false } }`.
- **Return 200 fast.** Stripe retries non-2xx responses for up to 3 days. If your fulfillment is slow, return 200 immediately and process asynchronously (or queue the work).
- **Idempotency.** Stripe may deliver the same event twice (retries, network blips). Either persist `result.paymentId` and skip duplicates, or make `markPaid()` idempotent.

## Step 6 — Test it locally

Use the [Stripe CLI](https://stripe.com/docs/stripe-cli) to forward real Stripe events to your local server without exposing it publicly:

```bash
# Terminal 1: your local server
npm run dev   # or wrangler dev, vercel dev, etc.

# Terminal 2: forward events
stripe listen --forward-to localhost:8787/api/webhook
# Copy the temporary webhook secret it prints (whsec_...) into your local env.

# Terminal 3: trigger a test event
stripe trigger checkout.session.completed
```

Your webhook handler should receive the event, verify the signature, and log a success. If signature verification fails, double-check that you're reading the raw body, not a parsed object.

## Production deployment checklist

- [ ] Test-mode keys swapped for live-mode keys (`pk_live_...`, `sk_live_...`, `whsec_...`).
- [ ] Webhook endpoint URL in Stripe Dashboard points at production, not localhost.
- [ ] Webhook secret in your env vars matches the production webhook (not the CLI's temporary one).
- [ ] Stripe Tax enabled if you cross any nexus thresholds (see Stripe Dashboard → Tax).
- [ ] Fulfillment is idempotent (Stripe retries on non-2xx, and may double-deliver on network blips).
- [ ] Logs include `result.paymentId` so you can correlate refunds, disputes, and support tickets.
- [ ] Stripe radar settings reviewed for the products you're selling (fraud thresholds).

## Common failure modes

| Symptom                                                 | Likely cause                                                                                    | Fix                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `coin-moebius/stripe: invalid signature` in your logs   | Body was parsed before signature verification                                                   | Disable body parsing on the webhook route; pass the raw text/buffer to `verify()`                                                |
| Webhook returns 200 but fulfillment never runs          | The verified `result.status` is `'pending'`, not `'success'`                                    | Add logging in your handler; some Stripe events aren't full successes (e.g., `payment_intent.created` is just an acknowledgment) |
| Stripe shows "events delivered" but your DB has nothing | Your handler crashed before reaching the persistence step, but returned 200                     | Add try/catch + logging around the fulfillment call; consider a queue for async work                                             |
| `session.amount_total` is `null`                        | Currency is using a zero-decimal unit (JPY, KRW) — `unit_amount` is the whole number, not cents | Multiply by 1 for zero-decimal currencies, by 100 for normal ones                                                                |
| `redirectToCheckout` error in the browser               | `sessionId` returned from your endpoint is empty/invalid                                        | Add error handling on the server side; return 4xx with a clear message rather than `{ sessionId: undefined }`                    |

## What you don't need

- **A merchant of record.** This integration uses Stripe directly, not Paddle/Lemon Squeezy. You own the tax compliance burden — see Stripe Tax for the easy path.
- **Stripe Connect.** Connect is for marketplaces where multiple sellers receive payments. For a single-seller site, plain Stripe is correct.
- **A separate database for payment records.** If you only need "did this payment succeed?" the webhook handler can write directly to your existing app database. The SDK's `PaymentStore` interface is for the polling case (Cryptomus async confirmations, manual provider) — Stripe completes synchronously.
