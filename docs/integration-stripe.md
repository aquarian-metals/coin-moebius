# Accept Stripe payments on a static site

The buyer chooses a product. Your server sets its price, creates a Checkout Session, and saves the order before sending the buyer to Stripe. Your download endpoint checks that the signed-in buyer owns a paid order.

## Create checkout

Configure a Stripe secret key on the server. In Stripe, create a Price for each product. The example uses a USD 19.99 Price for the guide. The browser SDK redirects to the returned hosted checkout URL.

```typescript
// POST /api/checkout/stripe
const { productId } = await req.json();
if (productId !== 'jamstack-guide') return new Response('Unknown product', { status: 404 });
const buyer = await requireSignedInBuyer(req);
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{ price: process.env.STRIPE_GUIDE_PRICE_ID, quantity: 1 }],
  success_url: 'https://shop.example/orders',
  cancel_url: 'https://shop.example/guide',
  metadata: { productId },
});
await orders.insert({
  sessionId: session.id,
  buyerId: buyer.id,
  productId,
  amount: 19.99,
  currency: 'USD',
  status: 'pending',
});
return Response.json({ url: session.url });
```

Use your own authentication and order database for the application functions in these snippets. Save the expected total from your catalog or trusted quote, including any discounts, tax, and shipping.

## Confirm payment and deliver

Set the webhook signing secret for this endpoint. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`.

```typescript
import { createStripeVerifier } from '@aquarian-metals/coin-moebius-stripe/server';
import type Stripe from 'stripe';

const verify = createStripeVerifier({ endpointSecret: process.env.STRIPE_WEBHOOK_SECRET! });
export async function POST(req: Request) {
  const event = await verify(await req.text(), Object.fromEntries(req.headers));
  if (event?.kind !== 'payment') return new Response('Ignored');
  const raw = event.raw as Stripe.Event;
  if (!raw.type.startsWith('checkout.session.')) return new Response('Ignored');
  const session = raw.data.object as Stripe.Checkout.Session;
  const order = await orders.bySessionId(session.id);
  if (!order || order.currency !== event.currency || order.amount !== event.amount)
    return new Response('Order mismatch', { status: 409 });
  if (event.status === 'success') await orders.grantDownloadOnce(order.id);
  return new Response('Received');
}
```

Implement `grantDownloadOnce` as one database transaction with a unique entitlement per order. If delivery involves an external service, record the work durably in the same transaction and use the order ID as its idempotency key. A delayed method can finish checkout while funds are pending. Show that state on the return page and release the file only after the order has a paid entitlement.

## Test before release

In a Stripe sandbox, use Stripe CLI forwarding and its endpoint secret with your local webhook handler. Create the order through the actual demo checkout. Exercise an immediate payment, a delayed success, and a delayed failure. Check the stored order and download permission before and after each event. Redeliver the paid event and verify the order still has exactly one entitlement.

[Stripe Checkout fulfillment](https://docs.stripe.com/checkout/fulfillment)
