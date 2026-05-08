# Coin Moebius demo

Plain HTML + Vite dev server + Netlify Functions examples (`netlify/functions/`).

Environment variables for functions (Netlify / hosting dashboard):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `CRYPTOMUS_MERCHANT_UUID`, `CRYPTOMUS_PAYMENT_API_KEY`

Frontend (Vite): `VITE_STRIPE_PUBLISHABLE_KEY`. The Cryptomus client provider no longer takes any keys — its serverless function (`create-cryptomus-payment`) holds the merchant UUID + payment API key.

**Do not import `@aquarian-metals/coin-moebius-server` or any `@aquarian-metals/coin-moebius-*/server` entry from browser code** — use `subscribeToStatus` + `payment-status` only.
