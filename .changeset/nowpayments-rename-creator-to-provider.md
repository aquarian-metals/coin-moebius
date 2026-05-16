---
'@aquarian-metals/coin-moebius-nowpayments': minor
---

**Breaking:** Rename `createNowPaymentsCreator` → `createNowPaymentsProvider` (and the config type `NowPaymentsCreatorConfig` → `NowPaymentsProviderConfig`).

The old name was an outlier — every other browser-side provider factory in the SDK uses the `createXProvider` shape (`createStripeProvider`, `createCryptomusProvider`). Naming the NOWPayments equivalent `Creator` made it read as a different concept rather than the same `PaymentProvider` factory the other packages expose.

**Migration:**

```diff
-import { createNowPaymentsCreator } from '@aquarian-metals/coin-moebius-nowpayments';
+import { createNowPaymentsProvider } from '@aquarian-metals/coin-moebius-nowpayments';

-const nowpayments = createNowPaymentsCreator({
+const nowpayments = createNowPaymentsProvider({
   checkoutEndpoint: '/.netlify/functions/create-nowpayments-payment',
 });
```

And, where the config type was imported by name:

```diff
-import type { NowPaymentsCreatorConfig } from '@aquarian-metals/coin-moebius-nowpayments';
+import type { NowPaymentsProviderConfig } from '@aquarian-metals/coin-moebius-nowpayments';
```

The server-side `createNowPaymentsVerifier` is unchanged. Behavior is unchanged — this is a pure rename.
