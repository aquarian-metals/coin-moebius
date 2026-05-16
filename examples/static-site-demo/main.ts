import { createPaymentManager } from '@aquarian-metals/coin-moebius';
import createCryptomusProvider from '@aquarian-metals/coin-moebius-cryptomus';
import { createMoneroProvider } from '@aquarian-metals/coin-moebius-monero';
import createStripeProvider from '@aquarian-metals/coin-moebius-stripe';

const payments = createPaymentManager({
	providers: [createStripeProvider(), createCryptomusProvider(), createMoneroProvider()],
});

const statusEl = document.getElementById('status');

payments.onSuccess((result) => {
	if (!statusEl) return;
	statusEl.style.display = 'block';
	statusEl.innerHTML = `
		<strong>Payment confirmed.</strong><br />
		Provider: ${result.provider}<br />
		Payment ID: ${result.paymentId}<br />
		<button type="button" id="download-btn">Download your guide</button>
	`;
	document.getElementById('download-btn')?.addEventListener('click', () => {
		alert('Replace with your fulfillment / signed URL.');
	});
});

payments.onPending((result) => {
	if (!statusEl) return;
	statusEl.style.display = 'block';
	statusEl.innerHTML = renderPendingHtml(result);
	if (result.paymentId) {
		startStatusPolling(result.paymentId);
		if (result.provider === 'monero') {
			document.getElementById('mock-pay-btn')?.addEventListener('click', () => {
				void simulateMockPayment(result.paymentId);
			});
		}
	}
});

payments.onError((err) => {
	if (!statusEl) return;
	statusEl.style.display = 'block';
	statusEl.innerHTML = `<strong>Payment error:</strong> ${err.message}`;
});

document.getElementById('stripe-tile')?.addEventListener('click', () => {
	payments.initiate({
		providerId: 'stripe',
		productId: 'jamstack-guide',
		amount: 19.99,
		currency: 'USD',
		metadata: { email: 'buyer@example.com' },
	});
});

document.getElementById('cryptomus-tile')?.addEventListener('click', () => {
	payments.initiate({
		providerId: 'cryptomus',
		productId: 'jamstack-guide',
		amount: 19.99,
		currency: 'USD',
		metadata: { email: 'buyer@example.com' },
	});
});

document.getElementById('monero-tile')?.addEventListener('click', () => {
	payments.initiate({
		providerId: 'monero',
		productId: 'jamstack-guide',
		amount: 0.05,
		currency: 'XMR',
		metadata: { email: 'buyer@example.com' },
	});
});

function startStatusPolling(paymentId: string) {
	payments.subscribeToStatus(
		paymentId,
		{
			statusEndpoint: '/api/payment-status',
			onPending: (r) => console.log('pending poll:', r.metadata.confirmations ?? 0),
			onSuccess: (r) => console.log('success poll:', r),
			onTimeout: () => console.log('timeout — ask buyer to check email'),
		},
		{ pollIntervalMs: 1500, timeoutMs: 30 * 60 * 1000 },
	);
}

async function simulateMockPayment(paymentId: string) {
	await fetch('/api/mock/pay-monero', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ paymentId }),
	});
}

function renderPendingHtml(result: {
	provider: string;
	paymentId: string;
	metadata: Record<string, unknown>;
}): string {
	const header = `<strong>Awaiting confirmation…</strong><br />Provider: ${result.provider}<br />Payment ID: ${result.paymentId}<br />`;
	if (result.provider === 'monero') {
		const address = readMetaString(result.metadata, 'address');
		const xmrAmount = readMetaString(result.metadata, 'xmrAmount');
		const uri = readMetaString(result.metadata, 'uri');
		return `${header}
			<div class="kv"><span>Send exactly</span><code>${xmrAmount} XMR</code></div>
			<div class="kv"><span>To</span><code>${address}</code></div>
			<div class="kv"><span>monero: URI</span><code>${uri}</code></div>
			<button type="button" id="mock-pay-btn">Simulate buyer payment (mock mode)</button>`;
	}
	const qr = result.metadata.qr;
	const qrImg = typeof qr === 'string' ? `<img src="${qr}" width="200" alt="" />` : '';
	const address = result.metadata.address;
	const addressHtml = typeof address === 'string' ? `<code>${address}</code>` : '';
	return `${header}${addressHtml}${qrImg}`;
}

function readMetaString(metadata: Record<string, unknown>, key: string): string {
	const value = metadata[key];
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	return '';
}
