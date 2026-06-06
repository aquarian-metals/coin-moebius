# @aquarian-metals/coin-moebius-paypal

PayPal provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

Two entries in one package:

- `@aquarian-metals/coin-moebius-paypal` — browser entry, redirects to PayPal's hosted approval page (Orders v2 flow).
- `@aquarian-metals/coin-moebius-paypal/server` — Node-only webhook verifiers (two implementations of the same contract). **Never import this from browser code.**

## Install

For the browser:

```bash
npm install @aquarian-metals/coin-moebius-paypal
```

No additional dependencies required for the server verifiers — they use Web Crypto exclusively.

## Use — browser

```ts
import { createPaypalProvider } from '@aquarian-metals/coin-moebius-paypal';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createPaypalProvider({
      sessionEndpoint: '/api/checkout/paypal',
    }),
  ],
});
```

The session endpoint on your server is expected to call PayPal's `POST /v2/checkout/orders` with `intent: 'CAPTURE'` and return `{ url }` containing the response's `payer-action` HATEOAS link. The provider redirects the buyer to that URL and fires `onPending` synchronously. After the buyer approves and returns, your server captures the order via `POST /v2/checkout/orders/{id}/capture`; the final `PAYMENT.CAPTURE.COMPLETED` webhook lands on the server side.

## Use — server (webhook verification)

Two verifier implementations of the same `WebhookVerifier` contract. Pick one based on your traffic profile.

### Default: REST-endpoint verifier

PayPal does the crypto on their side. One OAuth call (cached for the returned `expires_in`, typically 9 hours) plus one verify call per webhook.

```ts
import { createPaypalVerifier } from '@aquarian-metals/coin-moebius-paypal/server';

const verify = createPaypalVerifier({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
  mode: 'live', // or 'sandbox'
});

// inside your webhook route:
const result = await verify.verify(rawBody, request.headers);
```

### Alternative: manual verifier

Verifies the signature locally with no per-webhook PayPal round-trip after the first cert fetch. Use this when webhook volume is high enough that the extra round-trip cost matters.

```ts
import { createPaypalManualVerifier } from '@aquarian-metals/coin-moebius-paypal/server';

const verify = createPaypalManualVerifier({
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
  mode: 'live',
});

const result = await verify.verify(rawBody, request.headers);
```

**Safe by default.** Before fetching anything, the manual verifier rejects any `paypal-cert-url` whose origin is not the mode-appropriate PayPal host (`https://api.paypal.com/v1/notifications/certs/...` for live, `https://api.sandbox.paypal.com/v1/notifications/certs/...` for sandbox). HTTPS to that pinned host is the trust anchor; TLS handles cert chain validation. A forged signature header pointing at an attacker-controlled cert is refused before any network call.

### Status mapping

| PayPal event                | `PaymentResult.status`                                           |
| --------------------------- | ---------------------------------------------------------------- |
| `CHECKOUT.ORDER.APPROVED`   | `pending`                                                        |
| `PAYMENT.CAPTURE.COMPLETED` | `success`                                                        |
| `PAYMENT.CAPTURE.DENIED`    | `failed`                                                         |
| `PAYMENT.CAPTURE.DECLINED`  | `failed`                                                         |
| `PAYMENT.CAPTURE.REFUNDED`  | `refunded`                                                       |
| `PAYMENT.CAPTURE.REVERSED`  | `refunded` (see `metadata` for the reversal indicator)           |
| `CUSTOMER.DISPUTE.CREATED`  | `disputed`                                                       |
| `CUSTOMER.DISPUTE.RESOLVED` | (verifier returns `null`; outcome shows on the original capture) |
| anything else               | (verifier returns `null`, signature still validated)             |

The `paymentId` field on the returned `PaymentResult` is the PayPal order id (`resource.supplementary_data.related_ids.order_id`) when available, so capture, refund, and dispute events linked to the same order all surface the same id.

### Sandbox setup

PayPal's sandbox requires two test accounts: one **business** (the merchant) and one **personal** (the buyer). Both are created from [developer.paypal.com](https://developer.paypal.com/dashboard/) under Apps & Credentials → Sandbox → Accounts.

When testing manually, set `mode: 'sandbox'` on both the verifier and your order-creation call.

### Currency support

PayPal supports a fixed list of currencies that varies by account country. USD, EUR, GBP, CAD, and AUD are universally supported. See PayPal's currency reference for the full list.

### Subscriptions

This package handles one-off PayPal orders only. PayPal's billing-agreements / subscriptions API is out of scope.

## License

MIT — see [LICENSE](./LICENSE).
