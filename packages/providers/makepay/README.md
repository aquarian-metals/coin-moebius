# @aquarian-metals/coin-moebius-makepay

[MakePay](https://www.makepay.io) provider for [Coin Moebius](https://github.com/aquarian-metals/coin-moebius) — hosted crypto checkout with direct self-custody wallet settlement.

MakePay creates a hosted payment link, the buyer pays on MakePay's branded checkout page (70+ cryptocurrencies), and funds settle straight to the merchant's own wallet — MakePay never custodies them. A signed webhook reports the result back to your server.

## Install

```bash
npm install @aquarian-metals/coin-moebius-makepay @aquarian-metals/coin-moebius-core
```

## Client (browser)

`createMakepayProvider(config)` returns a `PaymentProvider` registered as `id: 'makepay'`. It POSTs to your own checkout endpoint, receives `{ url }` (MakePay's hosted checkout `publicUrl`), fires `onPending`, and redirects the buyer there.

```ts
import { createMakepayProvider } from '@aquarian-metals/coin-moebius-makepay';
import { createPaymentManager } from '@aquarian-metals/coin-moebius-core';

const makepay = createMakepayProvider({ checkoutEndpoint: '/api/checkout/makepay' });
const manager = createPaymentManager({ providers: [makepay] });

await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
```

Your checkout endpoint is responsible for calling MakePay's `payment-links` API with your API keys (server-side only) and returning the resulting `publicUrl` as `{ url }`.

## Server (Node / Workers)

`createMakepayVerifier({ webhookSecret })` verifies the signed webhook and returns a normalized `WebhookEvent`. The `X-MakePay-Signature` header carries `t=<unixSeconds>,v1=<hexSignature>`; the signature is the hex HMAC-SHA256 of `` `${t}.${rawBody}` `` keyed by your webhook secret, with a 300-second replay window by default.

```ts
import { createMakepayVerifier } from '@aquarian-metals/coin-moebius-makepay/server';
import { asPayment } from '@aquarian-metals/coin-moebius-core';

const verify = createMakepayVerifier({ webhookSecret: process.env.MAKEPAY_WEBHOOK_SECRET! });

// `rawBody` MUST be the exact request text MakePay signed — not a re-serialized object.
const event = await verify(rawBody, request.headers);
const payment = asPayment(event);
if (payment?.status === 'success') {
  // fulfil — the merchant order id is on payment.metadata.merchantOrderId
}
```

`computeMakepaySignature(timestamp, rawBody, secret)` and `parseMakepaySignatureHeader(header)` are exported for callers that want to verify without the registry.

Always deduplicate deliveries by the payment id (`paymentLink.uid`); the signed timestamp bounds but does not eliminate replays.

## License

MIT — see [LICENSE](./LICENSE).
