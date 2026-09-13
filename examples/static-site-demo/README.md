# Coin Moebius — static-site demo

A working, locally-runnable demo of the SDK against four providers: Stripe (hosted checkout), Cryptomus (hosted crypto gateway), self-hosted Monero, and self-hosted Zano (ZANO and Freedom Dollar).

The Stripe and Cryptomus integrations talk to their real APIs (so you'll need test keys to exercise them end-to-end). The Monero and Zano integrations run entirely offline by default through in-process mocks of `monero-wallet-rpc` and `simplewallet`; point either at a real wallet by toggling one env var.

> **NOWPayments is not in this demo.** It's redirect-based (like Stripe) and requires webhook forwarding back to localhost, which adds friction without teaching anything the Stripe tile doesn't already cover. See `packages/providers/nowpayments/README.md` for integration patterns.

## How it works

```
┌────────────────────────────────────────────────────────────────────┐
│                  npm run dev   (single Vite process)               │
│                                                                    │
│   index.html ──► main.ts ──► coin-moebius browser providers        │
│                                  │                                 │
│       POST /api/checkout/*  ◄────┘                                 │
│       POST /api/payment-webhook/:provider                          │
│       GET  /api/payment-status                                     │
│       POST /api/mock/pay-monero   (mock mode only)                 │
│       POST /api/mock/pay-zano     (mock mode only)                 │
│                  │                                                 │
│                  ▼                                                 │
│   vite-plugin-dev-api ──► dev-api/*.js handlers                    │
│                                  │                                 │
│                       shared in-memory PaymentStore                │
│                                  ▲                                 │
│   monero-indexer.js, zano-indexer.js ─┘ (tick every 1s, post       │
│                                     signed webhooks back to        │
│                                     /api/payment-webhook/<id>)     │
└────────────────────────────────────────────────────────────────────┘
```

Every file under `dev-api/` corresponds 1:1 to "what you'd deploy as its own serverless function" in production. The Vite plugin (`vite-plugin-dev-api.js`) is the demo-only glue.

The webhook route carries the provider in its path (`/api/payment-webhook/monero`, `/api/payment-webhook/zano`, `/api/payment-webhook/stripe`, …). Once more than one verifier is registered, the SDK's registry refuses to pick a verifier from request data, so the URL path is where the provider id comes from.

## Run the Monero flow (no external setup)

```bash
cd examples/static-site-demo
MONERO_MOCK=true npm run dev
```

Open `http://localhost:5173`, click **Pay with Monero (self-hosted)**, and you'll see a freshly minted subaddress + exact XMR amount + `monero:` URI. Click **Simulate buyer payment (mock mode)** to inject a matching transfer into the simulated wallet; the in-process indexer ticks immediately, fires the HMAC-signed webhook to `/api/payment-webhook/monero`, and the status polling loop flips the UI to **Payment confirmed**.

The mock wallet RPC implements just enough of the real one (`create_address`, `get_height`, `get_address`, `get_transfers`) for the demo to be honest about the flow — it's not a fake `onSuccess` button hidden behind chrome.

## Run the Monero flow against a real `monero-wallet-rpc`

```bash
MONERO_WALLET_RPC_URL=http://localhost:18083/json_rpc \
MONERO_HMAC_SECRET=$(openssl rand -hex 32) \
MONERO_WEBHOOK_URL=http://localhost:5173/api/payment-webhook/monero \
npm run dev
```

With `MONERO_MOCK` unset, the creator and the indexer both talk to your wallet at `MONERO_WALLET_RPC_URL`. Production deployments should also bump `requiredConfirmations` back to the package default (10) — see `packages/providers/monero/README.md`.

## Run the Zano and Freedom Dollar flow (no external setup)

```bash
cd examples/static-site-demo
ZANO_MOCK=true npm run dev
```

Open `http://localhost:5173`, click **Pay with Freedom Dollar (self-hosted)**, and you'll see a freshly minted integrated address, `19.99 fUSD`, and a `zano:` link naming the asset. Click **Simulate buyer payment (mock mode)** to inject a matching transfer into the simulated wallet; the in-process indexer ticks, fires the HMAC-signed webhook to `/api/payment-webhook/zano`, and the status polling loop flips the UI to **Payment confirmed**. The **Pay with Zano** tile does the same in ZANO.

The mock wallet implements just enough of `simplewallet`'s RPC (`assets_whitelist_add`, `make_integrated_address`, `get_recent_txs_and_info3`) for the demo to be honest about the flow.

## Run the Zano flow against a real `simplewallet`

```bash
ZANO_WALLET_RPC_URL=http://127.0.0.1:11212 \
ZANO_WALLET_JWT_SECRET=<the wallet's --jwt-secret> \
ZANO_HMAC_SECRET=$(openssl rand -hex 32) \
ZANO_WEBHOOK_URL=http://localhost:5173/api/payment-webhook/zano \
npm run dev
```

With `ZANO_MOCK` unset, the creator and the indexer both talk to your wallet. Production deployments should bump `requiredConfirmations` back to the package default (10); see `docs/self-hosted-zano.md`.

## Run the Stripe flow

```bash
STRIPE_SECRET_KEY=sk_test_… \
STRIPE_WEBHOOK_SECRET=whsec_… \
npm run dev

# In a second terminal, forward Stripe events to localhost:
stripe listen --forward-to localhost:5173/api/payment-webhook/stripe
```

The Stripe redirect lands the buyer on `http://localhost:5173/?status=success` after they pay; override with `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` if you mount the demo elsewhere.

## Run the Cryptomus flow

```bash
CRYPTOMUS_MERCHANT_UUID=… \
CRYPTOMUS_PAYMENT_API_KEY=… \
CRYPTOMUS_CALLBACK_URL=https://your-ngrok-host/api/payment-webhook/cryptomus \
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
| `dev-api/checkout-zano.js`                 | `POST /api/checkout/zano` — mint a Zano integrated address, in ZANO or fUSD.             |
| `dev-api/payment-webhook.js`               | `POST /api/payment-webhook/:provider` — dispatch to the verifier named in the path.      |
| `dev-api/payment-status.js`                | `GET /api/payment-status` — read-through to the store.                                   |
| `dev-api/monero-indexer.js`                | Boots `createMoneroIndexer`. Also serves `/api/mock/pay-monero` in mock mode.            |
| `dev-api/mock-wallet-rpc.js`               | In-process simulator for `monero-wallet-rpc`.                                            |
| `dev-api/zano-indexer.js`                  | Boots `createZanoIndexer`. Also serves `/api/mock/pay-zano` in mock mode.                |
| `dev-api/mock-zano-wallet-rpc.js`          | In-process simulator for `simplewallet` in RPC mode.                                     |
| `monero/`                                  | A separate, real-mode Monero indexer deployment example (systemd unit + Docker Compose). |
| `zano/`                                    | A separate, real-mode Zano indexer deployment example (systemd unit + Docker Compose).   |

## Important

Never import `@aquarian-metals/coin-moebius-*/server` from browser code (`main.ts`). The `dev-api/` handlers are the only place server entries are loaded.
