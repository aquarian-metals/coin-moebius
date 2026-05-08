# ♾️ Coin Moebius

**The headless, zero-UI payment router for static sites.**

Turn Stripe, Monero, Zano, gold escrow, or literally anything else into a single, boring `onSuccess` callback.

Static sites (JAMstack) are fast and cheap. But the second you want to accept money, you're forced to either rent a heavy, locked-in storefront (Gumroad, Payhip) or hand-roll a spaghetti monster of different webhooks for every gateway.

**Coin Moebius fixes this.** It gives you a WordPress-style plugin ecosystem for static site checkouts. You keep 100% control of your UI and fulfillment logic. We just normalize the *"they paid"* signal.

---

## What makes it magic?

* **Zero Opinion UI:** We don't care what your buy button looks like. Build your own frontend.
* **One Universal Callback:** Whether they paid with a Visa via Stripe or Monero, your fulfillment code runs exactly the same way.
* **Tiny Core:** We stripped the heavy stuff out. Only install the providers you actually use.
* **Safe by Default:** A strict boundary between the browser (`core`) and your serverless webhooks (`server`).

---

## Quick Start (in 3 minutes)

Install the core:

```bash
npm install @coin-moebius/core

```

Or if you want to use both Stripe and Cryptomus, you can install both together or separately.

```bash
npm install @coin-moebius/core @coin-moebius/stripe @coin-moebius/monero-cryptomus
```


### 1. The Frontend (Browser)

Initialize the manager in your Vite/Next/Astro app. Feed it your providers, and tell it what to do when someone successfully pays.

```typescript
import { createPaymentManager } from '@coin-moebius/core';
import createStripeProvider from '@coin-moebius/stripe';
import createMoneroProvider from '@coin-moebius/monero-cryptomus';

const payments = createPaymentManager({
  providers: [
    createStripeProvider({ publishableKey: import.meta.env.VITE_STRIPE_KEY }),
    createMoneroProvider({
      apiKey: import.meta.env.VITE_CRYPTOMUS_KEY,
      merchantUuid: import.meta.env.VITE_CRYPTOMUS_MERCHANT,
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
  payments.initiate({ productId: 'ebook-42', amount: 0.12, currency: 'XMR', providerId: 'monero-cryptomus' });
};

```

### 2. The Backend (Serverless Webhooks)

You only need a single webhook to handle every provider. Coin Moebius swallows the messy gateway payloads and spits out our clean, standardized `PaymentResult`.

```javascript
// e.g., netlify/functions/payment-webhook.js
import { verify, registerVerifier } from '@coin-moebius/server';
import { createStripeVerifier } from '@coin-moebius/stripe/server';
import { createCryptomusVerifier } from '@coin-moebius/monero-cryptomus/server';

// Register verifiers once
registerVerifier('stripe', createStripeVerifier({ endpointSecret: process.env.STRIPE_SECRET }));
registerVerifier('monero-cryptomus', createCryptomusVerifier({ /* secrets */ }));

export default async function handler(req) {
  // Boom. Verified, standardized payload.
  const result = await verify(req.body, req.headers); 
  
  if (result.status === 'success') {
     // Fulfill the order
  }
  return { statusCode: 200 };
}

```

---

## The Architecture

```text
Your UI → initiate() → Provider → User Pays → Webhook → verify() → SUCCESS

```

For delayed payments (like Monero block confirmations), the SDK handles the pending gap automatically. Just point `subscribeToStatus` at a tiny serverless endpoint, and it polls until the webhook confirms the cash is in the bag. Check out the `examples/static-site-demo` folder for the full copy-paste setup.

---

## 🚨 CAUTION: Dragons Ahead 🚨

**Never import `@coin-moebius/server` into your browser bundle.** The server package contains Node crypto dependencies for checking signatures. Keep `core` in the browser, and `server` in your Netlify/Vercel/etc functions. If your Vite build explodes, you probably imported a server verifier on the frontend.

---

## Build the Ecosystem

Gateway APIs change constantly. We maintain the core, Stripe, and Cryptomus reference implementations so you have a gold standard to copy.

We expect the community to build the rest. Want to accept Solana, Lightning, or Zano?

1. Copy `packages/providers/template`.
2. Write a frontend `initiate()` and a backend `server.ts` verifier.
3. Publish it to npm as `@your-name/coin-moebius-zano`.