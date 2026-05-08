# @aquarianmetals/coin-moebius-server

Server-side webhook verification + payment status helpers for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

> ⚠️ **Node / serverless only.** Never import this package (or any provider's `./server` entry) from browser code — it will pull Node built-ins like `crypto` into your client bundle and likely break the build.

Provides:

- `registerVerifier(providerId, verifier)` and `verify(rawBody, headers)` — one webhook endpoint that delegates to whichever provider sent the call.
- `createStatusSubscriber(store)` — server-side polling helper backed by a `PaymentStore`.
- `createSupabaseStore(config)` (subpath import: `@aquarianmetals/coin-moebius-server/supabase`) — a ready-made Supabase-backed `PaymentStore`.

## Install

Only inside your serverless functions / Node project:

```bash
npm install @aquarianmetals/coin-moebius-server
```

You'll typically also install the server entries of whichever provider packages you verify (e.g. `@aquarianmetals/coin-moebius-stripe`) and any provider-specific server SDKs the README calls out (e.g. `stripe`).

## Use

```js
import { verify, registerVerifier } from '@aquarianmetals/coin-moebius-server';
import { createStripeVerifier } from '@aquarianmetals/coin-moebius-stripe/server';

registerVerifier('stripe', createStripeVerifier({ endpointSecret: process.env.STRIPE_SECRET }));

export default async function handler(req) {
  const result = await verify(req.body, req.headers);
  if (result.status === 'success') {
    // fulfill the order
  }
  return { statusCode: 200 };
}
```

See the [main README](https://github.com/aquarian-metals/coin-moebius#readme) for the full backend wiring example.

## License

MIT — see [LICENSE](./LICENSE).
