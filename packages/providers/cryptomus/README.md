# @aquarian-metals/coin-moebius-cryptomus

Cryptomus payment provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**. Routes any of Cryptomus's supported coins (Monero, btc, USDT, and more) through the standard SDK callback shape.

Two entries in one package:

- `@aquarian-metals/coin-moebius-cryptomus` — browser entry. Posts to your own create-payment function (the Cryptomus API key holds spend authority and **must never** ship to the browser).
- `@aquarian-metals/coin-moebius-cryptomus/server` — Node-only helpers: `createCryptomusCreator` (sign + POST to Cryptomus) and `createCryptomusVerifier` (validate incoming webhooks). **Never import this from browser code.**

## Install

```bash
npm install @aquarian-metals/coin-moebius-cryptomus
```

The server entry uses Node's built-in `crypto` module — no extra install needed.

## Use — browser

```ts
import createCryptomusProvider from '@aquarian-metals/coin-moebius-cryptomus';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createCryptomusProvider({
      // optional — defaults to '/api/checkout/cryptomus'
      createEndpoint: '/api/create-cryptomus-payment',
    }),
  ],
});

// Pick a coin via the `currency` field — Cryptomus routes whichever you ask for.
payments.initiate({
  productId: 'ebook-42',
  amount: 0.12,
  currency: 'XMR', // or 'BTC', 'USDT', etc.
  providerId: 'cryptomus',
});
```

## Use — server

You need **two** serverless functions: one to create payments, one to verify webhooks.

```js
// /api/create-cryptomus-payment
import { createCryptomusCreator } from '@aquarian-metals/coin-moebius-cryptomus/server';

const create = createCryptomusCreator({
  merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID,
  paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY,
  callbackUrl: 'https://your-site.example/api/payment-webhook',
  returnUrl: 'https://your-site.example/success',
});

export default async function handler(req) {
  const { productId, amount, currency, metadata } = JSON.parse(req.body);
  // `currency` is required — pick a Cryptomus-supported ticker.
  const result = await create({ productId, amount, currency, metadata });
  // result: { uuid, address, qr?, amount?, raw }
  return { statusCode: 200, body: JSON.stringify(result) };
}
```

```js
// /api/payment-webhook
import { registerVerifier } from '@aquarian-metals/coin-moebius-server';
import { createCryptomusVerifier } from '@aquarian-metals/coin-moebius-cryptomus/server';

registerVerifier(
  'cryptomus',
  createCryptomusVerifier({
    merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID,
    paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY,
  }),
);
```

## Related

- Want pure self-hosted Monero (no third-party gateway)? See [`@aquarian-metals/coin-moebius-monero`](../monero/README.md) — direct Monero RPC integration.
- For Stripe, see `@aquarian-metals/coin-moebius-stripe`.
- For manually-confirmed payments (Goldbacks, cash, check, barter), see `@aquarian-metals/coin-moebius-manual`.

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start.

## License

MIT — see [LICENSE](./LICENSE).
