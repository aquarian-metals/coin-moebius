# Self-hosted Zano

Take payments in ZANO, and in Freedom Dollar (fUSD, a coin on Zano that stays at one US dollar), straight into a wallet you control. No payment company sits in the middle. Nobody can hold your money, freeze it, or take a cut.

You will run three programs on a server and add two small pieces of code to your website. Once it is running, you do nothing day to day.

## How it works, start to finish

1. A buyer clicks "Pay with Freedom Dollar" on your site.
2. Your site asks your wallet for a fresh payment address. Zano can build an order number into an address, so every checkout gets its own. Zano calls this number a **payment id**.
3. The buyer sees the address, the exact amount, and a link that opens their Zano wallet with everything filled in. They pay from their own wallet.
4. Every 30 seconds, a small program on your server checks your wallet for new payments. Zano people call this program the **indexer**, and that is what the file is called. When it sees a payment carrying one of your order numbers, in the right kind of money, it counts how many blocks the network has added after it. Zano adds a block about once a minute. After ten blocks the payment cannot be undone, and the indexer treats the order as paid.
5. The indexer sends your website a signed message that says "order X is paid". A message like this, sent from one program to a web address, is called a **webhook**. Your site marks the order paid and unlocks the download.

The buyer's page checks in with your site every few seconds, so they see "paid" without refreshing.

## What you need

- A server running Linux with Node.js 18 or newer. A rented virtual server is fine.
- Room for the Zano ledger, which is the full record of every Zano transaction. It is over 20 GB and growing. Put it on an SSD. Zano says a spinning hard drive or a network drive makes it slow and unreliable.
- Memory and CPU. Zano's own guide for businesses asks for 16 GB of memory plus 16 GB of swap and 4 CPU cores. Plan on that.
- Or skip the ledger. Your wallet can use someone else's node (a computer that keeps the ledger) instead of your own. Then your server holds only the wallet. Your keys stay on your server either way. The other node only sees your internet address and how often you check in. Zano runs a public node at `37.27.100.59:10500` for trying things out, with no promise it stays up. For a real shop, run your own node or rent a private one.

## Step 1: install Zano

