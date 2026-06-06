# ♾️ Coin Moebius

**The headless, zero-UI payment router for static sites.**

Turn Stripe, NOWPayments, gold escrow, or literally anything else into a single, boring `onSuccess` callback.

Static sites (JAMstack) are fast and cheap. But the second you want to accept money, you're forced to either rent a heavy, locked-in storefront (Gumroad, Payhip) or hand-roll a spaghetti monster of different webhooks for every gateway.

**Coin Moebius fixes this.** It gives you a WordPress-style plugin ecosystem for static site checkouts. You keep 100% control of your UI and fulfillment logic. We just normalize the _"they paid"_ signal.

---

## What makes it magic?

- **Zero Opinion UI:** We don't care what your buy button looks like. Build your own frontend.
- **One Universal Callback:** Whether they paid with cards via Stripe or crypto via NOWPayments, your fulfillment code runs exactly the same way.
- **Tiny Core:** We stripped the heavy stuff out. Only install the providers you actually use.
- **Safe by Default:** A strict boundary between the browser (`core`) and your serverless webhooks (`server`).

---

## Providers

Every provider is its own package. Install only what you need. Each package ships a browser entry plus a server-side webhook verifier under the `./server` subpath; a few also ship optional helpers under additional subpaths.

| Provider             | Package                                           | Surface                                                     |
| -------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| Stripe               | `@aquarian-metals/coin-moebius-stripe`            | Cards (Stripe Checkout)                                     |
| PayPal               | `@aquarian-metals/coin-moebius-paypal`            | PayPal Orders v2                                            |
| Authorize.Net        | `@aquarian-metals/coin-moebius-authorizenet`      | Cards (Accept Hosted)                                       |
| Square (Block)       | `@aquarian-metals/coin-moebius-square`            | Cards (Payment Link)                                        |
| Dodo Payments        | `@aquarian-metals/coin-moebius-dodopayments`      | Merchant of Record (cards + subscriptions, hosted checkout) |
| Coinbase Business    | `@aquarian-metals/coin-moebius-coinbase-business` | Crypto (Checkout API)                                       |
| NOWPayments          | `@aquarian-metals/coin-moebius-nowpayments`       | Crypto (200+ coins, hosted invoice)                         |
| Cryptomus            | `@aquarian-metals/coin-moebius-cryptomus`         | Crypto (geo-restricted in the US)                           |
| Monero               | `@aquarian-metals/coin-moebius-monero`            | Crypto (self-hosted node, no third-party gateway)           |
| Manual / pay by mail | `@aquarian-metals/coin-moebius-manual`            | Off-rail confirmations (cash, check, Goldbacks, anything)   |

Two foundation packages back them:

- `@aquarian-metals/coin-moebius-core` — the payment-manager core (or install `@aquarian-metals/coin-moebius` for the friendly install name; same API, just a re-export).
- `@aquarian-metals/coin-moebius-server` — the server-side verifier registry that calls each provider's `./server` entry.

Want to add a provider? Copy `packages/providers/template` and ship it as `@your-name/coin-moebius-<rail>`.

---

## Quick Start (in 3 minutes)

### Install (browser)

Install **core** (same API whether you use the short name or the explicit package; pick one):

```bash
npm install @aquarian-metals/coin-moebius
```

That only installs the router core—**no** Stripe, Cryptomus, NOWPayments, or server webhook code.

In your own `package.json`, use a semver range (for example `^0.1.0-beta.1` while this line is in beta) instead of `*`, so installs stay predictable.

Add **only the providers** you need, for example Stripe on the client:

```bash
npm install @aquarian-metals/coin-moebius-stripe
```

Or install core by its explicit name plus a provider:

```bash
npm install @aquarian-metals/coin-moebius-core @aquarian-metals/coin-moebius-stripe
```

### Install (server / serverless functions)

> ⚠️ **Browser bundles must not include any of these.** The `-server` package and every provider's `./server` subpath import Node built-ins (`crypto`, etc.) and will break Vite/Rollup if they end up on the client. Install and import them **only** inside your serverless functions or Node project.

```bash
npm install @aquarian-metals/coin-moebius-server
```

For each provider whose webhooks you verify, you'll already have its package installed from the browser side — the same package exposes a `./server` entry. A few providers also need their official server SDK installed alongside:

```bash
npm install stripe   # only if you verify Stripe webhooks
```

Cryptomus has no separate server SDK; the verifier uses Node's built-in `crypto`.

### 1. The Frontend (Browser)

Initialize the manager in your Vite/Next/Astro app. Feed it your providers, and tell it what to do when someone successfully pays.

```typescript
import createCryptomusProvider from '@aquarian-metals/coin-moebius-cryptomus';
import { createNowPaymentsProvider } from '@aquarian-metals/coin-moebius-nowpayments';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';
import createStripeProvider from '@aquarian-metals/coin-moebius-stripe';

const payments = createPaymentManager({
  providers: [
    createStripeProvider({ publishableKey: import.meta.env.VITE_STRIPE_KEY }),
    // Cryptomus' API key holds spend authority on your merchant account, so it
    // can never live in the browser. The provider posts to a serverless function
    // you control (default: /.netlify/functions/create-cryptomus-payment) — see §2.
    createCryptomusProvider(),
    // NOWPayments — same shape: the browser calls a serverless endpoint of
    // yours, which forwards to NOWPayments with your API key. `payCurrency`
    // is optional; omit it to let the buyer pick the coin on NOWPayments'
    // hosted page.
    createNowPaymentsProvider({
      checkoutEndpoint: '/.netlify/functions/create-nowpayments-payment',
    }),
  ],
});

// The single source of truth for fulfillment
payments.onSuccess((result) => {
  console.log(`PAID with ${result.provider}!`, result);
  // Unlock the download, fire the confetti, update the DB.
});
```

