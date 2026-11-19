# Coin Moebius SDK payment security review

November 19, 2026 · Local SDK v4.5.1, base commit `89648ef` · Branch `fix/payment-verification`

## What was at risk

All three reports were accurate in the reviewed source. A merchant who copied the demo checkout could bill a different price from the one displayed in the shop. A merchant using the released Stripe verifier could deliver a paid item while a bank payment was still pending. Four self-hosted demo webhook routes could accept a publicly known signing key. The demo exposed the resulting payment status to polling clients. Its download button was a placeholder. This review did not establish that anyone obtained a real download or that any particular merchant deployed these examples.

## What changed

| Area                                   | Finding and correction                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monero, Zano, Bitcoin and Bitcoin Cash | Removed published fallback secrets from the demo. Without a configured key or explicit local simulation mode, the webhook verifier stays unregistered. Mock wallets and regtest use separate, randomly generated keys held in the running process.                                                                                                     |
| Stripe                                 | A completed, unpaid checkout stays pending. A paid checkout succeeds, and delayed failure is reported as failed. Setup and subscription checkouts stay outside the one-time payment path. An explicitly free, zero-total payment-mode order can complete.                                                                                              |
| Stripe and Cryptomus checkout          | Both demo routes look up the requested product and bill its server-side USD price. Unknown products are rejected before contacting the gateway. The server supplies product metadata. The root README, provider instructions and Stripe integration guide were corrected.                                                                              |
| Order matching and delivery            | The demo ties verified events to an existing checkout, provider and currency, and checks the expected total before accepting success. The Stripe return page polls the saved session. The four standalone self-hosted examples retain their original order details and check them before fulfillment. The browser poll checks the returned payment ID. |
| Cryptomus                              | Only the documented paid and overpaid states produce success. The verifier rejects a missing or blank payment key. Newly created invoices receive unique merchant order IDs even for simultaneous purchases of one product.                                                                                                                            |
| Authorize.Net                          | Approval after fraud review stays pending. Capture and subscription renewal require an approved capture response. Merchants can configure their account currency because the webhook omits it.                                                                                                                                                         |
| Manual, MakePay and starter template   | Manual confirmation rejects short, negative and nonfinite receipts. An overpayment still reports the actual amount. MakePay gives an explicit cancellation or expiry event precedence over a conflicting complete session. The unimplemented starter reports an error instead of firing its success callback.                                          |
| Other examples and configuration       | Removed arbitrary browser metadata forwarding from the four self-hosted checkout examples and their dev handlers. Updated buyer-identification guidance for subscriptions. Blank verification credentials are rejected in the provider checks. The demo status endpoint uses the SDK's public result format.                                           |

## Coverage of the SDK

The review followed one-time payment confirmation, checkout examples, signing configuration and the shared status path across all 14 provider libraries, the starter, core, server, and the umbrella package. This was a source and local regression review. It did not include the hosted Cloud product, separate merchant applications, production records or transactions with external gateways.

| Provider or group                      | Evidence the reviewed path uses for success                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe                                 | Paid Checkout Session or explicitly free checkout. Delayed failure, setup and subscription events have separate handling.                                            |
| Cryptomus / NOWPayments                | Cryptomus paid or paid_over. NOWPayments finished. Intermediate and partial payments do not qualify.                                                                 |
| PayPal / Square                        | PayPal capture completion. Square payment update with COMPLETED status. Approval alone does not qualify.                                                             |
| Dodo Payments / Coinbase Business      | Payment-success event from the respective provider.                                                                                                                  |
| Authorize.Net                          | Approved capture response. Fraud review alone does not qualify.                                                                                                      |
| MakePay                                | Its documented complete payment-session state, subject to explicit failure events.                                                                                   |
| Monero / Zano / Bitcoin / Bitcoin Cash | The indexer compares confirmed atomic units against the invoice. The receiver authenticates the indexer; checkout and webhook must share the merchant's order store. |
| Manual / starter                       | Manual requires seller confirmation of the full expected amount. The starter has no working payment integration.                                                     |

## Why the existing tests missed it

The Stripe test named for unpaid delayed checkout supplied an **open** session. The paid fixture supplied **complete and paid**. Both fixtures passed when the verifier mistakenly accepted either condition. Neither covered the pair Stripe actually sends during delayed settlement.

The test configuration discovered package tests and measured package source coverage. It skipped the demo handlers and the instructions merchants copy. Signature tests could pass while the demo chose a public secret, and provider tests could pass while the checkout route trusted the browser. An Authorize.Net test even required the old fraud-approval behavior. A higher coverage percentage alone would have preserved that mistake.

## Tests in this branch

The standard test command now includes the demo. The integration tests call the checkout, webhook and status handlers with local fixtures and replace outbound gateway calls. They inspect the price sent to the gateway and the state read back by the buyer. They cover unpaid completion, delayed results, missing credentials, wrong amount, wrong currency, an unknown order, duplicate events, and a late pending event. The standalone example test covers partial payment, delivery failure, retry and concurrent confirmations.

