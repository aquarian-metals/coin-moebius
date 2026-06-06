# @aquarian-metals/coin-moebius-square

Square (Block) provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

Two entries in one package:

- `@aquarian-metals/coin-moebius-square` — browser entry, redirects to Square's hosted checkout (Payment Link flow).
- `@aquarian-metals/coin-moebius-square/server` — Node-only HMAC-SHA256 webhook verifier. **Never import this from browser code.**

## Install

```bash
npm install @aquarian-metals/coin-moebius-square
```

No additional dependencies — the server verifier uses Web Crypto exclusively.

## Use — browser

```ts
import { createSquareProvider } from '@aquarian-metals/coin-moebius-square';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createSquareProvider({
      sessionEndpoint: '/api/checkout/square',
    }),
  ],
});
```

Your session endpoint calls `POST /v2/online-checkout/payment-links` and returns the `payment_link.url` field as `{ url }`. The provider fires `onPending` and redirects the buyer to Square's hosted checkout.

## Use — server (webhook verification)

```ts
import { createSquareVerifier } from '@aquarian-metals/coin-moebius-square/server';

const verify = createSquareVerifier({
  signatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY,
  notificationUrl: 'https://your-public-domain.example/webhooks/square',
});

// inside your webhook route:
const result = await verify.verify(rawBody, request.headers);
```

### Why the verifier needs a `notificationUrl`

Square signs the webhook over **`notificationUrl + rawBody`** — the public URL the merchant configured on the webhook subscription is part of the HMAC input. A worker running behind a reverse proxy or Cloudflare typically cannot recover the original public URL from the inbound request (it sees an internal route, a different host, or a stripped path), so the verifier requires the merchant to pass the URL explicitly.

**The URL must match byte-for-byte** with what the merchant configured in Square's Developer Console (Webhooks → your subscription → Notification URL). Any difference — trailing slash, scheme, port, capitalization of the host — produces a silent signature failure. Treat the value like a secret and pin it in your environment configuration.

### Signature key

The signature key is **subscription-specific**, generated in Square's Developer Console alongside the subscription. It is not the same as the application's access token. To rotate, recreate the subscription.

### Status mapping

| Square event            | Inner status           | `PaymentResult.status`                               |
| ----------------------- | ---------------------- | ---------------------------------------------------- |
| `payment.created`       | —                      | `pending`                                            |
| `payment.updated`       | `COMPLETED`            | `success`                                            |
| `payment.updated`       | `APPROVED` (auth-only) | `pending`                                            |
| `payment.updated`       | `FAILED` or `CANCELED` | `failed`                                             |
| `refund.created`        | —                      | `pending`                                            |
| `refund.updated`        | `COMPLETED`            | `refunded`                                           |
| `refund.updated`        | `FAILED` or `REJECTED` | `failed`                                             |
| `dispute.created`       | —                      | `disputed`                                           |
| `dispute.state.updated` | —                      | `disputed`                                           |
| anything else           | —                      | (verifier returns `null`, signature still validated) |

The `paymentId` on the returned `PaymentResult` is the Square `payment.id` whenever available (preferred for cross-event correlation across payment / refund / dispute on the same purchase). Amounts are converted from Square's smallest-currency-unit integers (e.g., cents for USD) to a major-unit decimal to match the rest of the SDK.

### Known gap: no replay-window enforcement

Square's signature scheme does not include a timestamp, so the verifier cannot reject stale-and-replayed deliveries on its own. If your application is sensitive to replays, deduplicate at the application layer using the webhook's `event_id` field.

### Sandbox vs production

The signature scheme is the same in both environments — the verifier has no mode flag. Sandbox API endpoints are at `connect.squareupsandbox.com`; production is at `connect.squareup.com`. Your session endpoint chooses which one to hit; the verifier only cares about the signature key + notification URL pair.

### Currency + locations

Square locations have a per-location currency, but the webhook payload carries the actual currency on `amount_money.currency`, so the verifier surfaces whatever the payload says. Merchants with multiple locations don't need to override anything.

## License

MIT — see [LICENSE](./LICENSE).
