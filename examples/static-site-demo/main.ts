import { createPaymentManager } from '@aquarian-metals/coin-moebius';
import { createBitcoinProvider } from '@aquarian-metals/coin-moebius-bitcoin';
import { createBitcoinCashProvider } from '@aquarian-metals/coin-moebius-bitcoin-cash';
import createCryptomusProvider from '@aquarian-metals/coin-moebius-cryptomus';
import { createMoneroProvider } from '@aquarian-metals/coin-moebius-monero';
import createStripeProvider from '@aquarian-metals/coin-moebius-stripe';
import { createZanoProvider, FREEDOM_DOLLAR_ASSET_ID } from '@aquarian-metals/coin-moebius-zano';

const ZANO_PROVIDER_IDS = new Set(['zano', 'fusd']);

const payments = createPaymentManager({
	providers: [
		createStripeProvider(),
		createCryptomusProvider(),
		createMoneroProvider(),
		createZanoProvider(),
		createZanoProvider({ id: 'fusd', name: 'Freedom Dollar', assetId: FREEDOM_DOLLAR_ASSET_ID }),
		createBitcoinProvider(),
		createBitcoinCashProvider(),
	],
});

const statusEl = document.getElementById('status');

function showConfirmed(result: { provider: string; paymentId: string }) {
	if (!statusEl) return;
	statusEl.style.display = 'block';
	const title = document.createElement('strong');
	title.textContent = 'Payment confirmed.';
	const download = document.createElement('button');
	download.type = 'button';
	download.textContent = 'Download your guide';
	download.onclick = () => alert('Replace with your fulfillment / signed URL.');
	statusEl.replaceChildren(
		title,
		document.createElement('br'),
		`Provider: ${result.provider}`,
		document.createElement('br'),
		`Payment ID: ${result.paymentId}`,
		document.createElement('br'),
		download,
	);
}
payments.onSuccess(showConfirmed);

const sessionId = new URLSearchParams(window.location.search).get('session_id');
if (sessionId && statusEl) {
	statusEl.style.display = 'block';
	statusEl.textContent = 'Awaiting payment confirmation…';
	startStatusPolling(sessionId);
}

payments.onPending((result) => {
	if (!statusEl) return;
	statusEl.style.display = 'block';
	statusEl.replaceChildren(renderPending(result));
	if (result.paymentId) {
		if (result.provider !== 'stripe') startStatusPolling(result.paymentId);
		if (result.provider === 'monero') {
			document.getElementById('mock-pay-btn')?.addEventListener('click', () => {
				void simulateMockPayment(result.paymentId, '/api/mock/pay-monero');
			});
		}
		if (ZANO_PROVIDER_IDS.has(result.provider)) {
			document.getElementById('mock-pay-btn')?.addEventListener('click', () => {
				void simulateMockPayment(result.paymentId, '/api/mock/pay-zano');
			});
		}
		if (result.provider === 'bitcoin') {
			document.getElementById('mock-pay-btn')?.addEventListener('click', () => {
				void simulateMockPayment(result.paymentId, '/api/regtest/pay-bitcoin');
			});
		}
		if (result.provider === 'bitcoin-cash') {
			document.getElementById('mock-pay-btn')?.addEventListener('click', () => {
				void simulateMockPayment(result.paymentId, '/api/regtest/pay-bitcoin-cash');
			});
		}
	}
});

payments.onError((err) => {
	if (!statusEl) return;
	statusEl.style.display = 'block';
	statusEl.textContent = `Payment error: ${err.message}`;
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

document.getElementById('zano-tile')?.addEventListener('click', () => {
	payments.initiate({
		providerId: 'zano',
		productId: 'jamstack-guide',
		amount: 0.5,
		currency: 'ZANO',
		metadata: { email: 'buyer@example.com' },
	});
});

document.getElementById('fusd-tile')?.addEventListener('click', () => {
	payments.initiate({
		providerId: 'fusd',
		productId: 'jamstack-guide',
		amount: 19.99,
		currency: 'USD',
		metadata: { email: 'buyer@example.com' },
	});
});

document.getElementById('bitcoin-tile')?.addEventListener('click', () => {
	payments.initiate({
		providerId: 'bitcoin',
		productId: 'jamstack-guide',
		amount: 0.0002,
		currency: 'BTC',
		metadata: { email: 'buyer@example.com' },
	});
});

document.getElementById('bitcoin-cash-tile')?.addEventListener('click', () => {
	payments.initiate({
		providerId: 'bitcoin-cash',
		productId: 'jamstack-guide',
		amount: 0.04,
		currency: 'BCH',
		metadata: { email: 'buyer@example.com' },
	});
});

function startStatusPolling(paymentId: string) {
	payments.subscribeToStatus(
		paymentId,
		{
			statusEndpoint: '/api/payment-status',
			onPending: (r) => console.log('pending poll:', r.metadata.confirmations ?? 0),
			onSuccess: showConfirmed,
			onFailed: () => {
				if (statusEl) statusEl.textContent = 'Payment did not complete.';
			},
			onTimeout: () => {
				if (statusEl) statusEl.textContent = 'Payment confirmation is still outstanding.';
			},
		},
		{ pollIntervalMs: 1500, timeoutMs: 30 * 60 * 1000 },
	);
}

async function simulateMockPayment(paymentId: string, endpoint: string) {
	await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ paymentId }),
	});
}

function renderPending(result: {
	provider: string;
	paymentId: string;
	metadata: Record<string, unknown>;
}): DocumentFragment {
	const fragment = document.createDocumentFragment();
	const title = document.createElement('strong');
	title.textContent = 'Awaiting confirmation…';
	fragment.append(
		title,
		document.createElement('br'),
		`Provider: ${result.provider}`,
		document.createElement('br'),
		`Payment ID: ${result.paymentId}`,
		document.createElement('br'),
	);
	const meta = (key: string) => readMetaString(result.metadata, key);
	const instruction = (label: string, text: string) => {
		const row = document.createElement('div');
		row.className = 'kv';
		const name = document.createElement('span');
		name.textContent = label;
		const code = document.createElement('code');
		code.textContent = text;
		row.append(name, code);
		fragment.append(row);
	};
	const wallet = result.provider;
	const amounts: Record<string, string> = {
		monero: meta('xmrAmount') + ' XMR',
		zano: meta('assetAmount') + ' ' + meta('ticker'),
		fusd: meta('assetAmount') + ' ' + meta('ticker'),
		bitcoin: meta('btcAmount') + ' BTC',
		'bitcoin-cash': meta('bchAmount') + ' BCH',
	};
	if (Object.hasOwn(amounts, wallet)) {
		instruction('Send exactly', amounts[wallet]);
		instruction('To', meta('address'));
		instruction('Wallet link', meta('uri'));
		const button = document.createElement('button');
		button.type = 'button';
		button.id = 'mock-pay-btn';
		button.textContent = wallet.startsWith('bitcoin')
			? 'Pay from the regtest buyer wallet (regtest mode)'
			: 'Simulate buyer payment (mock mode)';
		fragment.append(button);
	} else {
		if (meta('address')) instruction('To', meta('address'));
		const qr = meta('qr');
		if (/^https:\/\/|^data:image\/(?:png|jpeg|webp);base64,/i.test(qr)) {
			const img = document.createElement('img');
			img.src = qr;
			img.width = 200;
			img.alt = 'Payment QR code';
			fragment.append(img);
		}
	}
	return fragment;
}

function readMetaString(metadata: Record<string, unknown>, key: string): string {
	const value = metadata[key];
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return String(value);
	return '';
}
