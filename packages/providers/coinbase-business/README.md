# @aquarian-metals/coin-moebius-coinbase-business

Coinbase Business provider for **[Coin Moebius](https://github.com/aquarian-metals/coin-moebius)**.

Three entries in one package:

- `@aquarian-metals/coin-moebius-coinbase-business` — browser entry, redirects to Coinbase's hosted checkout.
- `@aquarian-metals/coin-moebius-coinbase-business/server` — Node-only webhook verifier (Hook0 v1 signatures). **Never import this from browser code.**
- `@aquarian-metals/coin-moebius-coinbase-business/subscription` — optional, server-only helper that creates a webhook subscription via the CDP API. Import this if you want to provision the subscription from your own code; ignore it if you manage the subscription out-of-band.

## Replaces Coinbase Commerce

🚨 Coinbase Commerce was sunset for new merchants and the migration cutover ran on March 31, 2026. The legacy `coinbase-commerce-node` SDK targets the deprecated Commerce surface. This package targets the current Coinbase Business Checkout API instead.

## Geography

Coinbase Business currently supports merchants registered in the United States or Singapore only. Merchants in other jurisdictions cannot use this provider until Coinbase expands eligibility.

## Install

For the browser:

```bash
npm install @aquarian-metals/coin-moebius-coinbase-business
```

No additional dependencies required for the server verifier — it uses Web Crypto exclusively.

## Use — browser

```ts
import { createCoinbaseBusinessProvider } from '@aquarian-metals/coin-moebius-coinbase-business';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';

const payments = createPaymentManager({
  providers: [
    createCoinbaseBusinessProvider({
      sessionEndpoint: '/api/checkout/coinbase-business',
    }),
  ],
});
```

The session endpoint on your server is expected to call Coinbase's Checkout API and return `{ url: hosted_url }`. The provider redirects the buyer to `hosted_url` and fires `onPending` synchronously.

## Use — server (webhook verification)

```ts
import { createCoinbaseBusinessVerifier } from '@aquarian-metals/coin-moebius-coinbase-business/server';

const verify = createCoinbaseBusinessVerifier({
  webhookSecret: process.env.COINBASE_BUSINESS_WEBHOOK_SECRET,
});

// inside your webhook route:
const result = await verify.verify(rawBody, request.headers);
if (result) {
  // result.status is one of: 'success' | 'failed'
  // result.paymentId is the Coinbase checkout id
}
```

### Status mapping

| Coinbase event             | `PaymentResult.status`                               |
| -------------------------- | ---------------------------------------------------- |
| `checkout.payment.success` | `success`                                            |
| `checkout.payment.failed`  | `failed`                                             |
| `checkout.payment.expired` | `failed`                                             |
| anything else              | (verifier returns `null`, signature still validated) |

Coinbase Business does not emit an in-flight `pending` event. The buyer experience between session creation and the first webhook is "awaiting payment" by absence-of-event, not a positive signal. If your UX needs an interim state, render it from the moment your session endpoint responds and clear it on the webhook.

### Webhook signature format

Coinbase routes Business webhooks through [Hook0](https://documentation.hook0.com/). The signature header is structured, not a bare digest:

```
X-Hook0-Signature: t=<unix-seconds>,h=<space-separated-header-names>,v1=<hex-sha256>
```

The signed content is `${t}.${h}.${headerValues.join('.')}.${rawBody}`, HMAC-SHA256 with the webhook secret. The verifier handles the parsing for you, but if you ever need to verify by hand the format is the same as Hook0's published Node.js reference.

The verifier also enforces a 5-minute replay window by default. Override with `maxAgeSeconds` if you have a legitimate reason (e.g., replaying captured fixtures).

## Use — server (programmatic webhook subscription)

Coinbase Business does not expose a dashboard form to add a webhook URL. The subscription must be created via API, and the signing secret is **only returned on the create response** — you cannot retrieve it later.

```ts
import { createCoinbaseBusinessSubscription } from '@aquarian-metals/coin-moebius-coinbase-business/subscription';

const sub = createCoinbaseBusinessSubscription({
  cdpKeyId: process.env.CDP_KEY_ID,
  cdpPrivateKeyPem: process.env.CDP_PRIVATE_KEY_PEM,
  mode: 'live',
});

const { subscriptionId, signingSecret } = await sub.subscribe({
  callbackUrl: 'https://app.example.com/webhook/coinbase-business',
});

// Persist signingSecret now. It is not retrievable later.
```

### CDP key setup

1. Create a CDP account at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com).
2. Under API Keys, create a new key. Coinbase issues an EC P-256 keypair; download the private key (PEM, PKCS8) when prompted.
3. Pass the key id to `cdpKeyId` and the PEM contents to `cdpPrivateKeyPem`.

The helper signs requests with ES256 (ECDSA P-256 + SHA-256). Coinbase also supports Ed25519, but ES256 has broader Web Crypto support across older runtimes and Coinbase accepts both.

## License

MIT — see [LICENSE](./LICENSE).
