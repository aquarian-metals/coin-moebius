# Self-hosted Bitcoin Cash

Take payments in bitcoin cash straight into a wallet you control. No payment company sits in the middle. Nobody can hold your money, freeze it, or take a cut.

You will run Bitcoin Cash Node and one small program on a server, and add two small pieces of code to your website. Once it is running, you do nothing day to day.

## How it works, start to finish

1. A buyer clicks "Pay with Bitcoin Cash" on your site.
2. Your site works out a brand-new address from your wallet's public key and asks your node to watch it. Every checkout gets its own address, and the node writes the order number on it as a **label**.
3. The buyer sees the address, the exact amount, and a link that opens their Bitcoin Cash wallet with everything filled in. They pay from their own wallet.
4. Every 30 seconds, a small program on your server checks your node for new payments. This program is called the **indexer**, and that is what the file is called. The moment money lands on one of your labeled addresses, the indexer reports it as seen. It then waits until the payment is six blocks deep. Bitcoin Cash adds a block about every ten minutes. Once the payment is six blocks deep, the indexer treats the order as paid.
5. The indexer sends your website a signed message that says "order X is paid". A message like this, sent from one program to a web address, is called a **webhook**. Your site marks the order paid and unlocks the download.

The buyer's page checks in with your site every few seconds, so they see "paid" without refreshing. While the payment waits for its blocks, the indexer also sends "seen, waiting for blocks" messages, so the buyer is not left staring at nothing.

## What you need

- A server with Node.js 18 or newer. A rented virtual server is fine.
- Bitcoin Cash Node. Use a current release.
- Disk space. The first start downloads and checks the whole Bitcoin Cash ledger, which is the full record of every Bitcoin Cash transaction. With pruning turned on (step 2), the node throws old blocks away as it goes and keeps only the newest ones, so it needs far less room afterward. Your shop wallet only ever looks at new payments, so a pruned node is all it needs.
- A wallet that shows its extended public key.
- Your recovery words kept somewhere that is not the server.

## Step 1: install Bitcoin Cash Node