Download the Full Wallet for your platform from [zano.org/downloads](https://zano.org/downloads). On Linux it is one file (an AppImage) that contains the two programs you need: `zanod`, the node, and `simplewallet`, the wallet. You can also build them from the source code at [github.com/hyle-team/zano](https://github.com/hyle-team/zano). Zano publishes no official Docker image; a community one at [github.com/canardleteer/zano-docker](https://github.com/canardleteer/zano-docker) builds both programs from source.

Use a current release. Zano changed how payments carry order numbers in August 2026 (its "hard fork 6"), and only current wallets read the new format.

## Step 2: start the node

The node downloads the Zano ledger and keeps it up to date. Your wallet reads from it.

```bash
zanod \
  --data-dir /var/lib/zano \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port 11211 \
  --no-console \
  --disable-upnp \
  --log-file /var/log/zano/zanod.log
```

What each line does:

- `--data-dir` is where the ledger is stored.
- `--rpc-bind-ip 127.0.0.1` means only programs on this same machine can talk to the node. Leave it that way.
- `--rpc-bind-port 11211` is the door your wallet will knock on. 11211 is Zano's default.
- `--no-console` lets it run in the background with nobody typing at it.
- `--disable-upnp` stops it from opening ports on your router by itself.

The first start downloads a snapshot of the ledger and then catches up on the rest. Expect a few hours.

## Step 3: create your wallet on a safe computer, then make a "look but don't spend" copy

Do this on a computer you trust, not on the server. Start the wallet program and type these commands into it:

```bash
simplewallet --generate-new-wallet /secure/shop.wallet
# it asks you to set a password, then shows your recovery words. Write them down and keep them offline.
address           # shows your public address. It starts with Zx.
save_watch_only /secure/shop-watch.wallet WATCH_PASSWORD
exit
```

`save_watch_only` makes a second wallet file that can see every payment and hand out addresses, but cannot send money. Zano calls it a **watch-only** wallet. That is the only file you copy to the server. If someone breaks into your server, they can see what you were paid and nothing more. Your real wallet and your recovery words stay off the server.

Zano also offers an "auditable" wallet type. Do not use it here. It gives up privacy that a normal wallet keeps.

## Step 4: run the wallet in the background

On the server, start the watch-only wallet so it runs quietly and answers questions from programs on the same machine:

```bash
simplewallet \
  --wallet-file /var/lib/zano/shop-watch.wallet \
  --password "$ZANO_WALLET_PASSWORD" \
  --daemon-address 127.0.0.1:11211 \
  --rpc-bind-ip 127.0.0.1 \
  --rpc-bind-port 11212 \
  --jwt-secret "$ZANO_WALLET_JWT_SECRET" \
  --log-file /var/log/zano/wallet.log
```

What each line does:

- `--wallet-file` is the watch-only file from step 3.
- `--password` is that file's password. Put it in an environment file that only this user can read, so it is not typed into a service file in the open.
- `--daemon-address` is which node to use. Here it is the node from step 2. To use someone else's node instead, put its address here.
- `--rpc-bind-ip 127.0.0.1` and `--rpc-bind-port 11212` mean the wallet answers only programs on this machine, at door 11212.
- `--jwt-secret` is a password that any program must present before the wallet answers it. Since 2026 the wallet refuses to start without one. You will give the same value to your website's checkout code and to the indexer, and they take care of presenting it. The only other way to start the wallet is `--unsecure-no-auth`, which means no password at all. Do not use that.

The wallet also downloads Zano's list of known coins when it starts. Freedom Dollar is on that list. Leave that alone (do not add `--no-white-list`).

Never let the wallet answer the open internet. If the indexer runs on a different machine on a private network, bind the wallet to that private address and keep the password on.

## Step 5: make two secrets and write down your settings

You need two random secrets:

```bash
openssl rand -hex 32   # secret 1: the wallet password for programs (ZANO_WALLET_JWT_SECRET)
openssl rand -hex 32   # secret 2: signs the "order paid" messages (ZANO_HMAC_SECRET)
```

Secret 1 is the value from step 4. Secret 2 is how your website tells a real "order paid" message from a fake one: the indexer signs every message with it, and your site checks the signature. The two sides must have the same value or no message ever gets through.

These are the settings each piece needs. They are passed as environment variables, which are named values a program reads when it starts.

| Setting                       | Who needs it                               | What to put                                                                                |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `ZANO_WALLET_RPC_URL`         | Checkout code, indexer                     | `http://127.0.0.1:11212` (the wallet's door from step 4)                                   |
| `ZANO_WALLET_JWT_SECRET`      | Wallet (`--jwt-secret`), checkout, indexer | Secret 1                                                                                   |
| `ZANO_HMAC_SECRET`            | Indexer, webhook code                      | Secret 2                                                                                   |
| `ZANO_WEBHOOK_URL`            | Indexer                                    | The web address of your webhook code, like `https://your-site.example/api/payment-webhook` |
| `ZANO_REQUIRED_CONFIRMATIONS` | Indexer                                    | `10`. How many blocks must follow a payment before it counts.                              |
| `ZANO_POLL_INTERVAL_MS`       | Indexer                                    | `30000`. How often the indexer checks the wallet, in thousandths of a second.              |

## Step 6: add two small pieces of code to your website

Website hosts run small pieces of code on demand. Netlify, Cloudflare, and Vercel call them functions. You add two.

**The checkout code.** The buyer's browser calls this when they click pay. It asks your wallet for a fresh address and sends back what the buyer needs to see.

```js
// /api/checkout/zano
import { createZanoCreator, FREEDOM_DOLLAR_ASSET_ID } from '@aquarian-metals/coin-moebius-zano/server';
import { myStore } from './store.js';

const create = createZanoCreator({
  walletRpcUrl: process.env.ZANO_WALLET_RPC_URL,
  jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
  store: myStore,
  expiryMinutes: 15,
  rate: async (currency, asset) => {
    if (asset.assetId === FREEDOM_DOLLAR_ASSET_ID && currency === 'USD') return 1;
    return 1 / (await zanoPriceIn(currency)); // your own price source
  },
});

export default async (req) => {
  const { productId, amount, currency, assetId, metadata } = await req.json();
  return Response.json(await create({ productId, amount, currency, assetId, metadata }));
};
```

Two things in here are yours to decide:

- `store` is where your orders live. Any database works. It only needs to save an order and look one up by id. A stand-in that keeps orders in memory ships with the SDK for trying things out; it forgets everything when the program restarts, so use a real database for a real shop.
- `rate` answers "how many of this coin is one unit of my price?" For a price in US dollars paid in Freedom Dollar, the answer is 1. For a price in dollars paid in ZANO, you look up the ZANO price wherever you trust and return one divided by it. Coin Moebius does not pick a price source for you.

This code needs to reach your wallet. If your website host cannot reach a wallet on a private server, run just this one piece of code on the same server as the wallet, and have the buyer's browser call it there. The other piece can stay on your website host.

**The webhook code.** The indexer calls this with the "order paid" message. It checks the signature, saves the new status, and does whatever "paid" means for you.

```js
// /api/payment-webhook
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createZanoVerifier } from '@aquarian-metals/coin-moebius-zano/server';
import { myStore } from './store.js';

const verifiers = createVerifierRegistry();
verifiers.register('zano', createZanoVerifier({ hmacSecret: process.env.ZANO_HMAC_SECRET }).verify);

export default async (req) => {
  const result = await verifiers.verify(await req.text(), Object.fromEntries(req.headers));
  if (!result) return new Response('', { status: 200 });
  await myStore.upsert({ ...result, createdAt: result.timestamp, updatedAt: Date.now() });
  if (result.status === 'success') await fulfill(result);
  return new Response('', { status: 200 });
};
```

Make `fulfill` safe to run twice for the same order. The indexer can resend a message after a restart, and every payment system in the world does the same.

You also need the small read-only piece every Coin Moebius provider uses, `/api/payment-status`, which looks an order up so the buyer's page can ask "paid yet?". The example folder has it.

## Step 7: start the indexer

The indexer is the program that checks your wallet and sends the "order paid" messages. It runs on the server next to the wallet.

```js
// indexer.js
import { createZanoIndexer } from '@aquarian-metals/coin-moebius-zano/server';
import { myStore } from './store.js';

const indexer = createZanoIndexer({
  walletRpcUrl: process.env.ZANO_WALLET_RPC_URL,
  jwtSecret: process.env.ZANO_WALLET_JWT_SECRET,
  store: myStore,
  webhookUrl: process.env.ZANO_WEBHOOK_URL,
  hmacSecret: process.env.ZANO_HMAC_SECRET,
  requiredConfirmations: Number(process.env.ZANO_REQUIRED_CONFIRMATIONS ?? 10),
  pollIntervalMs: Number(process.env.ZANO_POLL_INTERVAL_MS ?? 30_000),
});

const stop = indexer.start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

```bash
npm install @aquarian-metals/coin-moebius-zano @aquarian-metals/coin-moebius-server
node indexer.js
```

To keep it running after you log out and restart it if it crashes, install it as a system service. A ready-made service file is at `examples/static-site-demo/zano/zano-indexer.service`; edit the paths and secrets, copy it into `/etc/systemd/system/`, and turn it on.

If the indexer is down for an hour, nothing is lost. When it comes back it looks at everything that arrived while it was away and sends the messages then. Buyers just see "waiting" a little longer.

**Orders nobody pays.** An order expires 15 minutes after checkout. Your wallet does not remember which order numbers it handed out, so only your order database knows which orders are still waiting. If your database can list the waiting orders (an optional method called `listPending`; the built-in memory store has it), the indexer marks unpaid orders failed once they expire. If it cannot, paid orders still work exactly the same; unpaid ones just stay marked as waiting.

## Step 8: put the buttons on your page

```ts
import { createZanoProvider, FREEDOM_DOLLAR_ASSET_ID } from '@aquarian-metals/coin-moebius-zano';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createZanoProvider({ statusEndpoint: '/api/payment-status' }),
    createZanoProvider({
      id: 'fusd',
      name: 'Freedom Dollar',
      assetId: FREEDOM_DOLLAR_ASSET_ID,
      statusEndpoint: '/api/payment-status',
    }),
  ],
});

