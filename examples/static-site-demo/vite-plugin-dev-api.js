/**
 * Mounts the in-process `dev-api/*.js` handlers as Vite dev-server
 * middleware so `npm run dev` runs the whole stack — frontend, checkout
 * endpoints, webhook receiver, status reader, and (in mock mode) the
 * Monero indexer — inside one process with shared state.
 *
 * Each handler corresponds 1:1 to "what you'd deploy as a serverless
 * function" in production. The plugin is the demo-only glue; the
 * handlers themselves are unchanged.
 */

export default function devApiPlugin() {
	return {
		name: 'coin-moebius-demo-api',
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				const url = req.url ?? '';

				try {
					if (req.method === 'POST' && url.startsWith('/api/checkout/stripe')) {
						const { handleStripeCheckout } = await import('./dev-api/checkout-stripe.js');
						await handleStripeCheckout(req, res);
						return;
					}
					if (req.method === 'POST' && url.startsWith('/api/checkout/cryptomus')) {
						const { handleCryptomusCheckout } = await import('./dev-api/checkout-cryptomus.js');
						await handleCryptomusCheckout(req, res);
						return;
					}
					if (req.method === 'POST' && url.startsWith('/api/checkout/monero')) {
						const { handleMoneroCheckout } = await import('./dev-api/checkout-monero.js');
						const { ensureIndexerRunning } = await import('./dev-api/monero-indexer.js');
						ensureIndexerRunning();
						await handleMoneroCheckout(req, res);
						return;
					}
					if (req.method === 'POST' && url.startsWith('/api/payment-webhook')) {
						const { handlePaymentWebhook } = await import('./dev-api/payment-webhook.js');
						await handlePaymentWebhook(req, res);
						return;
					}
					if (req.method === 'GET' && url.startsWith('/api/payment-status')) {
						const { handlePaymentStatus } = await import('./dev-api/payment-status.js');
						await handlePaymentStatus(req, res);
						return;
					}
					if (req.method === 'POST' && url.startsWith('/api/mock/pay-monero')) {
						const { handleMockPay } = await import('./dev-api/monero-indexer.js');
						await handleMockPay(req, res);
						return;
					}
				} catch (err) {
					res.statusCode = 500;
					res.setHeader('Content-Type', 'application/json');
					res.end(
						JSON.stringify({
							error: err instanceof Error ? err.message : String(err),
						}),
					);
					return;
				}

				next();
			});
		},
	};
}
