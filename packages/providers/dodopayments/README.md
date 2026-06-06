# @aquarian-metals/coin-moebius-dodopayments

[Dodo Payments](https://dodopayments.com) provider for [Coin Moebius](https://github.com/aquarian-metals/coin-moebius).

Dodo Payments is a Merchant of Record: it hosts the checkout page, handles
sales tax, and remits to you. A single Dodo checkout can mix one-time and
subscription products, so this one package covers both — one-time charges land
as `kind: 'payment'` events, recurring billing lands as `kind: 'subscription'`.

## Client (browser)

```ts
import { createDodoPaymentsProvider } from '@aquarian-metals/coin-moebius-dodopayments';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const dodo = createDodoPaymentsProvider({
  // Your own serverless endpoint that creates a Dodo checkout session with
  // your API key and returns `{ url: checkout_url }`.
  checkoutEndpoint: '/api/checkout/dodopayments',
});

const manager = createPaymentManager({ providers: [dodo] });
await manager.initiate({ productId: 'pro', amount: 9.99, currency: 'USD' });
```

`initiate` fires `onPending` and then redirects the buyer to Dodo's hosted
checkout. The terminal `success` signal arrives via the webhook on the server
side; subscribe to it buyer-side with `manager.subscribeToStatus(...)` if you
want in-page completion notice.

## Server (Node / serverless / Workers)

```ts
import { createDodoPaymentsVerifier } from '@aquarian-metals/coin-moebius-dodopayments/server';

const verify = createDodoPaymentsVerifier({
  webhookSecret: process.env.DODO_WEBHOOK_SECRET, // the whsec_… value
});

// `rawBody` MUST be the unparsed request body string (or bytes). Standard
// Webhooks signs the exact payload, so a pre-parsed object cannot be verified.
const event = await verify(rawBody, request.headers);
if (event?.kind === 'payment' && event.status === 'success') {
  // fulfill
}
```

> **Never import `/server` into a browser bundle.** It performs signature
> verification and belongs only in your serverless functions or Worker.

### Signature scheme

Dodo signs webhooks with the [Standard Webhooks](https://www.standardwebhooks.com/)
specification: base64 HMAC-SHA256 over `${webhook-id}.${webhook-timestamp}.${body}`,
keyed by the base64-decoded `whsec_…` secret, compared against each `v1,<sig>`
token in the `webhook-signature` header. The verifier also rejects deliveries
whose signed `webhook-timestamp` is outside a 5-minute tolerance window
(configurable via `toleranceSeconds`) for replay protection.

### Event mapping

| Dodo event                                             | SDK event                                    |
| ------------------------------------------------------ | -------------------------------------------- |
| `payment.succeeded`                                    | payment → `success`                          |
| `payment.processing`                                   | payment → `pending`                          |
| `payment.failed`, `payment.cancelled`                  | payment → `failed`                           |
| `refund.succeeded`                                     | payment → `refunded`                         |
| `dispute.opened`                                       | payment → `disputed`                         |
| `subscription.active`                                  | subscription → `subscription.created`        |
| `subscription.renewed`                                 | subscription → `subscription.renewed`        |
| `subscription.failed`                                  | subscription → `subscription.payment_failed` |
| `subscription.cancelled`, `subscription.expired`       | subscription → `subscription.canceled`       |
| `subscription.on_hold`, `subscription.plan_changed`, … | subscription → `subscription.updated`        |

Refund and dispute events key on the original `payment_id`, so you can link
them back to the original transaction. Amounts are converted from Dodo's minor
units (cents) to major units. Event types the SDK doesn't model (payouts,
license keys, `refund.failed`, dispute resolution follow-ups) resolve to
`null`; read `event.raw` if you need them.

## License

MIT — see [LICENSE](./LICENSE).
