# @aquarian-metals/coin-moebius-authorizenet

Authorize.Net provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

Two entries in one package:

- `@aquarian-metals/coin-moebius-authorizenet` — browser entry, sends the buyer to Authorize.Net's Accept Hosted page via form POST.
- `@aquarian-metals/coin-moebius-authorizenet/server` — Node-only HMAC-SHA512 webhook verifier. **Never import this from browser code.**

## Install

```bash
npm install @aquarian-metals/coin-moebius-authorizenet
```

No additional dependencies — the server verifier uses Web Crypto exclusively.

## Use — browser

```ts
import { createAuthorizenetProvider } from '@aquarian-metals/coin-moebius-authorizenet';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createAuthorizenetProvider({
      sessionEndpoint: '/api/checkout/authorizenet',
    }),
  ],
});
```

### Session endpoint contract

Unlike the other providers (which return `{ url }` only), Authorize.Net's Accept Hosted flow requires a form POST with a token. Your session endpoint must return `{ url, token }`:

```json
{
  "url": "https://accept.authorize.net/payment/payment",
  "token": "<hosted-form-token>",
  "paymentId": "<your-internal-payment-id>"
}
```

The `url` is the Accept Hosted target — `https://accept.authorize.net/payment/payment` for live, `https://test.authorize.net/payment/payment` for sandbox. The `token` is what your server received in the `token` field of `getHostedPaymentPageResponse`. The provider builds a hidden form and submits it; the buyer lands on the hosted form just like a redirect.

Tokens are valid for 15 minutes, so mint a fresh token per checkout click rather than caching them.

## Use — server (webhook verification)

```ts
import { createAuthorizenetVerifier } from '@aquarian-metals/coin-moebius-authorizenet/server';

const verify = createAuthorizenetVerifier({
  signatureKey: process.env.AUTHORIZENET_SIGNATURE_KEY,
});

// inside your webhook route:
const result = await verify.verify(rawBody, request.headers);
```

The Signature Key is **not** the Transaction Key. Generate it in the Merchant Interface under **Account → Settings → Security Settings → General Security Settings → API Credentials and Keys**. You can rotate it; treat it like any other webhook secret.

### Status mapping

| Authorize.Net event                              | `PaymentResult.status`                               |
| ------------------------------------------------ | ---------------------------------------------------- |
| `net.authorize.payment.authorization.created`    | `pending`                                            |
| `net.authorize.payment.authcapture.created`      | `success`                                            |
| `net.authorize.payment.capture.created`          | `success`                                            |
| `net.authorize.payment.priorAuthCapture.created` | `success`                                            |
| `net.authorize.payment.refund.created`           | `refunded`                                           |
| `net.authorize.payment.void.created`             | `failed`                                             |
| `net.authorize.payment.fraud.held`               | `pending`                                            |
| `net.authorize.payment.fraud.approved`           | `success`                                            |
| `net.authorize.payment.fraud.declined`           | `failed`                                             |
| anything else                                    | (verifier returns `null`, signature still validated) |

The verifier accepts both the documented `sha512=<hex>` header format and the bare hex form, and matches the hex case-insensitively.

### Sandbox

Authorize.Net's sandbox is at `apitest.authorize.net` (REST) and `test.authorize.net` (hosted form). Sign up at [developer.authorize.net](https://developer.authorize.net/). Same signature scheme as production — the verifier needs no mode flag.

### Currency posture

Authorize.Net is primarily a US gateway; non-USD support is limited and depends on your processor agreement. The verifier returns `'USD'` on `PaymentResult.currency` because Authorize.Net's webhook payloads do not carry a currency field — merchants on a non-USD account should override via metadata or by reading `raw`.

## License

MIT — see [LICENSE](./LICENSE).
