# Coin Moebius demo

Plain HTML + Vite dev server + Netlify Functions examples (`netlify/functions/`).

Environment variables for functions (Netlify / hosting dashboard):

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `CRYPTOMUS_MERCHANT_UUID`, `CRYPTOMUS_PAYMENT_API_KEY`

Frontend (Vite): `VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_CRYPTOMUS_*` as in `main.ts`.

**Do not import `@coin-moebius/server` from browser code** — use `subscribeToStatus` + `payment-status` only.