buyWithZano.onclick = () =>
  payments.initiate({ providerId: 'zano', productId: 'ebook', amount: 19.99, currency: 'USD' });
buyWithFusd.onclick = () =>
  payments.initiate({ providerId: 'fusd', productId: 'ebook', amount: 19.99, currency: 'USD' });

payments.onPending((r) =>
  payments.subscribeToStatus(r.paymentId, { statusEndpoint: '/api/payment-status', onSuccess: unlock }),
);
```

One button per kind of money. The first pays in ZANO, the second in Freedom Dollar. When a buyer clicks, a box appears with the address, the exact amount, a reminder to send only that coin, and the link that opens their wallet. Most sites replace the box with their own design and add a QR code; the SDK lets you swap it out.

## Freedom Dollar, specifically

| Fact          | Value                                                                        |
| ------------- | ---------------------------------------------------------------------------- |
| Id            | `86143388bd056a8f0bab669f78f14873fac8e2dd8d57898cdb725a2d5e2e4f8f`           |
| Ticker        | `fUSD`                                                                       |
| Smallest unit | One ten-thousandth (four decimal places)                                     |
| Price         | Aims at one US dollar. Check your own price source if a cent matters to you. |

Every kind of money on Zano has a long id like this. Names and tickers can be copied by anyone; the id cannot. So the SDK works from the id. It is exported as `FREEDOM_DOLLAR_ASSET_ID` so you never type it.

You never have to tell the SDK how many decimal places a coin has. At checkout it asks your wallet, and the wallet answers from the chain. That same question is also what makes your wallet notice incoming Freedom Dollar. Any other coin on Zano works the same way: pass its id and nothing else changes.

**If the buyer sends the wrong coin.** One Zano address accepts every kind of coin, and a wallet that ignores the link's coin choice sends ZANO by default. So a buyer can send ZANO to a Freedom Dollar order. The indexer never counts it toward the order, and the order stays open.

Read the next part carefully, because it decides whether you hear about it. Wrong-coin money on its own sends no message. The indexer writes a warning to your logger and waits, because from the chain's side nothing has happened to the order yet. What arrived is named on the **next** message that order does send, under `otherAssets`, which means you only see it once the right coin turns up as well. An order that only ever receives the wrong coin stays open and stays quiet.

So watch your indexer's log for `payment received in an asset that was not invoiced`. That line is the only signal you get at the time, and it carries the payment id you need to refund or reach out.

**Amounts.** Prices are rounded up to the coin's smallest unit, so you are never a fraction short.

## The payment link

The checkout code gives the buyer a link in the form Zano documents:

```text
zano:action=send&address=<the address for this order>&amount=19.99&asset_id=<the coin's id>
```

The Zano desktop wallet opens it with the payment filled in. The Zano mobile wallet reads it from a QR code too, along with two other link styles Zano has used over the years. Put the same text in your QR code.

## Bigger setups

- **One person.** One server runs the node, the wallet, and the indexer. Messages go out to your website host.
- **A small business.** A private network. The node on a machine with the big disk, the wallet on a small machine that only the private network can reach, the indexer next to it. The Docker Compose file in the example folder is one way to lay this out.
- **Larger.** One wallet file can only be open in one program at a time, so run one wallet and one indexer. Give the indexer a health page that shows `indexer.status()`. If you ever run more than one indexer, give your database a `markStatusAnnounced` method so an order is announced exactly once. Keep the real wallet on a machine that is never online, and move money out of the receiving wallet on a schedule.

## If something goes wrong

| What you see                                                                | What it means and what to do                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallet-rpc … refused the request (401)`                                    | The wallet wants its password and the checkout code or indexer did not give the same one. Make `ZANO_WALLET_JWT_SECRET` match `--jwt-secret`. |
| The wallet quits at start saying running without `--jwt-secret` is insecure | Add `--jwt-secret`. (Or `--unsecure-no-auth`, which turns the password off. Do not.)                                                          |
| `asset … is not on the chain the wallet is connected to`                    | The node does not know that coin id. Wrong id, or the node is on Zano's test network.                                                         |
| Payments sit at 0 confirmations for a long time                             | The wallet or the node has fallen behind. Compare the wallet's height with a public Zano explorer.                                            |
| Freedom Dollar payments never show up                                       | The wallet was started with `--no-white-list` and never learned the coin. Remove that flag.                                                   |
| The order is still waiting but the buyer says they paid                     | Search your indexer's log for `an asset that was not invoiced`. They probably sent ZANO to a Freedom Dollar order, or the other way round.    |
| Old unpaid orders never become "failed"                                     | Your database has no `listPending`. Add it, or accept that unpaid orders stay marked as waiting.                                              |
| The wallet errors on new transactions                                       | The wallet is older than Zano's August 2026 update. Install a current release.                                                                |

## Optional: Docker

`examples/static-site-demo/zano/docker-compose.yml` starts the node, the wallet, and the indexer as containers. It expects an image you built yourself from the community Dockerfile, since there is no official one, and it pins nothing on your behalf. You own the upgrades.

## Where this comes from

- Zano's guide for exchanges: <https://docs.zano.org/docs/build/exchange-guidelines/multi-assets-custody-guide/>
- Running the wallet in the background: <https://docs.zano.org/docs/build/rpc-api/wallet-rpc/>
- Payment links: <https://docs.zano.org/docs/build/deeplinks>
- Installing and using the command-line wallet: <https://docs.zano.org/docs/use/wallets/install-zano-cli-wallet-ubuntu/>
- Zano's source code: <https://github.com/hyle-team/zano>
- Freedom Dollar: <https://www.freedomdollar.com/>
- The August 2026 update: <https://blog.zano.org/the-countdown-to-hard-fork-6-has-begun/>
