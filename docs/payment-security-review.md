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

## How to discover missing payment cases

### Start from the provider contract and merchant rules

Stripe's Checkout Session reference explicitly allows processing to continue after checkout completes. Its fulfillment guide describes delayed success and failure. These sources would have identified the complete-but-unpaid case before the defect report. For each provider, record the source URL, supported API version or review date, and the precise evidence that authorizes delivery. Revisit that record when a payment method, provider API, or fulfillment rule changes. [Stripe Session reference](https://docs.stripe.com/api/checkout/sessions/object) · [Stripe fulfillment](https://docs.stripe.com/checkout/fulfillment)

OWASP identifies separate checks for trusted pricing, callback authenticity, payment status, order identity, amount, currency and repeat delivery. Use those as inputs to the merchant's decision. For self-hosted payments, document how the trusted indexer establishes confirmed funds. For manual payments, document who may confirm receipt and what amount qualifies. [OWASP payment gateway integration](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Payment_Gateway_Integration_Cheat_Sheet.html)

### Use a decision table for permission to deliver

ISTQB defines decision-table coverage by the feasible rules exercised. This gives a reviewer a denominator. The following are example rules for a positive-price, one-time digital purchase in a merchant application that requires a buyer login. A merchant-approved free order needs its own rule. [ISTQB Foundation Level syllabus, §§4.2.3–4.2.4](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf)

| Example evidence or condition                                     | Expected observable result                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Known product, browser price or currency differs from catalog     | Gateway request and stored order use the server quote. Checkout alone grants zero downloads. |
| Verification credential absent or blank outside local simulation  | Receiver cannot accept the notification. The saved order and existing grants are unchanged.  |
| Authentic event, checkout complete, payment unpaid                | Order remains pending. Download is unavailable.                                              |
| Authentic paid event, provider, order, amount or currency differs | No grant for the requested order. Exercise each mismatch independently.                      |
| Matching paid order, recorded buyer requests the file             | Exactly one entitlement for that order. The recorded buyer can retrieve the file.            |
| Same paid order, a different buyer requests the file              | Access is denied even though payment succeeded.                                              |

### Use a state table for what can happen next

ISTQB's state-transition technique tests sequences and makes invalid transitions visible. Stripe documents that events can arrive out of order. Write the allowed result for each relevant pair of current state and incoming event, then test the actual order, access decision, and number of grants after each step. [ISTQB syllabus, §4.2.4](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf) · [Stripe webhook delivery](https://docs.stripe.com/webhooks#event-ordering)

For delayed Stripe payments, exercise pending → paid and pending → failed. After success, exercise duplicate success and late pending. Close the browser before confirmation. Retry both after the order was saved but before the grant and after the grant but before acknowledgment. The expected grant counts are zero while unpaid or failed and one after eligible success. Refunds and disputes need explicit merchant rules for existing access.

### Cover interactions and test the tests

