# Migration Guide

How to update Coin Moebius SDK integrations across versions. Versioned in the order changes shipped — older sections still apply if you're upgrading from an older starting point.

## From `0.1.0-beta.1` to the next release (unreleased as of 2026-05-12)

The first batch of post-beta changes consolidates several breaking changes that the hardening pass surfaced. Apply them in any order — they're independent.

### 1. Cryptomus package renamed

The `@aquarian-metals/coin-moebius-monero-cryptomus` package was misleadingly named — Cryptomus is a multi-coin gateway, Monero is just one of many supported coins. The package is now `@aquarian-metals/coin-moebius-cryptomus`.

**In your `package.json`:**

```diff
-"@aquarian-metals/coin-moebius-monero-cryptomus": "^0.1.0-beta.1"
+"@aquarian-metals/coin-moebius-cryptomus": "^0.1.0-beta.1"
```

**In your imports:**

```diff
-import createMoneroCryptomusProvider from '@aquarian-metals/coin-moebius-monero-cryptomus';
+import createCryptomusProvider from '@aquarian-metals/coin-moebius-cryptomus';
-import { createCryptomusVerifier } from '@aquarian-metals/coin-moebius-monero-cryptomus/server';
+import { createCryptomusVerifier } from '@aquarian-metals/coin-moebius-cryptomus/server';
```

**Function name change:** `createMoneroCryptomusProvider` → `createCryptomusProvider`.

**Config type rename:** `MoneroCryptomusConfig` → `CryptomusConfig`.

**Provider ID change in `initiate` calls:**

```diff
-payments.initiate({ ..., providerId: 'monero-cryptomus' });
+payments.initiate({ ..., providerId: 'cryptomus' });
```

**`CryptomusCreateInput.currency` is now required.** It was previously optional with a `'XMR'` default. Add the explicit currency to every call:

```diff
-const result = await create({ productId: 'p', amount: 0.12 });
+const result = await create({ productId: 'p', amount: 0.12, currency: 'XMR' });
```

**Metadata field rename:** if you read `result.metadata.amountXMR` from the Cryptomus payment, it's now `result.metadata.cryptomusAmount` (the name is coin-neutral since Cryptomus supports many).

### 2. Server verifier registry is now a factory

The top-level `registerVerifier`/`verify` exports from `@aquarian-metals/coin-moebius-server` are gone. The new API is a factory that returns a per-instance registry:

```diff
-import { verify, registerVerifier } from '@aquarian-metals/coin-moebius-server';
-
-registerVerifier('stripe', createStripeVerifier({ ... }));
-const result = await verify(req.body, req.headers);
+import { createVerifierRegistry } from '@aquarian-metals/coin-moebius-server';
+
+const verifiers = createVerifierRegistry();
+verifiers.register('stripe', createStripeVerifier({ ... }));
+const result = await verifiers.verify(req.body, req.headers);
```

Why: the old API kept registration state at the module level, which meant tests had to `vi.resetModules()` for isolation and multi-tenant runtimes risked cross-tenant leaks. The factory returns an isolated registry per call.

### 3. Supabase adapter removed

`createSupabaseStore` and the `./supabase` subpath export are gone from `@aquarian-metals/coin-moebius-server`. The `@supabase/supabase-js` runtime dependency is also gone.

If you were using the Supabase adapter:

- **Quick option:** copy the old adapter source into your own project. It's about 30 lines; here's the old shape:

  ```typescript
  import { createClient } from '@supabase/supabase-js';
  import type { PaymentStore, PaymentRecord } from '@aquarian-metals/coin-moebius-server';

  export function createSupabaseStore(config: {
    supabaseUrl: string;
    supabaseServiceRoleKey: string;
    tableName?: string;
  }): PaymentStore {
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });
    const table = config.tableName ?? 'coin_moebius_transactions';
    return {
      async upsert(record: PaymentRecord) {
        /* … */
      },
      async get(paymentId: string) {
        /* … */
      },
    };
  }
  ```

- **Better option:** implement `PaymentStore` against whatever backing store you're actually using (Postgres, SQLite, Redis, your fridge). The interface is two methods.

The SDK now ships a minimal `createMemoryStore()` for tests/prototypes, and that's it — vendor adapters live in consumers' own code.

### 4. `PaymentRecord.confirmations` field removed

The top-level `confirmations?: number` field on `PaymentRecord` is gone. If you were reading from it, switch to `record.metadata.confirmations` (where the Cryptomus verifier already puts it).

```diff
-const conf = record.confirmations ?? 0;
+const conf = (record.metadata.confirmations as number) ?? 0;
```

### 5. Default checkout endpoints changed

The default endpoints for Stripe and Cryptomus client providers moved from `/.netlify/functions/...` to a vendor-neutral `/api/checkout/<provider>` style:

| Provider  | Old default                                    | New default               |
| --------- | ---------------------------------------------- | ------------------------- |
| Stripe    | `/.netlify/functions/create-stripe-session`    | `/api/checkout/stripe`    |
| Cryptomus | `/.netlify/functions/create-cryptomus-payment` | `/api/checkout/cryptomus` |
| Manual    | `/api/checkout/manual` (unchanged)             | `/api/checkout/manual`    |

**If you were relying on the Netlify defaults**, set the override explicitly to keep your old behavior:

```diff
 createStripeProvider({
   publishableKey: '...',
+  sessionEndpoint: '/.netlify/functions/create-stripe-session',
 });
```

If you've already moved off Netlify (or were planning to), the new defaults work out-of-the-box on Cloudflare Workers, Vercel, Express, and any other host where you serve the matching path.

## How to verify after upgrading

After applying the changes above:

```bash
# Reinstall dependencies (picks up the new package name + removed deps)
rm -rf node_modules package-lock.json
npm install

# Run your own type-check and tests
npm run typecheck && npm test
```

Anything that doesn't compile is a missed migration step. Anything that compiles but fails at runtime is probably the verifier-registry or the `confirmations` field — work through this list once more.

## Reporting migration issues

If you hit a migration step that's missing or wrong, open an issue on the GitHub repo. The CHANGELOG entry for each release has the formal record; this guide is the recipe-format companion.
