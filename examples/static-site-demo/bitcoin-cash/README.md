# Self-hosted Bitcoin Cash: example deployment

A working Bitcoin Cash checkout using `@aquarian-metals/coin-moebius-bitcoin-cash`. Two pieces:

1. **Two small pieces of code for your website**: `create-bitcoin-cash-payment.js` and `payment-webhook.js`. Deploy them the same way you deploy the rest of your Netlify, Cloudflare, or Vercel functions.
2. **The indexer**, a small program that keeps running: `indexer.js`. It sits next to your Bitcoin Cash Node, checks your wallet for new payments, and tells your website when an order is paid.

The full walkthrough, from an empty server to a paid order, is [`docs/self-hosted-bitcoin-cash.md`](../../../docs/self-hosted-bitcoin-cash.md). Read that first. This page is the short version.

## Before you start

- Bitcoin Cash Node (`bitcoind`) running with `server=1`, synced, and pruned if you like.
- A **watch-only** wallet in it, named `shop`. It can see payments, but cannot spend.
- Your wallet's extended public key (`xpub…`).
- Node.js 18 or newer for the indexer.

## How the pieces connect

```text
Browser → /api/checkout/bitcoin-cash     (works out a fresh address and has your node watch it; your code)
       → a box with the address and the exact amount

Buyer's wallet → the Bitcoin Cash network (you don't see this)

your node ← indexer.js                   (checks every 30 seconds, on your server)
       indexer.js → /api/payment-webhook (a signed "order paid" message, over HTTPS)
                  → your order database says `success`
       The buyer's page asks /api/payment-status and sees it
                  → onSuccess runs in the buyer's browser
```

## 1. Make the shop wallet

On the server:

```bash
bitcoin-cli -named createwallet wallet_name=shop disable_private_keys=true blank=true
```

Then add `wallet=shop` to `bitcoin.conf`, so the node opens it every time it starts.

## 2. Make the secret

```bash
openssl rand -hex 32   # → BCH_HMAC_SECRET: signs the "order paid" messages. Indexer and webhook code both need it.
```

## 3. Deploy the two pieces of website code

Copy `create-bitcoin-cash-payment.js` and `payment-webhook.js` into your `netlify/functions/` folder (or `app/api/`, or wherever your host puts them). Set these on your website host:

| Setting                            | What to put                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BCH_HMAC_SECRET`                  | Same value as the indexer                                                                                                                                         |
| `BCH_RPC_URL`                      | Only `create-bitcoin-cash-payment.js` uses it. If your website host cannot reach the node over a private network, run that one file on the node's server instead. |
| `BCH_WALLET`                       | `shop`                                                                                                                                                            |
| `BCH_RPC_USER`, `BCH_RPC_PASSWORD` | The `rpcuser` and `rpcpassword` from your `bitcoin.conf`                                                                                                          |
| `BCH_XPUB`                         | The extended public key from your wallet                                                                                                                          |

## 4. Start the indexer

```bash
npm install @aquarian-metals/coin-moebius-bitcoin-cash @aquarian-metals/coin-moebius-server

export BCH_RPC_URL=http://127.0.0.1:8332
export BCH_WALLET=shop
export BCH_RPC_USER=<from bitcoin.conf>
export BCH_RPC_PASSWORD=<from bitcoin.conf>
export BCH_WEBHOOK_URL=https://your-site.example/api/payment-webhook
export BCH_HMAC_SECRET=<from step 2>

node indexer.js
```

To keep it running after you log out, install it as a system service: put `bitcoin-cash-indexer.service` in `/etc/systemd/system/`, edit the paths and secrets, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bitcoin-cash-indexer
sudo journalctl -u bitcoin-cash-indexer -f
```

## 5. Check it end to end

1. Open your site, click "Pay with Bitcoin Cash," and see the box with an address and the amount in BCH.
2. Send exactly that amount from a Bitcoin Cash wallet, using the link or the QR code.
3. Watch `journalctl -u bitcoin-cash-indexer -f`. Within a minute it reports the payment as seen, and once the payment is six blocks deep it sends the "order paid" message.
4. The buyer's page flips to paid and the download unlocks.

To try all of this without real money, run Bitcoin Cash Node in regtest mode. See "Trying it without real money" in the full guide.

## Optional: Docker

`docker-compose.yml` in this folder starts the node and the indexer as containers, using the community `zquestz/bitcoin-cash-node` image.

```bash
docker compose up -d bitcoind
docker compose up -d indexer
docker compose logs -f indexer
```

Keep in mind:

- **You own the images.** Move the pinned version forward when Bitcoin Cash Node ships a release or a security fix. Coin Moebius does not publish an indexer image.
- **Back up the folder.** The compose file keeps the node's data, wallets included, in `./bitcoin-cash-data`.
- **Make the shop wallet after the node syncs**, with `docker compose exec bitcoind bitcoin-cli …` and the commands from step 1.

## What lives where

| File                             | Goes where                                  | What it does                                                                                    |
| -------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `create-bitcoin-cash-payment.js` | Your website host (or the node's server)    | Takes the buyer's checkout request, works out an address, has the node watch it, sends it back. |
| `payment-webhook.js`             | Your website host                           | Receives the signed "order paid" message, checks it, saves the new status.                      |
| `indexer.js`                     | The server next to your node                | The program that keeps checking the wallet.                                                     |
| `_store.js`                      | Both                                        | A stand-in for your real order database.                                                        |
| `bitcoin-cash-indexer.service`   | `/etc/systemd/system/` on the node's server | Keeps `node indexer.js` running as a service.                                                   |
| `docker-compose.yml`             | Anywhere with Docker                        | Optional all-in-one start.                                                                      |
