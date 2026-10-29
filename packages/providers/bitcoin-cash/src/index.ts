import type { PaymentProvider, InitiateOptions } from '@aquarian-metals/coin-moebius-core';

import { formatAtomic } from './amounts.js';

export { BCH_DECIMALS, formatAtomic } from './amounts.js';

export interface BitcoinCashInstructions {
	paymentId: string;
	address: string;
	atomicAmount: string;
	bchAmount: number;
	uri: string;
	expiresAt: number;
}

export interface BitcoinCashProviderConfig {
	checkoutEndpoint?: string;
	statusEndpoint?: string;
	renderModal?: (
		instructions: BitcoinCashInstructions,
		callbacks: { onClose: () => void },
	) => () => void;
	fetcher?: typeof fetch;
}

export function createBitcoinCashProvider(config: BitcoinCashProviderConfig = {}): PaymentProvider {
	const checkoutEndpoint = config.checkoutEndpoint ?? '/api/checkout/bitcoin-cash';
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const renderer = config.renderModal ?? defaultRenderModal;

	return {
		id: 'bitcoin-cash',
		name: 'Bitcoin Cash',
		async initiate(options: InitiateOptions, callbacks): Promise<void> {
			try {
				const instructions = await fetchInstructions(fetcher, checkoutEndpoint, options);

				const cleanup = renderer(instructions, {
					onClose: () => cleanup(),
				});

				callbacks.onPending?.({
					status: 'pending',
					paymentId: instructions.paymentId,
					provider: 'bitcoin-cash',
					amount: options.amount,
					currency: options.currency,
					metadata: {
						...(options.metadata ?? {}),
						address: instructions.address,
						atomicAmount: instructions.atomicAmount,
						bchAmount: instructions.bchAmount,
						uri: instructions.uri,
						expiresAt: instructions.expiresAt,
						statusEndpoint: config.statusEndpoint,
					},
					timestamp: Date.now(),
				});
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};
}

const ALLOWED_URI_SCHEMES = new Set(['bitcoincash:', 'bchtest:', 'bchreg:']);

function validateUri(uri: string): string {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new Error('coin-moebius/bitcoin-cash: checkout response contains an invalid URI');
	}
	if (!ALLOWED_URI_SCHEMES.has(parsed.protocol)) {
		throw new Error(
			`coin-moebius/bitcoin-cash: URI scheme "${parsed.protocol}" is not allowed (expected bitcoincash:)`,
		);
	}
	return uri;
}

async function fetchInstructions(
	fetcher: typeof fetch,
	endpoint: string,
	options: InitiateOptions,
): Promise<BitcoinCashInstructions> {
	const response = await fetcher(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			productId: options.productId,
			amount: options.amount,
			currency: options.currency,
			metadata: options.metadata,
		}),
	});
	if (!response.ok) {
		throw new Error(`coin-moebius/bitcoin-cash: checkout endpoint responded ${response.status}`);
	}
	const payload = (await response.json()) as Partial<BitcoinCashInstructions>;
	if (
		typeof payload.paymentId !== 'string' ||
		typeof payload.address !== 'string' ||
		typeof payload.atomicAmount !== 'string' ||
		!/^\d+$/.test(payload.atomicAmount) ||
		typeof payload.uri !== 'string' ||
		!Number.isFinite(payload.bchAmount) ||
		!Number.isFinite(payload.expiresAt)
	) {
		throw new Error(
			'coin-moebius/bitcoin-cash: checkout response missing required fields (paymentId, address, atomicAmount, bchAmount, uri, expiresAt)',
		);
	}
	payload.uri = validateUri(payload.uri);
	return payload as BitcoinCashInstructions;
}

function defaultRenderModal(
	instructions: BitcoinCashInstructions,
	callbacks: { onClose: () => void },
): () => void {
	const overlay = document.createElement('div');
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-labelledby', 'cm-bitcoin-cash-title');
	overlay.style.cssText = [
		'position:fixed',
		'inset:0',
		'z-index:2147483647',
		'background:rgba(0,0,0,0.5)',
		'display:flex',
		'align-items:center',
		'justify-content:center',
		'padding:16px',
		'font-family:system-ui,-apple-system,sans-serif',
	].join(';');

	const card = document.createElement('div');
	card.style.cssText = [
		'background:#fff',
		'color:#1a1a1a',
		'border-radius:8px',
		'padding:24px',
		'max-width:520px',
		'width:100%',
		'box-shadow:0 20px 60px rgba(0,0,0,0.2)',
	].join(';');

	const expiresIn = Math.max(0, Math.round((instructions.expiresAt - Date.now()) / 1000 / 60));
	const amount = `${escapeHtml(formatAtomic(BigInt(instructions.atomicAmount)))} BCH`;

	card.innerHTML = `
		<h2 id="cm-bitcoin-cash-title" style="margin:0 0 8px;font-size:1.25rem;">Pay with Bitcoin Cash</h2>
		<p style="margin:0 0 16px;color:#555;">Send <strong>exactly</strong> ${amount} to the address below. Send only on the Bitcoin Cash network. Expires in ~${expiresIn} minutes.</p>
		<div style="background:#f5f5f5;padding:16px;border-radius:4px;margin-bottom:16px;font-family:ui-monospace,monospace;font-size:0.85rem;word-break:break-all;">
			<div style="margin-bottom:8px;"><strong>Address:</strong></div>
			<div style="user-select:all;">${escapeHtml(instructions.address)}</div>
			<div style="margin-top:12px;"><strong>Amount:</strong> ${amount}</div>
			<div style="margin-top:8px;"><strong>Wallet link:</strong></div>
			<div><a href="${escapeHtml(instructions.uri)}" style="color:#1a73e8;word-break:break-all;">${escapeHtml(instructions.uri)}</a></div>
		</div>
		<div style="display:flex;gap:8px;justify-content:flex-end;">
			<button type="button" data-action="close" style="padding:8px 16px;border:none;background:#1a1a1a;color:#fff;border-radius:4px;cursor:pointer;font:inherit;">Done</button>
		</div>
	`;

	overlay.appendChild(card);
	document.body.appendChild(overlay);

	const previouslyFocused = document.activeElement as HTMLElement | null;
	const closeBtn = card.querySelector<HTMLButtonElement>('[data-action="close"]');
	closeBtn?.focus();
	closeBtn?.addEventListener('click', () => callbacks.onClose());

	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') callbacks.onClose();
	};
	document.addEventListener('keydown', onKey);

	return () => {
		document.removeEventListener('keydown', onKey);
		overlay.remove();
		previouslyFocused?.focus();
	};
}

function escapeHtml(s: string): string {
	const map: Record<string, string> = {
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	};
	return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}
