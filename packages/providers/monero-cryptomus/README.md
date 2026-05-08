# @aquarian-metals/coin-moebius-monero-cryptomus

Monero (via Cryptomus) provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

Two entries in one package:

- `@aquarian-metals/coin-moebius-monero-cryptomus` — browser entry. Posts to your own create-payment function (the Cryptomus API key holds spend authority and **must never** ship to the browser).
- `@aquarian-metals/coin-moebius-monero-cryptomus/server` — Node-only helpers: `createCryptomusCreator` (sign + POST to Cryptomus) and `createCryptomusVerifier` (validate incoming webhooks). **Never import this from browser code.**

## Install

```bash
npm install @aquarian-metals/coin-moebius-monero-cryptomus
```

The server entry uses Node's built-in `crypto` module — no extra install needed.

## Use — browser

```ts
import createMoneroCryptomusProvider from '@aquarian-metals/coin-moebius-monero-cryptomus';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createMoneroCryptomusProvider({
      // optional — defaults to '/.netlify/functions/create-cryptomus-payment'
      createEndpoint: '/api/create-cryptomus-payment',
    }),
  ],
});
```

## Use — server

You need **two** serverless functions: one to create payments, one to verify webhooks.

```js
// /api/create-cryptomus-payment
import { createCryptomusCreator } from '@aquarian-metals/coin-moebius-monero-cryptomus/server';

const create = createCryptomusCreator({
  merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID,
  paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY,
  callbackUrl: 'https://your-site.example/api/payment-webhook',
  returnUrl: 'https://your-site.example/success',
});

export default async function handler(req) {
  const { productId, amount, metadata } = JSON.parse(req.body);
  const result = await create({ productId, amount, metadata });
  // result: { uuid, address, qr?, amount?, raw }
  return { statusCode: 200, body: JSON.stringify(result) };
}
```

```js
// /api/payment-webhook
import { registerVerifier } from '@aquarian-metals/coin-moebius-server';
import { createCryptomusVerifier } from '@aquarian-metals/coin-moebius-monero-cryptomus/server';

registerVerifier(
  'monero-cryptomus',
  createCryptomusVerifier({
    merchantUuid: process.env.CRYPTOMUS_MERCHANT_UUID,
    paymentApiKey: process.env.CRYPTOMUS_PAYMENT_API_KEY,
  })
);
```

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start.

## License

MIT — see [LICENSE](./LICENSE).
