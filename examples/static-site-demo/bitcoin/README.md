# Self-hosted Bitcoin: example deployment

A working Bitcoin checkout using `@aquarian-metals/coin-moebius-bitcoin`. Two pieces:

1. **Two small pieces of code for your website**: `create-bitcoin-payment.js` and `payment-webhook.js`. Deploy them the same way you deploy the rest of your Netlify, Cloudflare, or Vercel functions.
2. **The indexer**, a small program that keeps running: `indexer.js`. It sits next to your Bitcoin Core node, checks your wallet for new payments, and tells your website when an order is paid.

The full walkthrough, from an empty server to a paid order, is [`docs/self-hosted-bitcoin.md`](../../../docs/self-hosted-bitcoin.md). Read that first. This page is the short version.

## Before you start

- Bitcoin Core (`bitcoind`) running with `server=1`, synced, and pruned if you like.
- A **watch-only** wallet in it, named `shop`, holding only your public key. It can see payments and hand out addresses, but cannot spend.
- Node.js 18 or newer for the indexer.

## How the pieces connect

```text
Browser → /api/checkout/bitcoin          (asks your wallet for a fresh address; your code)
       → a box with the address and the exact amount

Buyer's wallet → the Bitcoin network     (you don't see this)

your node ← indexer.js                   (checks every 30 seconds, on your server)
       indexer.js → /api/payment-webhook (a signed "order paid" message, over HTTPS)
                  → your order database says `success`
       The buyer's page asks /api/payment-status and sees it
                  → onSuccess runs in the buyer's browser
```

## 1. Make the shop wallet

On the server, with your public descriptor from a wallet on a safe computer:

```bash
bitcoin-cli -named createwallet wallet_name=shop disable_private_keys=true blank=true load_on_startup=true
bitcoin-cli -rpcwallet=shop importdescriptors '[{"desc":"wpkh([…]xpub…/0/*)#…","active":true,"range":[0,999],"timestamp":"now"}]'
```

## 2. Make the secret

```bash
openssl rand -hex 32   # → BITCOIN_HMAC_SECRET: signs the "order paid" messages. Indexer and webhook code both need it.
```

## 3. Deploy the two pieces of website code

Copy `create-bitcoin-payment.js` and `payment-webhook.js` into your `netlify/functions/` folder (or `app/api/`, or wherever your host puts them). Set these on your website host:

| Setting                                    | What to put                                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BITCOIN_HMAC_SECRET`                      | Same value as the indexer                                                                                                                                    |
| `BITCOIN_RPC_URL`                          | Only `create-bitcoin-payment.js` uses it. If your website host cannot reach the node over a private network, run that one file on the node's server instead. |
| `BITCOIN_WALLET`                           | `shop`                                                                                                                                                       |
| `BITCOIN_RPC_USER`, `BITCOIN_RPC_PASSWORD` | The `rpcuser` and `rpcpassword` from your `bitcoin.conf`                                                                                                     |

## 4. Start the indexer

```bash
npm install @aquarian-metals/coin-moebius-bitcoin @aquarian-metals/coin-moebius-server

export BITCOIN_RPC_URL=http://127.0.0.1:8332
export BITCOIN_WALLET=shop
export BITCOIN_RPC_USER=<from bitcoin.conf>
export BITCOIN_RPC_PASSWORD=<from bitcoin.conf>
export BITCOIN_WEBHOOK_URL=https://your-site.example/api/payment-webhook
export BITCOIN_HMAC_SECRET=<from step 2>

node indexer.js
```

To keep it running after you log out, install it as a system service: put `bitcoin-indexer.service` in `/etc/systemd/system/`, edit the paths and secrets, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bitcoin-indexer
sudo journalctl -u bitcoin-indexer -f
```

## 5. Check it end to end

1. Open your site, click "Pay with Bitcoin," and see the box with an address and the amount in BTC.
2. Send exactly that amount from a Bitcoin wallet, using the link or the QR code.
3. Watch `journalctl -u bitcoin-indexer -f`. Within a minute it reports the payment as seen, and once the payment is in a block it sends the "order paid" message.
4. The buyer's page flips to paid and the download unlocks.

To try all of this without real money, run Bitcoin Core in regtest mode. See "Trying it without real money" in the full guide.

## Optional: Docker

`docker-compose.yml` in this folder starts the node and the indexer as containers, using the community `bitcoin/bitcoin` image built from the official release files.

```bash
docker compose up -d bitcoind
docker compose up -d indexer
docker compose logs -f indexer
```

Keep in mind:

- **You own the images.** Move the pinned version forward when Bitcoin Core ships a release or a security fix. Coin Moebius does not publish an indexer image.
- **Back up the folder.** The compose file keeps the node's data, wallets included, in `./bitcoin-data`.
- **Make the shop wallet after the node syncs**, with `docker compose exec bitcoind bitcoin-cli …` and the commands from step 1.

## What lives where

| File                        | Goes where                                  | What it does                                                                       |
| --------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `create-bitcoin-payment.js` | Your website host (or the node's server)    | Takes the buyer's checkout request, asks the wallet for an address, sends it back. |
| `payment-webhook.js`        | Your website host                           | Receives the signed "order paid" message, checks it, saves the new status.         |
| `indexer.js`                | The server next to your node                | The program that keeps checking the wallet.                                        |
| `_store.js`                 | Both                                        | A stand-in for your real order database.                                           |
| `bitcoin-indexer.service`   | `/etc/systemd/system/` on the node's server | Keeps `node indexer.js` running as a service.                                      |
| `docker-compose.yml`        | Anywhere with Docker                        | Optional all-in-one start.                                                         |