Download it from [bitcoincashnode.org](https://bitcoincashnode.org). You get `bitcoind`, the node, and `bitcoin-cli`, the program you type commands into.

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

## Step 3: make your keys in your own wallet

Do this in a wallet you trust, not on the server. Create a new wallet, and back it up the way you back up any Bitcoin Cash wallet, with the backup kept offline.

Then find the wallet's **extended public key**. It is one line of text that starts with `xpub` and tells a program how to find every receiving address your keys can make. Use the one for the wallet's main account (`m/44'/145'/0'`). It holds only your **public** key. Anyone with it can see payments and make addresses, and nobody can spend with it. That is the only thing that goes to the server.

## Step 4: make the shop wallet on the server

On the server, make a wallet that can watch but never spend:

```bash
bitcoin-cli -named createwallet wallet_name=shop disable_private_keys=true blank=true
```

What the settings mean:

- `disable_private_keys=true` makes this a **watch-only** wallet. There are no spending keys in it at all. If someone breaks into your server, they can see what you were paid and nothing more.
- `blank=true` starts it empty. The checkout code adds each order's address to it.

Now add this line to `bitcoin.conf`, so the node opens the shop wallet every time it starts:

```ini
wallet=shop
```

Add it only after the wallet exists. If the node starts with `wallet=shop` and no such wallet, it makes an ordinary wallet with spending keys under that name.

Back up the shop wallet now, and again on a schedule:

```bash
bitcoin-cli -rpcwallet=shop backupwallet /path/to/backups/shop.bak
```

The backup holds no spending keys. It holds the list of addresses already handed out and which order each one belongs to. You need it if you ever move or rebuild the server (see "Moving or rebuilding the shop wallet" below).

## Step 5: make a secret and write down your settings

You need one random secret:

```bash
openssl rand -hex 32   # signs the "order paid" messages (BCH_HMAC_SECRET)
```

This is how your website tells a real "order paid" message from a fake one: the indexer signs every message with it, and your site checks the signature. The two sides must have the same value or no message ever gets through.

These are the settings each piece needs. They are passed as environment variables, which are named values a program reads when it starts.

| Setting                      | Who needs it           | What to put                                                                                |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `BCH_RPC_URL`                | Checkout code, indexer | `http://127.0.0.1:8332` (the node's door; 8332 is Bitcoin Cash Node's default)             |
| `BCH_WALLET`                 | Checkout code, indexer | `shop`                                                                                     |
| `BCH_RPC_USER`               | Checkout code, indexer | The `rpcuser` from step 2                                                                  |
| `BCH_RPC_PASSWORD`           | Checkout code, indexer | The `rpcpassword` from step 2                                                              |
| `BCH_XPUB`                   | Checkout code          | The extended public key from step 3                                                        |
| `BCH_HMAC_SECRET`            | Indexer, webhook code  | The secret above                                                                           |
| `BCH_WEBHOOK_URL`            | Indexer                | The web address of your webhook code, like `https://your-site.example/api/payment-webhook` |
| `BCH_REQUIRED_CONFIRMATIONS` | Indexer                | `6`. How many blocks must hold a payment before it counts.                                 |
| `BCH_POLL_INTERVAL_MS`       | Indexer                | `30000`. How often the indexer checks the wallet, in thousandths of a second.              |

## Step 6: add two small pieces of code to your website

Website hosts run small pieces of code on demand. Netlify, Cloudflare, and Vercel call them functions. You add two.

**The checkout code.** The buyer's browser calls this when they click pay. It works out a fresh address, has your node watch it, and sends back what the buyer needs to see.

```js
// /api/checkout/bitcoin-cash
import { createBitcoinCashCreator } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { myStore } from './store.js';

const create = createBitcoinCashCreator({
  rpcUrl: process.env.BCH_RPC_URL,
  wallet: process.env.BCH_WALLET,
  rpcUser: process.env.BCH_RPC_USER,
  rpcPassword: process.env.BCH_RPC_PASSWORD,
  xpub: process.env.BCH_XPUB,
  store: myStore,
  expiryMinutes: 15,
  bchPerUnit: async (currency) => 1 / (await bitcoinCashPriceIn(currency)), // your own price source
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
- `bchPerUnit` answers "how much bitcoin cash is one unit of my price?" For a price in US dollars, you look up the bitcoin cash price wherever you trust and return one divided by it. A price already in `BCH` needs no lookup. Coin Moebius does not pick a price source for you.

This code needs to reach your node. If your website host cannot reach a node on a private server, run just this one piece of code on the same server as the node, and have the buyer's browser call it there. The other piece can stay on your website host.

**The webhook code.** The indexer calls this with the "order paid" message. It checks the signature, saves the new status, and does whatever "paid" means for you.

```js
// /api/payment-webhook
import { isStatusRegression } from '@aquarian-metals/coin-moebius-core';
import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
import { createBitcoinCashVerifier } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { myStore } from './store.js';

const verifiers = createVerifierRegistry();
verifiers.register('bitcoin-cash', createBitcoinCashVerifier({ hmacSecret: process.env.BCH_HMAC_SECRET }).verify);

export default async (req) => {
  const result = await verifiers.verify(await req.text(), Object.fromEntries(req.headers));
  if (!result) return new Response('', { status: 200 });

  const existing = await myStore.get(result.paymentId);
  if (existing && isStatusRegression(existing.status, result.status)) {
    return new Response('', { status: 200 });
  }
  const order = {
    ...existing,
    ...result,
    metadata: { ...existing?.metadata, ...result.metadata },
    createdAt: existing?.createdAt ?? result.timestamp,
    updatedAt: Date.now(),
  };
  await myStore.upsert(order);

  if (result.status === 'success') await fulfill(order);
  return new Response('', { status: 200 });
};
```

Two lines in there matter more than they look:

- **Add the message's details to the saved order; never replace them.** The saved order holds the amount the buyer was asked to pay, and the indexer checks every payment against it. If the order is overwritten with only what the message carries, that amount is gone.
- **Never move an order backwards.** A "waiting" message that arrives late must not reopen an order that is already paid. `isStatusRegression` makes that check.

`fulfill` gets the whole order, so it knows the product (`order.metadata.productId`) and anything you attached at checkout, such as the buyer's email.

Make `fulfill` safe to run twice for the same order. The indexer can resend a message after a restart, and every payment system in the world does the same.

You also need the small read-only piece every Coin Moebius provider uses, `/api/payment-status`, which looks an order up so the buyer's page can ask "paid yet?". The example folder has it.

## Step 7: start the indexer

The indexer is the program that checks your node and sends the "order paid" messages. It runs on the server next to the node.

```js
// indexer.js
import { createBitcoinCashIndexer } from '@aquarian-metals/coin-moebius-bitcoin-cash/server';
import { myStore } from './store.js';

const indexer = createBitcoinCashIndexer({
  rpcUrl: process.env.BCH_RPC_URL,
  wallet: process.env.BCH_WALLET,
  rpcUser: process.env.BCH_RPC_USER,
  rpcPassword: process.env.BCH_RPC_PASSWORD,
  store: myStore,
  webhookUrl: process.env.BCH_WEBHOOK_URL,
  hmacSecret: process.env.BCH_HMAC_SECRET,
  requiredConfirmations: Number(process.env.BCH_REQUIRED_CONFIRMATIONS ?? 6),
  pollIntervalMs: Number(process.env.BCH_POLL_INTERVAL_MS ?? 30_000),
});

const stop = indexer.start();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
```

```bash
npm install @aquarian-metals/coin-moebius-bitcoin-cash @aquarian-metals/coin-moebius-server
node indexer.js
```

To keep it running after you log out and restart it if it crashes, install it as a system service. A ready-made service file is at `examples/static-site-demo/bitcoin-cash/bitcoin-cash-indexer.service`; edit the paths and secrets, copy it into `/etc/systemd/system/`, and turn it on.

If the indexer is down for a while, nothing is lost. When it comes back it looks back about a day of blocks (`scanLookbackBlocks`, 144 by default) and sends the messages it missed. Buyers just see "waiting" a little longer.

**Orders nobody pays.** An order expires 15 minutes after checkout. Your node does not know which addresses are still waiting, so only your order database does. If your database can list the waiting orders (an optional method called `listPending`; the built-in memory store has it), the indexer marks unpaid orders failed once they expire. Before it does, it asks the node one more time whether anything ever reached that address, so a payment is never reported missing. If your database cannot list waiting orders, paid orders still work exactly the same; unpaid ones just stay marked as waiting.

**Money that arrives late** still counts. A buyer whose payment lands after the order expired gets their order, instead of being told to pay again.

## Step 8: put the button on your page

```ts
import { createBitcoinCashProvider } from '@aquarian-metals/coin-moebius-bitcoin-cash';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [createBitcoinCashProvider({ statusEndpoint: '/api/payment-status' })],
});

