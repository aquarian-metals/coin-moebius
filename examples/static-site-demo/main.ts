import createCryptomusProvider from '@aquarian-metals/coin-moebius-cryptomus';
import { createPaymentManager } from '@aquarian-metals/coin-moebius';
import createStripeProvider from '@aquarian-metals/coin-moebius-stripe';

const payments = createPaymentManager({
	providers: [
		createStripeProvider({ publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY }),
		createCryptomusProvider(),
	],
});

payments.onSuccess((result) => {
	const statusEl = document.getElementById('status');
	if (!statusEl) return;
	statusEl.innerHTML = `
		<strong>✅ Payment confirmed!</strong><br />
		Payment ID: ${result.paymentId}<br />
		Provider: ${result.provider}<br />
		<button type="button" id="download-btn">Download your guide now</button>
	`;
	statusEl.style.display = 'block';
	document.getElementById('download-btn')?.addEventListener('click', () => {
		alert('Replace with your fulfillment / signed URL.');
	});
});

payments.onPending((result) => {
	const statusEl = document.getElementById('status');
	if (!statusEl) return;
	statusEl.style.display = 'block';
	const qr = result.metadata.qr;
	const qrImg = typeof qr === 'string' ? `<img src="${qr}" width="200" alt="" />` : '';
	statusEl.innerHTML = `
		<strong>⏳ Awaiting confirmation...</strong><br />
		Provider: ${result.provider}<br />
		Payment ID: ${result.paymentId}<br />
		${qrImg}
		<small>(we'll update this automatically)</small>
	`;
	if (result.paymentId) {
		startStatusPolling(result.paymentId);
	}
});

document.getElementById('stripe-tile')?.addEventListener('click', () => {
	payments.initiate({
		productId: 'jamstack-guide',
		amount: 19.99,
		currency: 'USD',
		metadata: { email: 'buyer@example.com' },
	});
});

document.getElementById('monero-tile')?.addEventListener('click', () => {
	payments.initiate({
		productId: 'jamstack-guide',
		amount: 0.12,
		currency: 'XMR',
		metadata: { email: 'buyer@example.com' },
		providerId: 'cryptomus',
	});
});

function startStatusPolling(paymentId: string) {
	payments.subscribeToStatus(paymentId, {
		statusEndpoint: '/.netlify/functions/payment-status',
		onPending: (r) => console.log('Still pending:', r.metadata.confirmations),
		onSuccess: (r) => console.log('Success from poll:', r),
		onTimeout: () => console.log('Timeout – ask user to check email'),
	});
}
