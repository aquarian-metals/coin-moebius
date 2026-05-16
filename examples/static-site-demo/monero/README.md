# Self-hosted Monero — example deployment

End-to-end Monero checkout using `@aquarian-metals/coin-moebius-monero`. Two pieces:

1. **Serverless functions** (your existing site) — `create-monero-payment.js`, `payment-webhook.js`. Deploy these the same way you deploy the rest of your Netlify/Cloudflare/Vercel functions.
2. **A long-running indexer** (a small Node process) — `indexer.js`. Runs next to your `monero-wallet-rpc`, watches the chain, posts webhooks to your `payment-webhook` endpoint when payments confirm.

This README covers the no-Docker setup first (the primary path for most merchants). Docker compose is shown at the end as an optional shortcut for people who already live in containers.

## Prerequisites

You need a box (VPS, dedicated server, home server) that can run:

- `monerod` — the Monero daemon. Either a full node (~250 GB pruned) or pointed at a public remote node. Both work for **receiving** payments.
- `monero-wallet-rpc` — loaded with your **view-only wallet**. The spend key stays on a separate cold box and is used only to sweep funds out of the receiving wallet periodically. This separation means even total compromise of your hot box never moves your money.
- The indexer (Node 18+).

If you've never run `monerod` before, the [official getmonero.org docs](https://docs.getmonero.org/) are the canonical setup guide. The TL;DR: download the CLI tools, run `monerod --prune-blockchain --restricted-rpc`, wait for sync, create a wallet, export the view-only seed to your hot box.

## Wiring overview

```text
Browser → /api/checkout/monero          (mints a subaddress; you ship this)
       → modal with address + amount

Buyer's wallet → Monero blockchain      (you don't see this)

monero-wallet-rpc ← indexer.js          (polls every 30 seconds — locally)
       indexer.js → /api/payment-webhook (HTTPS, HMAC-signed)
                  → store updated to `success`
       Browser polling /api/payment-status sees the update
                  → onSuccess fires in the buyer's tab
```

## 1. Configure your wallet RPC

```bash
monero-wallet-rpc \
  --wallet-file /var/lib/monero/view-only.wallet \
  --password-file /var/lib/monero/wallet.password \
  --daemon-address 127.0.0.1:18081 \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port 18083 \
  --disable-rpc-login
```

`--disable-rpc-login` is acceptable because we're binding to 127.0.0.1; the only thing on the box that can talk to it is the indexer. If you bind to a private network interface (Tier 2/3), either keep `--disable-rpc-login` behind a VPC firewall, or front the wallet RPC with nginx that handles basic auth.

## 2. Add a shared HMAC secret

Generate one, write it to your env on both the indexer host and your serverless functions:

```bash
# On the indexer box and in your serverless function env:
openssl rand -hex 32
# → e.g. 7c2e4a92...   put this in MONERO_HMAC_SECRET on both sides.
```

The indexer signs every webhook with HMAC-SHA256 using this secret; the verifier in `payment-webhook.js` validates the signature. Different value on each side = no webhook ever delivers.

## 3. Deploy your serverless functions

Copy `create-monero-payment.js` and `payment-webhook.js` from this folder into your `netlify/functions/` (or `app/api/`, or wherever your framework puts handlers). Set env vars on the serverless host:

| Env var                 | Value                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONERO_HMAC_SECRET`    | Same value as the indexer                                                                                                                                                                                                                |
| `MONERO_WALLET_RPC_URL` | Used **only** by `create-monero-payment.js`. If your serverless functions can't reach wallet RPC over a private network, move the create-payment endpoint to a small VPS adjacent to wallet RPC and have the browser POST there instead. |

The create endpoint is the one part that needs wallet RPC access at request time. If your serverless functions are on Cloudflare and your wallet RPC is on a Hetzner VPS, the easiest pattern is to colocate `create-monero-payment` on the same VPS as the indexer (e.g. as a tiny Express/Hono server behind nginx) and only the `payment-webhook` and `payment-status` endpoints stay on your serverless host.

## 4. Run the indexer

```bash
# On the indexer box, in the same directory as indexer.js:
npm install @aquarian-metals/coin-moebius-monero @aquarian-metals/coin-moebius-server

export MONERO_WALLET_RPC_URL=http://localhost:18083
export MONERO_WEBHOOK_URL=https://your-site.example/api/payment-webhook
export MONERO_HMAC_SECRET=<the value from step 2>

node indexer.js
```

You should see periodic log lines as it ticks. Stop with Ctrl-C.

To run as a daemon, drop `monero-indexer.service` into `/etc/systemd/system/`, edit the paths and env, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now monero-indexer
sudo journalctl -u monero-indexer -f
```

## 5. (Optional) push-mode via `--tx-notify`

For lower latency than polling, also run:

```bash
monero-wallet-rpc \
  ...all the flags from step 1... \
  --tx-notify "/usr/bin/node /opt/coin-moebius/notify.js %s"
```

The polling loop continues as a backstop. `notify.js` fires the moment wallet RPC sees the tx; polling catches it once confirmations accumulate.

## 6. Verify end-to-end

1. Open your site, click "Buy with Monero," see the modal appear with an address.
2. Send the exact amount from a Monero wallet.
3. Watch `journalctl -u monero-indexer -f` — within ~20 minutes you should see a tick that POSTs a webhook.
4. The buyer's `onSuccess` should fire and the download should unlock.

## Docker shortcut (optional)

If you'd rather start everything as containers, `docker-compose.yml` in this folder boots `monerod`, `monero-wallet-rpc`, and the indexer with sensible defaults. Edit the env at the top, then:

```bash
docker compose up -d
docker compose logs -f indexer
```

Caveats:

- **You own the images.** This compose file pins specific tags; you are responsible for upgrading them when CVEs are announced. We deliberately do not publish a maintained Coin Moebius indexer image — that'd put us on the hook for Monero version drift.
- **Persistence.** The compose file mounts `./monero-data` for the chain and `./wallet-data` for the wallet. Back these up.
- **The view-only wallet still has to be created out-of-band.** Generate the spend wallet on a cold box, export the view-only seed, restore it into `./wallet-data` before starting the stack.

## What lives where

| File                       | Goes where                                         | What it does                                                                                  |
| -------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `create-monero-payment.js` | Your serverless host (or a small VPS — see step 3) | Receives the browser's checkout POST, calls `createMoneroCreator(...)`, returns instructions. |
| `payment-webhook.js`       | Your serverless host                               | Receives signed webhooks from the indexer, verifies them, persists status.                    |
| `indexer.js`               | Indexer box, next to `monero-wallet-rpc`           | The long-running polling daemon.                                                              |
| `notify.js`                | Indexer box                                        | Optional `--tx-notify` hook.                                                                  |
| `monero-indexer.service`   | `/etc/systemd/system/` on the indexer box          | systemd unit for `node indexer.js`.                                                           |
| `docker-compose.yml`       | Anywhere with Docker                               | Optional all-in-one boot.                                                                     |
