# @aquarianmetals/coin-moebius

The friendly install name for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)** — the headless, zero-UI payment router for static sites.

This package re-exports `@aquarianmetals/coin-moebius-core`. Pick whichever import path you prefer; they're interchangeable.

## Install

```bash
npm install @aquarianmetals/coin-moebius
```

That's it for the browser core. Add the providers you actually use:

```bash
npm install @aquarianmetals/coin-moebius-stripe
npm install @aquarianmetals/coin-moebius-monero-cryptomus
```

## Use

```ts
import { createPaymentManager } from '@aquarianmetals/coin-moebius';
import createStripeProvider from '@aquarianmetals/coin-moebius-stripe';

const payments = createPaymentManager({
  providers: [createStripeProvider({ publishableKey: import.meta.env.VITE_STRIPE_KEY })],
});

payments.onSuccess((result) => {
  // unlock the download, fire the confetti, update the DB
});
```

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start, including server-side webhook verification.

## License

MIT — see [LICENSE](./LICENSE).
