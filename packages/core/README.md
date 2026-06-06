# @aquarian-metals/coin-moebius-core

Headless payment router core for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

Browser-safe. Provides:

- `createPaymentManager({ providers })` — wires providers together and exposes a single `onSuccess` / `onPending` / `onError` event surface.
- `subscribeToStatus(paymentId, handlers, options)` — polls a status endpoint while delayed payments (e.g. Monero confirmations) settle.
- The `PaymentProvider`, `PaymentResult`, and `InitiateOptions` types every provider implements.

## Install

```bash
npm install @aquarian-metals/coin-moebius-core
```

Or use the friendlier alias `@aquarian-metals/coin-moebius` — same exports.

## Use

```ts
import { createPaymentManager } from '@aquarian-metals/coin-moebius-core';
```

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full quick-start.

## License

MIT — see [LICENSE](./LICENSE).