Trigger it from your own beautiful, custom UI:

```typescript
// For Fiat
document.getElementById('buy-stripe').onclick = () => {
  payments.initiate({ productId: 'ebook-42', amount: 19.99, currency: 'USD' });
};

// For Crypto
document.getElementById('buy-crypto').onclick = () => {
  payments.initiate({ productId: 'ebook-42', amount: 0.12, currency: 'XMR', providerId: 'cryptomus' });
};
```

### 2. The Backend (Serverless Webhooks)

You need two tiny serverless functions: one **webhook** that any provider can POST to, and one **create-payment** function per provider that holds API keys (Stripe-style hosted checkout, or Cryptomus's signed create call). The browser never sees your secrets.

```javascript
// e.g., netlify/functions/payment-webhook.js
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createStripeVerifier } from '@aquarian-metals/coin-moebius-stripe/server';
import { createCryptomusVerifier } from '@aquarian-metals/coin-moebius-cryptomus/server';
import { createNowPaymentsVerifier } from '@aquarian-metals/coin-moebius-nowpayments/server';

// One registry per consumer, registered once at module load.
const verifiers = createVerifierRegistry();
verifiers.register('stripe', createStripeVerifier({ endpointSecret: process.env.STRIPE_WEBHOOK_SECRET }));
verifiers.register(
  'cryptomus',
  createCryptomusVerifier({
    merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID,
    paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY,
  }),
);
verifiers.register('nowpayments', createNowPaymentsVerifier({ ipnSecret: process.env.NOWPAYMENTS_IPN_SECRET }));

export default async function handler(req) {
  // Boom. Verified, standardized payload.
  const result = await verifiers.verify(req.body, req.headers);

  if (result.status === 'success') {
    // Fulfill the order
  }
  return { statusCode: 200 };
}
```

```javascript
// e.g., netlify/functions/create-cryptomus-payment.js
import { createCryptomusCreator } from '@aquarian-metals/coin-moebius-cryptomus/server';

const create = createCryptomusCreator({
  merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID,
  paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY,
  callbackUrl: `${process.env.URL}/.netlify/functions/payment-webhook`,
  returnUrl: `${process.env.URL}/success`,
});

export default async function handler(req) {
  const { productId, amount, metadata } = JSON.parse(req.body);
  const result = await create({ productId, amount, metadata });
  return { statusCode: 200, body: JSON.stringify(result) };
}
```

Stripe has its own equivalent (`create-stripe-session`) that you'd write against the official Stripe SDK — see `examples/static-site-demo/netlify/functions/create-stripe-session.js`.

---

## The Architecture

```text
Your UI → initiate() → Provider → User Pays → Webhook → verify() → SUCCESS

```

For delayed payments (like Monero block confirmations), the SDK handles the pending gap automatically. Just point `subscribeToStatus` at a tiny serverless endpoint, and it polls until the webhook confirms the cash is in the bag. Check out the `examples/static-site-demo` folder for the full copy-paste setup.

---

## 🚨 CAUTION: Dragons Ahead 🚨

**Never import `@aquarian-metals/coin-moebius-server` or any provider’s `./server` entry (for example `@aquarian-metals/coin-moebius-stripe/server`) into your browser bundle.** Those modules are for Node / serverless signature verification. In the browser, import **only** `@aquarian-metals/coin-moebius` (core) and the **non-**`server` entry of each provider package you installed. If your Vite build fails with missing Node built-ins, you imported webhook code on the client—move it to your functions API only.

---

## Build the Ecosystem

Gateway APIs change constantly. We maintain the core, Stripe, and Cryptomus reference implementations so you have a gold standard to copy.

We expect the community to build the rest. Want to accept Solana, Lightning, or Zano?

1. Copy `packages/providers/template`.
2. Write a frontend `initiate()` and a backend `server.ts` verifier.
3. Publish it to npm as `@your-name/coin-moebius-zano`.

---

## Documentation

- **[STABILITY.md](./STABILITY.md)** — what's frozen at 1.0 versus what may still evolve. Read before integrating against a `0.x` release.
- **[MIGRATION.md](./MIGRATION.md)** — recipe-format upgrade guide between SDK versions.
- **[CHANGELOG.md](./CHANGELOG.md)** — the formal record of changes per release.
- **[docs/integration-stripe.md](./docs/integration-stripe.md)** — end-to-end walkthrough for accepting Stripe payments, including Stripe Dashboard setup, environment variables, deployment notes, and common failure modes.
- **[docs/subscriptions.md](./docs/subscriptions.md)** — how the SDK handles recurring billing on fiat providers. Covers the five normalized event types, the pass-through model, and the `getStripePortalUrl` helper for cancellation.
- **[docs/accessibility.md](./docs/accessibility.md)** — the `<coin-moebius-buy>` button's WCAG 2.1 AA support, what's shared with the site owner (custom color contrast, icon-only labels), and the formal conformance report (VPAT).
- **API reference** — generated from TSDoc via `npm run docs` → `docs/api/index.html`.
