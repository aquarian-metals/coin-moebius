# @aquarian-metals/coin-moebius-manual

Manual / async payment provider for [Coin Moebius](https://github.com/aquarian-metals/coin-moebius). Covers any payment method where receipt is confirmed by hand: physical mail, Goldbacks, wire transfer, cash, personal check, barter, IOU.

The default UI is Goldback-flavored (mailing address, reference code on the envelope, "I've shipped it" button). Replace the default modal via the `renderModal` option to fit your brand.

## Install

```bash
npm install \
	@aquarian-metals/coin-moebius \
	@aquarian-metals/coin-moebius-core \
	@aquarian-metals/coin-moebius-manual
```

## Use (client-side)

```typescript
import { createPaymentManager } from '@aquarian-metals/coin-moebius-core';
import createManualProvider from '@aquarian-metals/coin-moebius-manual';

const payments = createPaymentManager({
  providers: [
    createManualProvider({
      checkoutEndpoint: '/api/checkout/manual',
    }),
  ],
});

payments.onPending((result) => {
  console.log('Reference code:', result.metadata.referenceCode);
  // Buyer has agreed to mail payment. Display confirmation; we'll email them on receipt.
});

document.getElementById('pay-with-goldbacks')?.addEventListener('click', () => {
  payments.initiate({
    productId: 'ebook-42',
    amount: 30,
    currency: 'Goldback',
    providerId: 'manual',
  });
});
```

The default modal renders inline with minimal styling, isolated from the host page's CSS. To replace it entirely:

```typescript
createManualProvider({
  renderModal: (instructions, { onShipped, onCancel }) => {
    // Render your own modal. Call onShipped() when the buyer confirms.
    // Return a cleanup function that removes the modal from the DOM.
    return renderMyCustomModal(instructions, { onShipped, onCancel });
  },
});
```

## Use (server-side)

```typescript
import {
  generateReferenceCode,
  markReceived,
  cancelPending,
  expirePending,
} from '@aquarian-metals/coin-moebius-manual/server';

// At checkout time — mint a code and persist alongside a pending transaction:
const referenceCode = generateReferenceCode(); // e.g., "GBK-7F2A"

// When the seller clicks "Mark received" in their dashboard:
const { state, result } = markReceived(currentState, receivedAmount);
// Persist `state`, fire `result` to the SDK's status endpoint.

// When the seller cancels a pending payment:
const next = cancelPending(currentState);

// In a nightly cron, for pending_manual older than the project's timeout:
const next = expirePending(currentState);
```

## Why no signature verifier?

Unlike Stripe or Cryptomus, manual payments have no external webhook to verify — the "event" is an authenticated dashboard click by the seller. Trust is established by the seller's session, not by a cryptographic signature. The state-machine helpers in `./server` enforce status transitions; signature verification isn't applicable.

## How manual statuses map to `PaymentResult.status`

The SDK's `PaymentResult.status` is a fixed three-value enum (`'success' | 'pending' | 'failed'`). The manual provider has a richer internal state machine for the seller's bookkeeping (`pending_manual`, `succeeded`, `manual_canceled`, `manual_expired`). The mapping to what surfaces in the buyer's SDK callback:

| Internal state                                | Surfaces to buyer's SDK as            | When the callback fires                                                                                 |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pending_manual`                              | `status: 'pending'` (via `onPending`) | Right after the buyer clicks "I've shipped it" in the modal.                                            |
| `succeeded` (after `markReceived`)            | `status: 'success'` (via `onSuccess`) | When the seller's dashboard pushes the success result to the SDK's status endpoint.                     |
| `manual_canceled` (seller chose not to honor) | Never surfaces to the SDK             | The buyer is notified out-of-band (email); the SDK fires no further callback after the initial pending. |
| `manual_expired` (timeout cron)               | Never surfaces to the SDK             | Same — email is the channel. The seller's UI shows the expiration.                                      |

In short: the buyer's browser sees only `pending` (initial) and possibly `success` (if/when the seller marks received). Cancellation and expiration are seller-side concerns communicated via email, not via the SDK's callback path.

## Endpoint contract

The `checkoutEndpoint` (default `/api/checkout/manual`) accepts a POST with this body:

```json
{
  "productId": "ebook-42",
  "amount": 30,
  "currency": "Goldback",
  "metadata": { "anything": "the merchant wants to track" }
}
```

…and must return:

```json
{
  "txId": "tx_abc123",
  "referenceCode": "GBK-7F2A",
  "mailingAddress": "1234 Commerce Way, Suite 567, ...",
  "expectedAmount": 30,
  "expectedCurrency": "Goldback",
  "instructions": "Mail 30 Goldbacks to the address above..."
}
```

## License

MIT — see [LICENSE](./LICENSE).