A provider inventory test fails when a new package lacks an entry describing how it confirms payment. All 13 webhook-backed providers must reject absent, empty and whitespace-only credentials. Manual confirmation and the starter have separate tests. The existing CI already runs the standard suite on pull requests.

### Verification results

On Node 24, the local `npm run verify` workflow passed formatting, all workspace builds, lint, type checking, coverage thresholds, package export checks and browser bundle budgets. The final suite passed 809 tests across 39 files. The same 809 tests also passed locally on Node 22.23.4, the major version used by CI. The checkout was based on local main at `89648ef`; remote GitHub was unreachable from this workspace.

## Release testing policy

| When                                                             | What to run                                                                                                                                                                                                                                                       | Passing result                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every pull request touching payments                             | Run the full SDK suite. For each changed provider, maintain a small table of documented payment states with the provider documentation URL beside it. Include a valid signature on a payment that is still unpaid.                                                | Only an eligible payment for the saved order reaches success. Unknown, partial, held and pending states keep paid access locked.                                                                                               |
| Every checkout or guide change                                   | Run the actual example endpoint with a known product, an unknown product, and conflicting browser price, currency and buyer metadata. Inspect the provider request and stored order. Exercise any runnable guide example through the same tests.                  | The provider receives the merchant's quote. The order belongs to the authenticated buyer. Unknown products create no checkout.                                                                                                 |
| Every fulfillment change                                         | With the merchant's real database adapter and a fake delivery service, deliver duplicate and reordered events concurrently. Restart the worker between recording payment and issuing the entitlement. Retry after a delivery failure.                             | One paid order grants one entitlement to its owner, an unpaid order grants zero, and a recoverable failure eventually delivers. Enforce uniqueness in the database and persist external delivery work in the same transaction. |
| Before releasing a changed provider or upgrading its API version | Create an order through the merchant flow in the provider sandbox. Include immediate success, delayed success and delayed failure where supported. Forward real sandbox events, then compare the provider record, stored order and actual download authorization. | A second buyer cannot download the item. A browser return alone unlocks nothing. A failed or mismatched payment grants nothing. A matching paid order grants once. Save sanitized fixtures and the API version for CI.         |
| Self-hosted rails                                                | Use local regtest or the documented wallet simulator. Check no funds, partial funds, insufficient confirmations, a top-up and a restart. Run the relevant real-node test before releasing an indexer change.                                                      | The order stays locked until the expected amount reaches the confirmation threshold. Restart and retry preserve the original order and delivery count.                                                                         |

Stripe documents delayed Checkout settlement and provides test payment methods. Cryptomus exposes a test-webhook API with selectable outcomes. PayPal's simulator is useful for exercising a listener; use a sandbox checkout when the test depends on a real sandbox transaction. Square verification also depends on the configured notification URL. These differences justify provider-specific fixtures alongside shared tests. Keep sandbox credentials outside pull requests from untrusted branches.

## Rollout and exposure review

1. Release the patched packages and update merchant dependencies. Replace copied checkout and webhook handlers separately. An npm upgrade cannot update code already copied into a shop.
2. Configure distinct private signing keys for deployed self-hosted receivers and indexers. Restart both ends together. Keep mock and regtest payment helpers local.
3. Subscribe Stripe endpoints to completed checkout, asynchronous success and asynchronous failure. For Authorize.Net, set the account currency and reconcile fraud-approved holds against the transaction record before delivery.
4. For an installation that ran an affected version, compare delivered orders with the provider's settled status and the original catalog price and currency. Start with delayed Stripe payments and orders created by the two affected checkout examples. Separate free orders, authorized discounts and refunds before treating a discrepancy as a loss.

The external sandbox and durable-database checks above are recommended release gates. The local tests use fixture credentials and an in-memory store. The branch has not been published, and production exposure has not been measured.

## Primary references

- [Stripe Checkout fulfillment and delayed payment methods](https://docs.stripe.com/checkout/fulfillment)
- [Stripe sandbox testing](https://docs.stripe.com/testing)
- [OWASP third-party payment gateway integration guidance](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Payment_Gateway_Integration_Cheat_Sheet.html)
- [Cryptomus payment states](https://doc.cryptomus.com/merchant-api/payments/payment-statuses) and [webhook testing](https://doc.cryptomus.com/merchant-api/payments/testing-webhook)
- [Authorize.Net transaction and fraud-review webhook events](https://developer.authorize.net/api/reference/features/webhooks.html)
- [MakePay webhook events](https://www.makecrypto.io/documentation/makepay/api/webhooks)
- [PayPal webhook simulator](https://developer.paypal.com/api/rest/webhooks/simulator/)
- [Square webhook verification](https://developer.squareup.com/docs/webhooks/step3validate)
