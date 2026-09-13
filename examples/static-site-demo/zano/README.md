# Self-hosted Zano: example deployment

A working Zano and Freedom Dollar checkout using `@aquarian-metals/coin-moebius-zano`. Two pieces:

1. **Two small pieces of code for your website**: `create-zano-payment.js` and `payment-webhook.js`. Deploy them the same way you deploy the rest of your Netlify, Cloudflare, or Vercel functions.
2. **The indexer**, a small program that keeps running: `indexer.js`. It sits next to your Zano wallet, checks it for new payments, and tells your website when an order is paid.

The full walkthrough, from an empty server to a paid order, is [`docs/self-hosted-zano.md`](../../../docs/self-hosted-zano.md). Read that first. This page is the short version.

## Before you start

- A Zano node (`zanod`), or the address of someone else's node your wallet can use.
- Your wallet running in the background (`simplewallet`), loaded with the **watch-only** copy that can see payments but cannot spend, and started with `--jwt-secret`.
- Node.js 18 or newer for the indexer.

## How the pieces connect

```text
Browser → /api/checkout/zano             (asks your wallet for a fresh address; your code)
       → a box with the address, the amount, and the coin

Buyer's wallet → the Zano network        (you don't see this)

your wallet ← indexer.js                 (checks every 30 seconds, on your server)
       indexer.js → /api/payment-webhook (a signed "order paid" message, over HTTPS)
                  → your order database says `success`
       The buyer's page asks /api/payment-status and sees it
                  → onSuccess runs in the buyer's browser
```

## 1. Start the wallet in the background

```bash
simplewallet \
  --wallet-file /var/lib/zano/shop-watch.wallet \
  --password "$ZANO_WALLET_PASSWORD" \
  --daemon-address 127.0.0.1:11211 \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port 11212 \
  --jwt-secret "$ZANO_WALLET_JWT_SECRET"
```

The wallet will not start without `--jwt-secret`, the password other programs must present to it. Keep `--rpc-bind-ip 127.0.0.1` so only programs on this machine can reach the wallet.

## 2. Make the two secrets

```bash
openssl rand -hex 32   # → ZANO_HMAC_SECRET: signs the "order paid" messages. Indexer and webhook code both need it.
openssl rand -hex 32   # → ZANO_WALLET_JWT_SECRET: the wallet's password for programs. Wallet, checkout code, and indexer all need it.
```

## 3. Deploy the two pieces of website code

Copy `create-zano-payment.js` and `payment-webhook.js` into your `netlify/functions/` folder (or `app/api/`, or wherever your host puts them). Set these on your website host:

| Setting                  | What to put                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ZANO_HMAC_SECRET`       | Same value as the indexer                                                                                                                                     |
| `ZANO_WALLET_RPC_URL`    | Only `create-zano-payment.js` uses it. If your website host cannot reach the wallet over a private network, run that one file on the wallet's server instead. |
| `ZANO_WALLET_JWT_SECRET` | Same value the wallet was started with                                                                                                                        |

## 4. Start the indexer

```bash
npm install @aquarian-metals/coin-moebius-zano @aquarian-metals/coin-moebius-server

export ZANO_WALLET_RPC_URL=http://127.0.0.1:11212
export ZANO_WALLET_JWT_SECRET=<from step 2>
export ZANO_WEBHOOK_URL=https://your-site.example/api/payment-webhook
export ZANO_HMAC_SECRET=<from step 2>

node indexer.js
```

To keep it running after you log out, install it as a system service: put `zano-indexer.service` in `/etc/systemd/system/`, edit the paths and secrets, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now zano-indexer
sudo journalctl -u zano-indexer -f
```

## 5. Check it end to end

1. Open your site, click "Pay with Freedom Dollar," and see the box with an address and `19.99 fUSD`.
2. Send exactly that amount of fUSD from a Zano wallet, using the link or the QR code.
3. Watch `journalctl -u zano-indexer -f`. Within about ten minutes it sends the "order paid" message.
4. The buyer's page flips to paid and the download unlocks.

## Optional: Docker

`docker-compose.yml` in this folder starts the node, the wallet, and the indexer as containers. Zano publishes no official image, so build one from the community Dockerfile first:

```bash
git clone https://github.com/canardleteer/zano-docker && cd zano-docker && docker build -t zano-runner .
```

Then, back in this folder:

```bash
docker compose up -d
docker compose logs -f indexer
```

Keep in mind:

- **You own the images.** Rebuild when Zano ships a release or a security fix. Coin Moebius does not publish an indexer image.
- **Back up the folders.** The compose file keeps the ledger (20+ GB) in `./zano-data` and the wallet in `./wallet-data`.
- **Make the watch-only wallet first.** Create the real wallet on a computer that stays offline, run `save_watch_only`, and put the watch-only file in `./wallet-data` before starting.

## What lives where

| File                     | Goes where                                    | What it does                                                                       |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `create-zano-payment.js` | Your website host (or the wallet's server)    | Takes the buyer's checkout request, asks the wallet for an address, sends it back. |
| `payment-webhook.js`     | Your website host                             | Receives the signed "order paid" message, checks it, saves the new status.         |
| `indexer.js`             | The server next to your wallet                | The program that keeps checking the wallet.                                        |
| `_store.js`              | Both                                          | A stand-in for your real order database.                                           |
| `zano-indexer.service`   | `/etc/systemd/system/` on the wallet's server | Keeps `node indexer.js` running as a service.                                      |
| `docker-compose.yml`     | Anywhere with Docker                          | Optional all-in-one start.                                                         |
