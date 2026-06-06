# Coin Moebius — static-site demo

A working, locally-runnable demo of the SDK against three providers: Stripe (hosted checkout), Cryptomus (hosted crypto gateway), and self-hosted Monero.

The Stripe and Cryptomus integrations talk to their real APIs (so you'll need test keys to exercise them end-to-end). The Monero integration runs entirely offline by default through an in-process mock of `monero-wallet-rpc` — point it at a real wallet by toggling one env var.

> **NOWPayments is not in this demo.** It's redirect-based (like Stripe) and requires webhook forwarding back to localhost, which adds friction without teaching anything the Stripe tile doesn't already cover. See `packages/providers/nowpayments/README.md` for integration patterns.

## How it works

```
┌────────────────────────────────────────────────────────────────────┐
│                  npm run dev   (single Vite process)               │
│                                                                    │
│   index.html ──► main.ts ──► coin-moebius browser providers        │
│                                  │                                 │
│       POST /api/checkout/*  ◄────┘                                 │
│       POST /api/payment-webhook                                    │
│       GET  /api/payment-status                                     │
│       POST /api/mock/pay-monero   (mock mode only)                 │
│                  │                                                 │
│                  ▼                                                 │
│   vite-plugin-dev-api ──► dev-api/*.js handlers                    │
│                                  │                                 │
│                       shared in-memory PaymentStore                │
│                                  ▲                                 │
│         monero-indexer.js  ──────┘ (ticks every 1s, posts          │
│                                     signed webhooks back to        │
│                                     /api/payment-webhook)          │
└────────────────────────────────────────────────────────────────────┘
```

Every file under `dev-api/` corresponds 1:1 to "what you'd deploy as its own serverless function" in production. The Vite plugin (`vite-plugin-dev-api.js`) is the demo-only glue.

## Run the Monero flow (no external setup)

```bash
cd examples/static-site-demo
MONERO_MOCK=true npm run dev
```

Open `http://localhost:5173`, click **Pay with Monero (self-hosted)**, and you'll see a freshly minted subaddress + exact XMR amount + `monero:` URI. Click **Simulate buyer payment (mock mode)** to inject a matching transfer into the simulated wallet; the in-process indexer ticks immediately, fires the HMAC-signed webhook to `/api/payment-webhook`, and the status polling loop flips the UI to **Payment confirmed**.

The mock wallet RPC implements just enough of the real one (`create_address`, `get_height`, `get_address`, `get_transfers`) for the demo to be honest about the flow — it's not a fake `onSuccess` button hidden behind chrome.

## Run the Monero flow against a real `monero-wallet-rpc`

```bash
MONERO_WALLET_RPC_URL=http://localhost:18083/json_rpc \
MONERO_HMAC_SECRET=$(openssl rand -hex 32) \
MONERO_WEBHOOK_URL=http://localhost:5173/api/payment-webhook \
npm run dev
```

With `MONERO_MOCK` unset, the creator and the indexer both talk to your wallet at `MONERO_WALLET_RPC_URL`. Production deployments should also bump `requiredConfirmations` back to the package default (10) — see `packages/providers/monero/README.md`.

## Run the Stripe flow

```bash
STRIPE_SECRET_KEY=sk_test_… \
STRIPE_WEBHOOK_SECRET=whsec_… \
npm run dev

# In a second terminal, forward Stripe events to localhost:
stripe listen --forward-to localhost:5173/api/payment-webhook
```

The Stripe redirect lands the buyer on `http://localhost:5173/?status=success` after they pay; override with `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` if you mount the demo elsewhere.

## Run the Cryptomus flow

```bash
CRYPTOMUS_MERCHANT_UUID=… \
CRYPTOMUS_PAYMENT_API_KEY=… \
CRYPTOMUS_CALLBACK_URL=https://your-ngrok-host/api/payment-webhook \
npm run dev
```

Cryptomus posts the webhook to a public URL, so you'll need ngrok / cloudflared in front of `localhost:5173` for the status loop to converge.

## Files

| Path                                       | What it is                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `index.html`, `main.ts`                    | The browser side.                                                                        |
| `vite.config.js`, `vite-plugin-dev-api.js` | Vite config + plugin that mounts `dev-api/*.js` as middleware.                           |
| `dev-api/_shared.js`                       | Process-wide singletons (store + verifier registry).                                     |
| `dev-api/checkout-stripe.js`               | `POST /api/checkout/stripe` — create a Stripe Checkout Session.                          |
| `dev-api/checkout-cryptomus.js`            | `POST /api/checkout/cryptomus` — create a Cryptomus invoice.                             |
| `dev-api/checkout-monero.js`               | `POST /api/checkout/monero` — mint a Monero subaddress.                                  |
| `dev-api/payment-webhook.js`               | `POST /api/payment-webhook` — dispatch to the matching verifier.                         |
| `dev-api/payment-status.js`                | `GET /api/payment-status` — read-through to the store.                                   |
| `dev-api/monero-indexer.js`                | Boots `createMoneroIndexer`. Also serves `/api/mock/pay-monero` in mock mode.            |
| `dev-api/mock-wallet-rpc.js`               | In-process simulator for `monero-wallet-rpc`.                                            |
| `monero/`                                  | A separate, real-mode Monero indexer deployment example (systemd unit + Docker Compose). |

## Important

Never import `@aquarian-metals/coin-moebius-*/server` from browser code (`main.ts`). The `dev-api/` handlers are the only place server entries are loaded.
