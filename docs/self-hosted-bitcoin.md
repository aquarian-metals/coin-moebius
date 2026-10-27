# Self-hosted Bitcoin

Take payments in bitcoin straight into a wallet you control. No payment company sits in the middle. Nobody can hold your money, freeze it, or take a cut.

You will run Bitcoin Core and one small program on a server, and add two small pieces of code to your website. Once it is running, you do nothing day to day.

## How it works, start to finish

1. A buyer clicks "Pay with Bitcoin" on your site.
2. Your site asks your Bitcoin Core wallet for a brand-new address. Every checkout gets its own address, and the wallet writes the order number on it as a **label**.
3. The buyer sees the address, the exact amount, and a link that opens their Bitcoin wallet with everything filled in. They pay from their own wallet.
4. Every 30 seconds, a small program on your server checks your wallet for new payments. This program is called the **indexer**, and that is what the file is called. When money lands on one of your labeled addresses, it waits until the payment is in a block. Bitcoin adds a block about every ten minutes. Once the payment is in a block, it cannot be swapped for a different payment, and the indexer treats the order as paid.
5. The indexer sends your website a signed message that says "order X is paid". A message like this, sent from one program to a web address, is called a **webhook**. Your site marks the order paid and unlocks the download.

The buyer's page checks in with your site every few seconds, so they see "paid" without refreshing. While the payment waits for its block, the indexer also sends "seen, waiting for a block" messages, so the buyer is not left staring at nothing.

## What you need

- A server with Node.js 18 or newer. A rented virtual server is fine.
- Bitcoin Core, version 28 or newer.
- Disk space. The first start downloads and checks the whole Bitcoin ledger, which is the full record of every Bitcoin transaction. With pruning turned on (step 2), the node throws old blocks away as it goes and keeps only the newest ones, so it needs far less room afterward. Your shop wallet only ever looks at new payments, so a pruned node is all it needs.
- Your recovery words kept somewhere that is not the server.

## Step 1: install Bitcoin Core

