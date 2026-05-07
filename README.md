# Coin Moebius

**A tiny, open-source JavaScript SDK that turns any payment method into a clean black-box “paid” key for static sites.**

Stripe/Authorize.net, Cryptocurrency, gold/silver escrow, barter... all treated identically.  
No forced UI, no vendor lock-in. Use small serverless endpoints for secure verification (same pattern as Stripe + JAMstack).

---

## Why Coin Moebius?

Static/JAMstack sites are fast and cheap, but adding real payments has always meant choosing between:

- Hosted platforms that lock you in (Payhip, Gumroad, etc.)
- One-off hacks per gateway

**Coin Moebius** is a **plugin-style ecosystem** for payments on Netlify, Vercel, Cloudflare Pages, Astro, etc.

You keep control of your UI and fulfillment logic. The library normalizes the “they paid” signal.

---

## Features

- Small client-side core
- Pluggable providers as separate packages (`@coin-moebius/stripe`, `@coin-moebius/monero-cryptomus`, …)
- One standardized `PaymentResult` for every payment method
- Instant (Stripe) and delayed (crypto) flows via `pending` / `success`
- Pending UX: poll a tiny `payment-status` endpoint — **never import `@coin-moebius/server` in browser bundles**
- Single webhook entrypoint pattern with `verify` + registered verifiers
- Works with Netlify Functions, Vercel, Cloudflare Workers, etc.

---

## Monorepo layout

- `packages/core` — `createPaymentManager`, types, client `subscribeToStatus` (polls `statusEndpoint`)
- `packages/server` — `registerVerifier`, `verify`, `createStatusSubscriber`, `createSupabaseStore`
- `packages/providers/template` — starter provider + script loader
- `packages/providers/stripe` — Stripe Checkout client + `createStripeVerifier`
- `packages/providers/monero-cryptomus` — Cryptomus client stub + `createCryptomusVerifier`
- `examples/static-site-demo` — HTML demo + Netlify function examples

---

## Quick start

### 1. Install (workspace / local monorepo)

```bash
npm install
npm run build
```

### 2. Frontend

```bash
cd examples/static-site-demo
npm run dev
```

```typescript
import { createPaymentManager } from '@coin-moebius/core';
import createStripeProvider from '@coin-moebius/stripe';
import createMoneroCryptomusProvider from '@coin-moebius/monero-cryptomus';

const payments = createPaymentManager({
	providers: [
		createStripeProvider({ publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY }),
		createMoneroCryptomusProvider({
			apiKey: import.meta.env.VITE_CRYPTOMUS_API_KEY,
			merchantUuid: import.meta.env.VITE_CRYPTOMUS_MERCHANT_UUID,
		}),
	],
});

payments.onSuccess((result) => {
	console.log('PAID', result);
});
```

### 3. Trigger from your own UI

```typescript
payments.initiate({
	productId: 'ebook-42',
	amount: 19.99,
	currency: 'USD',
	metadata: { email: buyerEmail },
});

payments.initiate({
	productId: 'ebook-42',
	amount: 0.12,
	currency: 'XMR',
	providerId: 'monero-cryptomus',
});
```

### Required serverless examples

See `examples/static-site-demo/netlify/functions/`:

- `create-stripe-session` — Stripe Checkout session (Stripe only)
- `payment-webhook` — verify + upsert store
- `payment-status` — public read for `subscribeToStatus` polling

Supabase DDL: `examples/static-site-demo/supabase-schema.sql`.

---

## Architecture

Your custom UI  
→ `payments.initiate()` → provider  
→ gateway → your webhook → `verify()` → `PaymentResult`  
→ your fulfillment code (same shape for every provider)

---

## Adding a new provider

1. Copy `packages/providers/template`
2. Implement client `initiate()` and server verifier (export from `server.ts`)
3. `npm publish`

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Roadmap (from original draft)

- Core + Stripe + Monero-Cryptomus (this repo)
- Supabase Realtime subscriber (optional alternative to polling)
- Community providers (Zano, Lightning, gold-escrow)
- CLI to scaffold providers

---

## Implementation notes

- Import server-only verifiers from `@coin-moebius/stripe/server` and `@coin-moebius/monero-cryptomus/server`, not from the browser bundle entrypoints (keeps `node:crypto` out of Vite/webpack clients).
- The Cryptomus client snippet signs requests per Cryptomus merchant docs; the placeholder sign field must be replaced before production use.

---

## License

MIT © 2026

Made for indie creators who want static sites to accept money — any way they want.
