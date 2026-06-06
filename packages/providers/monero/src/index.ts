/**
 * Monero client-side provider for Coin Moebius.
 *
 * Self-hosted flow — the browser POSTs to a checkout endpoint on the
 * merchant's own backend, which mints a Monero subaddress via the
 * merchant's `monero-wallet-rpc` and returns payment instructions. The
 * buyer sees those instructions (rendered in a modal — overridable) and
 * pays from their own wallet. The merchant's separately-running indexer
 * watches the chain and posts a webhook to the merchant's own webhook
 * endpoint when the payment confirms.
 *
 * Why a modal and not a redirect: there is no third-party hosted page to
 * redirect to. The merchant *is* the gateway. The buyer stays on the
 * merchant's site, sees a QR code and a `monero:` URI, and pays.
 *
 *     import { createMoneroProvider } from '@aquarian-metals/coin-moebius-monero';
 *     const monero = createMoneroProvider({
 *       checkoutEndpoint: '/api/checkout/monero',
 *       statusEndpoint: '/api/payment-status',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [monero] });
 *     await manager.initiate({ productId: 'pro', amount: 0.1, currency: 'XMR' });
 */
import type { PaymentProvider, InitiateOptions } from '@aquarian-metals/coin-moebius-core';

/**
 * Shape of the payment instructions presented to the buyer. A custom
 * `renderModal` receives this and is responsible for displaying it.
 */
export interface MoneroInstructions {
	paymentId: string;
	/** Monero subaddress generated for this checkout. Globally unique. */
	address: string;
	/** Exact amount the buyer should send, in piconero (10^-12 XMR), as a string to avoid float precision loss. */
	atomicAmount: string;
	/** Same amount expressed as decimal XMR, for human display. */
	xmrAmount: number;
	/** `monero:address?tx_amount=…` URI suitable for a QR code or wallet deep link. */
	uri: string;
	/** Epoch milliseconds. After this, the merchant's indexer will mark the payment failed if unpaid. */
	expiresAt: number;
}

/** Client-side config. All secrets stay server-side. */
export interface MoneroProviderConfig {
	/**
	 * Full URL (or relative path) of the checkout endpoint that calls
	 * `createMoneroCreator(...)` on the server and returns
	 * {@link MoneroInstructions}. Defaults to `/api/checkout/monero`.
	 */
	checkoutEndpoint?: string;

	/**
	 * Optional URL (or relative path) of a status endpoint that returns
	 * the current `PaymentRecord` for a `paymentId`. When provided, the
	 * provider attaches the URL to the pending result's metadata so the
	 * caller can hand it to `payments.subscribeToStatus(paymentId, …)`
	 * without separately configuring the manager.
	 */
	statusEndpoint?: string;

	/**
	 * Optional custom modal renderer. Receives the buyer-facing
	 * instructions and a `close()` callback. Must return a cleanup
	 * function that removes the modal from the DOM.
	 *
	 * When omitted, a minimal inline-styled modal is rendered showing the
	 * address, amount, and a QR-friendly `monero:` URI. The default is a
	 * working fallback, not a styling target — most production sites will
	 * provide their own renderer.
	 */
	renderModal?: (
		instructions: MoneroInstructions,
		callbacks: { onClose: () => void },
	) => () => void;

	/** Optional `fetch` override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
}

/**
 * Build a `PaymentProvider` registered as `id: 'monero'`. Calls
 * `onPending` once the buyer-facing modal is shown; never calls
 * `onSuccess` directly (chain confirmations land asynchronously via the
 * indexer → webhook → status-store path). Consumers wanting buyer-side
 * "paid!" notice should call `manager.subscribeToStatus(paymentId, ...)`
 * after `initiate` resolves.
 */
export function createMoneroProvider(config: MoneroProviderConfig = {}): PaymentProvider {
	const checkoutEndpoint = config.checkoutEndpoint ?? '/api/checkout/monero';
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const renderer = config.renderModal ?? defaultRenderModal;

	return {
		id: 'monero',
		name: 'Monero',
		async initiate(options: InitiateOptions, callbacks): Promise<void> {
			try {
				const instructions = await fetchInstructions(fetcher, checkoutEndpoint, options);

				const cleanup = renderer(instructions, {
					onClose: () => cleanup(),
				});

				callbacks.onPending?.({
					status: 'pending',
					paymentId: instructions.paymentId,
					provider: 'monero',
					amount: options.amount,
					currency: options.currency,
					metadata: {
						...(options.metadata ?? {}),
						address: instructions.address,
						atomicAmount: instructions.atomicAmount,
						xmrAmount: instructions.xmrAmount,
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

const ALLOWED_URI_SCHEMES = new Set(['monero:']);

function validateUri(uri: string): string {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new Error('coin-moebius/monero: checkout response contains an invalid URI');
	}
	if (!ALLOWED_URI_SCHEMES.has(parsed.protocol)) {
		throw new Error(
			`coin-moebius/monero: URI scheme "${parsed.protocol}" is not allowed (expected monero:)`,
		);
	}
	return uri;
}

async function fetchInstructions(
	fetcher: typeof fetch,
	endpoint: string,
	options: InitiateOptions,
): Promise<MoneroInstructions> {
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
		throw new Error(`coin-moebius/monero: checkout endpoint responded ${response.status}`);
	}
	const payload = (await response.json()) as Partial<MoneroInstructions>;
	if (
		typeof payload.paymentId !== 'string' ||
		typeof payload.address !== 'string' ||
		typeof payload.atomicAmount !== 'string' ||
		typeof payload.uri !== 'string'
	) {
		throw new Error(
			'coin-moebius/monero: checkout response missing required fields (paymentId, address, atomicAmount, uri)',
		);
	}
	payload.uri = validateUri(payload.uri);
	return payload as MoneroInstructions;
}

/**
 * Minimal default modal. Communicates the address, exact amount, and a
 * `monero:` URI in clickable + selectable form. Uses inline styles to
 * survive arbitrary host-page CSS. Custom modals via `renderModal` are
 * encouraged for any production site.
 *
 * Intentionally no QR-code rendering in the default — that'd pull a
 * library into the browser bundle and bloat the package. Production
 * consumers render their own QR (e.g. via `qrcode-generator` or an
 * inline-SVG implementation) inside their custom `renderModal`.
 */
function defaultRenderModal(
	instructions: MoneroInstructions,
	callbacks: { onClose: () => void },
): () => void {
	const overlay = document.createElement('div');
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-labelledby', 'cm-monero-title');
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

	card.innerHTML = `
		<h2 id="cm-monero-title" style="margin:0 0 8px;font-size:1.25rem;">Pay with Monero</h2>
		<p style="margin:0 0 16px;color:#555;">Send <strong>exactly</strong> ${instructions.xmrAmount} XMR to the address below. Expires in ~${expiresIn} minutes.</p>
		<div style="background:#f5f5f5;padding:16px;border-radius:4px;margin-bottom:16px;font-family:ui-monospace,monospace;font-size:0.85rem;word-break:break-all;">
			<div style="margin-bottom:8px;"><strong>Address:</strong></div>
			<div style="user-select:all;">${escapeHtml(instructions.address)}</div>
			<div style="margin-top:12px;"><strong>Amount:</strong> ${instructions.xmrAmount} XMR</div>
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