buyWithBitcoinCash.onclick = () =>
  payments.initiate({ providerId: 'bitcoin-cash', productId: 'ebook', amount: 19.99, currency: 'USD' });

payments.onPending((r) =>
  payments.subscribeToStatus(r.paymentId, { statusEndpoint: '/api/payment-status', onSuccess: unlock }),
);
```

When a buyer clicks, a box appears with the address, the exact amount, a reminder to send on the Bitcoin Cash network, and the link that opens their wallet. Most sites replace the box with their own design and add a QR code; the SDK lets you swap it out.

## The payment link

The checkout code gives the buyer a link in the form Bitcoin Cash wallets use, the address with its `bitcoincash:` prefix and the amount in BCH:

```text
bitcoincash:qp…?amount=0.04242
```

Desktop and phone wallets open it with the payment filled in. Put the same text in your QR code.

**Amounts.** Prices are rounded up to six significant digits, and never finer than one satoshi (the smallest unit of bitcoin cash, one hundred-millionth). You are never a fraction short, and the buyer sees a number they can read.

**If the buyer sends too little,** the order is marked `partial` once the payment is six blocks deep, and the message says exactly how much arrived. **If they send more than once to the same address,** every payment is added up.

## Restoring your wallet somewhere else

Each checkout uses the next address from your key, whether the buyer pays or not. So a run of unpaid checkouts leaves a run of empty addresses. Some phone wallets stop looking after 20 empty addresses in a row (this is called the **gap limit**), and would not show money that arrived further along. If you restore your recovery words in another wallet and payments seem to be missing, raise that wallet's gap limit, or restore them in a wallet that looks further ahead.

## Moving or rebuilding the shop wallet

Never make a new, empty shop wallet and start taking orders. The checkout code picks each order's address by looking at the addresses the shop wallet already watches, so an empty wallet would make it start counting from the beginning again, and new buyers would be given addresses that old orders already used. If an old buyer then paid late, their money would land on a stranger's new order.

Restore the backup from step 4 instead. Stop the node, copy the backup into the node's `wallets/shop/` folder as `wallet.dat`, and start the node again:

```bash
mkdir -p ~/.bitcoin/wallets/shop
cp /path/to/backups/shop.bak ~/.bitcoin/wallets/shop/wallet.dat
```

The restored wallet carries on from the last address it watched, and it still knows which order each old address belongs to, so a late payment on an old order is still matched.

If the backup is lost, the new wallet starts counting addresses from the beginning again and no longer knows which order each old address belonged to. Watch the addresses from your old orders by hand in the wallet you made in step 3.

## Bigger setups

- **One person.** One server runs the node and the indexer. Messages go out to your website host.
- **A small business.** A private network. The node on a machine with a big disk, the indexer next to it. The Docker Compose file in the example folder is one way to lay this out.
- **Larger.** Run one indexer. Give it a health page that shows `indexer.status()`. If you ever run more than one, give your database a `markStatusAnnounced` method so an order is announced exactly once. Keep your recovery words on a computer that is never online.

## If something goes wrong

| What you see                                                     | What it means and what to do                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node refused getblockchaininfo (401)`                           | The name or password does not match `rpcuser` and `rpcpassword` in `bitcoin.conf`.                                                                                                                                                                        |
| `Requested wallet does not exist or is not loaded`               | `BCH_WALLET` names a wallet the node has not opened. Run `bitcoin-cli loadwallet shop`, and make sure `wallet=shop` is in `bitcoin.conf`.                                                                                                                 |
| `xpub must be the account key for m/44'/145'/0'`                 | The key you copied is not the one the wallet uses for its addresses. Copy the extended public key for the wallet's main account again.                                                                                                                    |
| Payments sit at 0 confirmations for a long time                  | The node has fallen behind. Compare `bitcoin-cli getblockcount` with a public block explorer.                                                                                                                                                             |
| `money reached an expired invoice outside the lookback window`   | The indexer was down longer than `scanLookbackBlocks` covers. Raise it and restart the indexer, and the order settles on the next check.                                                                                                                  |
| `the stored payment has no atomicAmount … refusing to settle it` | Your webhook code replaced the saved order instead of adding to it, and the amount the buyer owes is gone. The indexer will not guess. Fix the webhook code as in step 6, then put `atomicAmount` back on the order from your logs or the checkout reply. |
| Old unpaid orders never become "failed"                          | Your database has no `listPending`. Add it, or accept that unpaid orders stay marked as waiting.                                                                                                                                                          |