Download it from [bitcoincore.org/en/download](https://bitcoincore.org/en/download/). On a Mac, `brew install bitcoin` also works. You get `bitcoind`, the node, and `bitcoin-cli`, the program you type commands into.

## Step 2: start the node

Put these lines in the node's settings file, `bitcoin.conf`. It lives in `~/.bitcoin/` on Linux and `~/Library/Application Support/Bitcoin/` on a Mac.

```ini
server=1
prune=550
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcuser=shop
rpcpassword=<a long random password>
```

What each line does:

- `server=1` lets other programs on this machine ask the node questions.
- `prune=550` keeps only the newest blocks on disk, about 550 MB of them, once they have been checked.
- `rpcbind=127.0.0.1` and `rpcallowip=127.0.0.1` mean only programs on this same machine can talk to the node. Leave it that way.
- `rpcuser` and `rpcpassword` are the name and password other programs must give. Make the password with `openssl rand -hex 32`.

Then start it:

```bash
bitcoind -daemon
```

The first start takes a long time, because the node checks every block since 2009. Watch its progress with `bitcoin-cli getblockchaininfo`. It is done when `verificationprogress` is close to `1` and `blocks` matches `headers`.

## Step 3: make your keys on a safe computer

Do this on a computer you trust, not on the server. Bitcoin Core works for this too, and it never needs to download the ledger to make keys:

```bash
bitcoin-cli createwallet keys
bitcoin-cli -rpcwallet=keys listdescriptors
```

`createwallet` makes a new wallet. Back it up the way you back up any Bitcoin wallet, and keep the backup offline.

`listdescriptors` prints the wallet's **descriptors**. A descriptor is one line of text that tells a wallet how to find every address your keys can make. Find the entry that starts with `wpkh(` and says `"internal": false`. It looks like this:

```text
wpkh([1027cc8d/84h/0h/0h]xpub6C.../0/*)#a6glsrp3
```

Copy that whole line, the part after `#` included. It holds only your **public** key. Anyone with it can see payments and make addresses, and nobody can spend with it. That is the only thing that goes to the server.

Any other wallet that can show you its descriptor works the same way. Use the one for native SegWit addresses (the ones that start with `bc1q`).

## Step 4: make the shop wallet on the server

On the server, make a wallet that can watch but never spend, and give it the line from step 3:

```bash
bitcoin-cli -named createwallet wallet_name=shop disable_private_keys=true blank=true load_on_startup=true

bitcoin-cli -rpcwallet=shop importdescriptors '[{
  "desc": "wpkh([1027cc8d/84h/0h/0h]xpub6C.../0/*)#a6glsrp3",
  "active": true,
  "range": [0, 999],
  "timestamp": "now"
}]'
```

What the settings mean:

- `disable_private_keys=true` makes this a **watch-only** wallet. There are no spending keys in it at all. If someone breaks into your server, they can see what you were paid and nothing more.
- `load_on_startup=true` opens the wallet every time the node starts.
- `"active": true` lets the wallet hand out new addresses from your key.
- `"timestamp": "now"` tells the wallet there is no older history to look for, which is what a pruned node needs.

Check it works:

```bash
bitcoin-cli -rpcwallet=shop getnewaddress
```

You should get a `bc1q…` address, and the same address should appear in the wallet you made in step 3.

## Step 5: make a secret and write down your settings

You need one random secret:

```bash
openssl rand -hex 32   # signs the "order paid" messages (BITCOIN_HMAC_SECRET)
```

This is how your website tells a real "order paid" message from a fake one: the indexer signs every message with it, and your site checks the signature. The two sides must have the same value or no message ever gets through.

These are the settings each piece needs. They are passed as environment variables, which are named values a program reads when it starts.

| Setting                          | Who needs it           | What to put                                                                                |
| -------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `BITCOIN_RPC_URL`                | Checkout code, indexer | `http://127.0.0.1:8332` (the node's door; 8332 is Bitcoin's default)                       |
| `BITCOIN_WALLET`                 | Checkout code, indexer | `shop`                                                                                     |
| `BITCOIN_RPC_USER`               | Checkout code, indexer | The `rpcuser` from step 2                                                                  |
| `BITCOIN_RPC_PASSWORD`           | Checkout code, indexer | The `rpcpassword` from step 2                                                              |
| `BITCOIN_HMAC_SECRET`            | Indexer, webhook code  | The secret above                                                                           |
| `BITCOIN_WEBHOOK_URL`            | Indexer                | The web address of your webhook code, like `https://your-site.example/api/payment-webhook` |
| `BITCOIN_REQUIRED_CONFIRMATIONS` | Indexer                | `1`. How many blocks must hold a payment before it counts. Raise it for bigger sales.      |
| `BITCOIN_POLL_INTERVAL_MS`       | Indexer                | `30000`. How often the indexer checks the wallet, in thousandths of a second.              |

## Step 6: add two small pieces of code to your website

Website hosts run small pieces of code on demand. Netlify, Cloudflare, and Vercel call them functions. You add two.

**The checkout code.** The buyer's browser calls this when they click pay. It asks your wallet for a fresh address and sends back what the buyer needs to see.

```js
// /api/checkout/bitcoin
import { createBitcoinCreator } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myStore } from './store.js';

const create = createBitcoinCreator({
  rpcUrl: process.env.BITCOIN_RPC_URL,
  wallet: process.env.BITCOIN_WALLET,
  rpcUser: process.env.BITCOIN_RPC_USER,
  rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
  store: myStore,
  expiryMinutes: 15,
  btcPerUnit: async (currency) => 1 / (await bitcoinPriceIn(currency)), // your own price source
});

export default async (req) => {
  const { productId, metadata } = await req.json();
  const price = await priceOf(productId); // from your own product list, e.g. { amount: 19.99, currency: 'USD' }
  if (!price) return new Response('Unknown product', { status: 404 });
  return Response.json(await create({ productId, ...price, metadata }));
};
```

Three things in here are yours to decide:

- `priceOf` looks the price up in your own product list. **Never take the price from the buyer's browser.** The browser runs on the buyer's computer, so a buyer can change the amount it sends to anything, and you would ship the product for a fraction of a cent.
- `store` is where your orders live. Any database works. It only needs to save an order and look one up by id. A stand-in that keeps orders in memory ships with the SDK for trying things out; it forgets everything when the program restarts, so use a real database for a real shop.
- `btcPerUnit` answers "how much bitcoin is one unit of my price?" For a price in US dollars, you look up the bitcoin price wherever you trust and return one divided by it. A price already in `BTC` needs no lookup. Coin Moebius does not pick a price source for you.

This code needs to reach your node. If your website host cannot reach a node on a private server, run just this one piece of code on the same server as the node, and have the buyer's browser call it there. The other piece can stay on your website host.

**The webhook code.** The indexer calls this with the "order paid" message. It checks the signature, saves the new status, and does whatever "paid" means for you.

```js
// /api/payment-webhook
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createBitcoinVerifier } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myStore } from './store.js';

const verifiers = createVerifierRegistry();
verifiers.register('bitcoin', createBitcoinVerifier({ hmacSecret: process.env.BITCOIN_HMAC_SECRET }).verify);

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

The indexer is the program that checks your wallet and sends the "order paid" messages. It runs on the server next to the node.

```js
// indexer.js
import { createBitcoinIndexer } from '@aquarian-metals/coin-moebius-bitcoin/server';
import { myStore } from './store.js';

const indexer = createBitcoinIndexer({
  rpcUrl: process.env.BITCOIN_RPC_URL,
  wallet: process.env.BITCOIN_WALLET,
  rpcUser: process.env.BITCOIN_RPC_USER,
  rpcPassword: process.env.BITCOIN_RPC_PASSWORD,
  store: myStore,
  webhookUrl: process.env.BITCOIN_WEBHOOK_URL,
  hmacSecret: process.env.BITCOIN_HMAC_SECRET,
  requiredConfirmations: Number(process.env.BITCOIN_REQUIRED_CONFIRMATIONS ?? 1),
  pollIntervalMs: Number(process.env.BITCOIN_POLL_INTERVAL_MS ?? 30_000),
});

const stop = indexer.start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

```bash
npm install @aquarian-metals/coin-moebius-bitcoin @aquarian-metals/coin-moebius-server
node indexer.js
```

To keep it running after you log out and restart it if it crashes, install it as a system service. A ready-made service file is at `examples/static-site-demo/bitcoin/bitcoin-indexer.service`; edit the paths and secrets, copy it into `/etc/systemd/system/`, and turn it on.

If the indexer is down for a while, nothing is lost. When it comes back it looks back about a day of blocks (`scanLookbackBlocks`, 144 by default) and sends the messages it missed. Buyers just see "waiting" a little longer.

**Orders nobody pays.** An order expires 15 minutes after checkout. Your wallet does not know which addresses are still waiting, so only your order database does. If your database can list the waiting orders (an optional method called `listPending`; the built-in memory store has it), the indexer marks unpaid orders failed once they expire. Before it does, it asks the node one more time whether anything ever reached that address, so a payment is never reported missing. If your database cannot list waiting orders, paid orders still work exactly the same; unpaid ones just stay marked as waiting.

**Money that arrives late** still counts. A buyer whose payment lands after the order expired gets their order, instead of being told to pay again.

## Step 8: put the button on your page

```ts
import { createBitcoinProvider } from '@aquarian-metals/coin-moebius-bitcoin';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [createBitcoinProvider({ statusEndpoint: '/api/payment-status' })],
});

buyWithBitcoin.onclick = () =>
  payments.initiate({ providerId: 'bitcoin', productId: 'ebook', amount: 19.99, currency: 'USD' });

payments.onPending((r) =>
  payments.subscribeToStatus(r.paymentId, { statusEndpoint: '/api/payment-status', onSuccess: unlock }),
);
```

When a buyer clicks, a box appears with the address, the exact amount, a reminder to send on the Bitcoin network, and the link that opens their wallet. Most sites replace the box with their own design and add a QR code; the SDK lets you swap it out.

## The payment link

The checkout code gives the buyer a link in the standard Bitcoin form (BIP 21):

```text
bitcoin:bc1q…?amount=0.00020583
```

Desktop and phone wallets open it with the payment filled in. Put the same text in your QR code.

**Amounts.** Prices are rounded up to six significant digits, and never finer than one satoshi (the smallest unit of bitcoin, one hundred-millionth). You are never a fraction short, and the buyer sees a number they can read.

**If the buyer sends too little,** the order is marked `partial` once the payment is in a block, and the message says exactly how much arrived. **If they send more than once to the same address,** every payment is added up.

## Restoring your wallet somewhere else

Each checkout uses the next address from your key, whether the buyer pays or not. So a run of unpaid checkouts leaves a run of empty addresses. Some phone wallets stop looking after 20 empty addresses in a row (this is called the **gap limit**), and would not show money that arrived further along. If you restore your recovery words in another wallet and payments seem to be missing, raise that wallet's gap limit, or restore them in Bitcoin Core, which looks much further ahead.

## Bigger setups

- **One person.** One server runs the node and the indexer. Messages go out to your website host.
- **A small business.** A private network. The node on a machine with a big disk, the indexer next to it. The Docker Compose file in the example folder is one way to lay this out.
- **Larger.** Run one indexer. Give it a health page that shows `indexer.status()`. If you ever run more than one, give your database a `markStatusAnnounced` method so an order is announced exactly once. Keep your recovery words on a computer that is never online.

## If something goes wrong

| What you see                                                   | What it means and what to do                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node refused getnewaddress (401)`                             | The name or password does not match `rpcuser` and `rpcpassword` in `bitcoin.conf`.                                                                    |
| `Requested wallet does not exist or is not loaded`             | `BITCOIN_WALLET` names a wallet the node has not opened. Run `bitcoin-cli loadwallet shop`, and make sure you created it with `load_on_startup=true`. |
| `Error: This wallet has no available keys`                     | The descriptor was not imported, or was imported without `"active": true`. Repeat step 4.                                                             |
| Payments sit at 0 confirmations for a long time                | The buyer paid a low fee, or the node has fallen behind. Compare `bitcoin-cli getblockcount` with a public block explorer.                            |
| `money reached an expired invoice outside the lookback window` | The indexer was down longer than `scanLookbackBlocks` covers. Raise it and restart the indexer, and the order settles on the next check.              |
| Old unpaid orders never become "failed"                        | Your database has no `listPending`. Add it, or accept that unpaid orders stay marked as waiting.                                                      |

## Trying it without real money

Bitcoin Core has a private test mode called **regtest**. It starts an empty ledger that lives only on your computer, so there is nothing to download, and you make new blocks yourself with one command. Every step above works the same way in regtest, and addresses start with `bcrt1` instead of `bc1`.

```bash
bitcoind -regtest -daemon
bitcoin-cli -regtest createwallet buyer
bitcoin-cli -regtest -rpcwallet=buyer -generate 101         # gives the buyer wallet test coins
bitcoin-cli -regtest -rpcwallet=buyer sendtoaddress <address from your checkout> 0.0002
bitcoin-cli -regtest -rpcwallet=buyer -generate 1           # puts the payment in a block
```

In regtest the node's door is `18443` instead of `8332`. Make the shop wallet the same way as in steps 3 and 4.

## Optional: Docker

`examples/static-site-demo/bitcoin/docker-compose.yml` starts the node and the indexer as containers. It uses `bitcoin/bitcoin`, a community image built from the official release files, not one the Bitcoin Core project publishes. Pin the version you checked, and move it forward yourself. You own the upgrades.

## Where this comes from

- Bitcoin Core downloads: <https://bitcoincore.org/en/download/>
- Bitcoin Core's command reference: <https://bitcoincore.org/en/doc/>
- Descriptors: <https://github.com/bitcoin/bitcoin/blob/master/doc/descriptors.md>
- Pruning and other node settings: <https://github.com/bitcoin/bitcoin/blob/master/doc/bitcoin-conf.md>
- The `bitcoin:` link format (BIP 21): <https://github.com/bitcoin/bips/blob/master/bip-0021.mediawiki>
