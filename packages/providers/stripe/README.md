# @aquarianmetals/coin-moebius-stripe

Stripe provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

Two entries in one package:

- `@aquarianmetals/coin-moebius-stripe` — browser entry, kicks off Stripe Checkout.
- `@aquarianmetals/coin-moebius-stripe/server` — Node-only webhook verifier. **Never import this from browser code.**

## Install

For the browser:

```bash
npm install @aquarianmetals/coin-moebius-stripe
```

For server-side webhook verification, additionally install the official Stripe SDK (declared as an optional peer so it stays out of browser bundles):

```bash
npm install stripe
```

## Use — browser

```ts
import createStripeProvider from '@aquarianmetals/coin-moebius-stripe';
import { createPaymentManager } from '@aquarianmetals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createStripeProvider({
      publishableKey: import.meta.env.VITE_STRIPE_KEY,
      // optional — defaults to '/.netlify/functions/create-stripe-session'
      sessionEndpoint: '/api/create-stripe-session',
    }),
  ],
});
```

## Use — server

```js
import { registerVerifier } from '@aquarianmetals/coin-moebius-server';
import { createStripeVerifier } from '@aquarianmetals/coin-moebius-stripe/server';

registerVerifier(
  'stripe',
  createStripeVerifier({
    endpointSecret: process.env.STRIPE_WEBHOOK_SECRET,
    // Optional but recommended — pass your secret key so the same Stripe
    // instance can be reused for refunds / retrieval calls in this function.
    secretKey: process.env.STRIPE_SECRET_KEY,
  })
);
```

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start.

## License

MIT — see [LICENSE](./LICENSE).