## Trying it without real money

Bitcoin Cash Node has a private test mode called **regtest**. It starts an empty ledger that lives only on your computer, so there is nothing to download, and you make new blocks yourself with one command. Every step above works the same way in regtest, and addresses start with `bchreg:` instead of `bitcoincash:`.

```bash
bitcoind -regtest -daemon
bitcoin-cli -regtest createwallet buyer
bitcoin-cli -regtest -rpcwallet=buyer generatetoaddress 101 $(bitcoin-cli -regtest -rpcwallet=buyer getnewaddress)   # gives the buyer wallet test coins
bitcoin-cli -regtest -rpcwallet=buyer sendtoaddress <address from your checkout> 0.0002
bitcoin-cli -regtest -rpcwallet=buyer generatetoaddress 6 $(bitcoin-cli -regtest -rpcwallet=buyer getnewaddress)     # puts the payment six blocks deep
```

In regtest the node's door is `18443` instead of `8332`. Make the shop wallet the same way as in step 4.

## Optional: Docker

`examples/static-site-demo/bitcoin-cash/docker-compose.yml` starts the node and the indexer as containers. It uses `zquestz/bitcoin-cash-node`, a community image, not one the Bitcoin Cash Node project publishes. Pin the version you checked, and move it forward yourself. You own the upgrades.

## Where this comes from

- Bitcoin Cash Node downloads: <https://bitcoincashnode.org>
- Bitcoin Cash Node's documentation: <https://docs.bitcoincashnode.org>
- The CashAddr address format: <https://github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md>