For a large matrix, NIST describes generating cases that exercise combinations of input values. For this SDK, exhaust the small fulfillment decision table first. Use pairwise coverage for the broader configuration matrix and explicitly add higher-order cases where several conditions jointly determine access. Pair coverage alone cannot establish the result for every three-way interaction. One priority combination is a delayed method, an early browser return, and a later failed payment. [NIST SP 800-142, Practical Combinatorial Testing](https://www.nist.gov/publications/practical-combinatorial-testing)

Mutation testing checks whether the suite detects a deliberate change in behavior. A candidate check for this project is to weaken one fulfillment condition in an isolated build and require the corresponding test to fail. Investigate surviving changes that alter the merchant outcome. This review did not run mutation testing. [Stryker mutation testing](https://stryker-mutator.io/docs/)

### Proposed release evidence and current gap

For each changed provider, attach its decision and state tables to the review. Map each feasible rule and selected transition to a test, a dated sandbox observation, or a specific open gap. Explain excluded combinations. Refresh the fixtures from sanitized provider sandbox events when the contract changes. Run shared checkout rules against copyable handlers as well as provider packages. For a changed delivery path, first identify what authorizes access. Test two buyer identities for a login-protected download. Coin Moebius Cloud uses a signed receipt link tied to a transaction. Test which file that link can retrieve, whether the transaction qualifies, and whether revocation takes effect.

In this branch, the Stripe route test checks the status poll after matching, mismatched, delayed and duplicate events. The SQLite delivery test counts entitlement rows after restart and retry. Those tests answer different questions. Neither exercises a buyer fetching a protected file through the hosted endpoint. That end-to-end check remains open in this audit. The proposed coverage criteria above are not currently enforced across all providers.

## Tests in this branch

The standard test command now includes the demo. The integration tests call the checkout, webhook and status handlers with local fixtures and replace outbound gateway calls. They inspect the price sent to the gateway and the state read back by the buyer. They cover unpaid completion, delayed results, missing credentials, wrong amount, wrong currency, an unknown order, duplicate events, and a late pending event. The standalone example test covers partial payment, delivery failure, retry and concurrent confirmations.

A provider inventory test fails when a new package lacks an entry describing how it confirms payment. All 13 webhook-backed providers must reject absent, empty and whitespace-only credentials. Manual confirmation and the starter have separate tests. The existing CI already runs the standard suite on pull requests.

### Verification results

On Node 24, the local `npm run verify` workflow passed formatting, all workspace builds, lint, type checking, coverage thresholds, package export checks and browser bundle budgets. The follow-up suite passed 810 tests across 40 files, including recovery when a worker stops before granting a download and when it loses the response after granting it. The same 810 tests also passed locally on Node 22.23.4, the major version used by CI. The checkout was based on local main at `89648ef`; remote GitHub was unreachable from this workspace.

### Follow-up SDK review before Coin Moebius billing

The follow-up started at SDK commit `82205f9`. Eleven new cases failed against that revision before the fixes. The revised SDK passed all 821 tests across 40 files on Node 22.23.4 and 24.22.1. The full Node 24 verification command also passed.

| Area            | Previously missed behavior                                                                                                                                                                                | What the new tests check                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe invoices | Newer API versions identify a subscription through the invoice parent. A subscription renewal could be classified as a one-time payment. A failed collection could report zero instead of the amount due. | Recognize the nested subscription ID and expanded object, preserve legacy identification, withhold a one-time success when subscription evidence is incomplete, and report the amount due on a failed subscription invoice. |
| Cryptomus       | The SDK kept failed and cancelled invoices pending.                                                                                                                                                       | Each of the documented fail, system_fail and cancel statuses reports failure. Partial and refund accounting need separate evidence before using this adapter for reconciliation.                                            |
| Status polling  | A slow read could overlap another poll, report after cancellation, or return a different order. A transient read error could interrupt polling.                                                           | Retry a temporary error, serialize reads, match the requested order, and honor cancellation and timeout while a read is outstanding.                                                                                        |

Provider contracts used for this pass include the [Stripe invoice parent migration](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects) and [Cryptomus status definitions](https://doc.cryptomus.com/merchant-api/payments/payment-statuses).

The saved Cloud source confirms that the hosted download route accepts a transaction-specific signed receipt link without buyer login. An eligible link supports repeated retrieval. A revoked link returns 410. Test transactions cannot deliver files. The hosted Worker integration run remains outstanding.

**Decision for billing.** Keep the SDK candidate in review until the provider sandbox, real-node and Worker integration gates above have recorded results for the candidate revision. Then apply the same review to Coin Moebius billing in a test environment. Reconcile each fee or subscription invoice with its stored ledger entry and resulting account access. Include threshold crossing, renewal, delayed and failed collection, duplicate notifications, refund or reversal, and recovery after interruption. Record expected amounts, ledger entry counts and access after each step. Production billing activation is a separate decision after those results are available.

### 4.5.2 release attempt

The provisional patch version is 4.5.2. An isolated build at that version passed npm packing checks for all 18 public packages. A dry run compiled the hosted API Worker from the locally cached production branch and its build manifest included the patched Stripe verifier. Separate Monero and Zano wallet simulations each went from pending checkout through a verified webhook to confirmed payment.

The release script stopped during the npm identity check because the shell could not resolve the registry. GitHub's hostname also failed to resolve. No npm publish, remote tag, GitHub push, or hosted deployment took place. External provider sandbox settlement remains unverified. Bitcoin Core regtest and the hosted Worker's integration tests could not open their local listening sockets in this environment.

## Release testing policy

| When                                                             | What to run                                                                                                                                                                                                                                                       | Passing result                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every pull request touching payments                             | Run the full SDK suite. For each changed provider, maintain a small table of documented payment states with the provider documentation URL beside it. Include a valid signature on a payment that is still unpaid.                                                | Only an eligible payment for the saved order reaches success. Unknown, partial, held and pending states keep paid access locked.                                                                                                                                       |
| Every checkout or guide change                                   | Run the actual example endpoint with a known product, an unknown product, and conflicting browser price, currency and buyer metadata. Inspect the provider request and stored order. Exercise any runnable guide example through the same tests.                  | The provider receives the merchant's quote. The order belongs to the authenticated buyer. Unknown products create no checkout.                                                                                                                                         |
| Every fulfillment change                                         | With the merchant's real database adapter and a fake delivery service, deliver duplicate and reordered events concurrently. Restart the worker between recording payment and issuing the entitlement. Retry after a delivery failure.                             | One paid order grants one entitlement to its owner, an unpaid order grants zero, and a recoverable failure eventually delivers. Enforce uniqueness in the database and persist external delivery work in the same transaction.                                         |
| Before releasing a changed provider or upgrading its API version | Create an order through the merchant flow in the provider sandbox. Include immediate success, delayed success and delayed failure where supported. Forward real sandbox events, then compare the provider record, stored order and actual download authorization. | A browser return, failed payment or mismatched order grants nothing. For hosted receipts, test-mode transactions withhold the file. Verify positive retrieval with a local production-mode fixture and dummy file. Save sanitized fixtures and the API version for CI. |
| Self-hosted rails                                                | Use local regtest or the documented wallet simulator. Check no funds, partial funds, insufficient confirmations, a top-up and a restart. Run the relevant real-node test before releasing an indexer change.                                                      | The order stays locked until the expected amount reaches the confirmation threshold. Restart and retry preserve the original order and delivery count.                                                                                                                 |

Stripe documents delayed Checkout settlement and provides test payment methods. Cryptomus exposes a test-webhook API with selectable outcomes. PayPal's simulator is useful for exercising a listener; use a sandbox checkout when the test depends on a real sandbox transaction. Square verification also depends on the configured notification URL. These differences justify provider-specific fixtures alongside shared tests. Keep sandbox credentials outside pull requests from untrusted branches.

## Rollout and exposure review

1. Release the patched packages and update merchant dependencies. Replace copied checkout and webhook handlers separately. An npm upgrade cannot update code already copied into a shop.
2. Configure distinct private signing keys for deployed self-hosted receivers and indexers. Restart both ends together. Keep mock and regtest payment helpers local.
3. Subscribe Stripe endpoints to completed checkout, asynchronous success and asynchronous failure. For Authorize.Net, set the account currency and reconcile fraud-approved holds against the transaction record before delivery.
4. For an installation that ran an affected version, compare delivered orders with the provider's settled status and the original catalog price and currency. Start with delayed Stripe payments and orders created by the two affected checkout examples. Separate free orders, authorized discounts and refunds before treating a discrepancy as a loss.

The provider sandbox and production-adapter checks above remain release gates. The gateway tests use fixture credentials. The standalone delivery test also uses an on-disk SQLite database and reopens it after failures. The branch has not been published, and production exposure has not been measured.

## Primary references

- [Stripe Checkout fulfillment and delayed payment methods](https://docs.stripe.com/checkout/fulfillment)
- [Stripe sandbox testing](https://docs.stripe.com/testing)
- [OWASP third-party payment gateway integration guidance](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Payment_Gateway_Integration_Cheat_Sheet.html)
- [Cryptomus payment states](https://doc.cryptomus.com/merchant-api/payments/payment-statuses) and [webhook testing](https://doc.cryptomus.com/merchant-api/payments/testing-webhook)
- [Authorize.Net transaction and fraud-review webhook events](https://developer.authorize.net/api/reference/features/webhooks.html)
- [MakePay webhook events](https://www.makecrypto.io/documentation/makepay/api/webhooks)
- [PayPal webhook simulator](https://developer.paypal.com/api/rest/webhooks/simulator/)
- [Square webhook verification](https://developer.squareup.com/docs/webhooks/step3validate)
