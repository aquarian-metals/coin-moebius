/**
 * Zano client-side provider for Coin Moebius.
 *
 * Self-hosted flow. The browser POSTs to a checkout endpoint on the
 * merchant's own backend, which asks the merchant's `simplewallet` RPC for
 * an integrated address (a Zano address with a payment id folded in) and
 * returns payment instructions. The buyer sees those instructions in a
 * modal and pays from their own wallet, in ZANO or in any Zano asset the
 * merchant accepts, Freedom Dollar included. The merchant's separately
 * running indexer watches the wallet and posts a webhook when the payment
 * confirms.
 *
 * One provider instance pays in one asset. Register a second instance with
 * its own `id` to offer a second asset:
 *
 *     import { createZanoProvider, FREEDOM_DOLLAR_ASSET_ID } from '@aquarian-metals/coin-moebius-zano';
 *
 *     const zano = createZanoProvider({ statusEndpoint: '/api/payment-status' });
 *     const fusd = createZanoProvider({
 *       id: 'fusd',
 *       name: 'Freedom Dollar',
 *       assetId: FREEDOM_DOLLAR_ASSET_ID,
 *       statusEndpoint: '/api/payment-status',
 *     });
 *
 *     const manager = createPaymentManager({ providers: [zano, fusd] });
 *     await manager.initiate({ providerId: 'fusd', productId: 'pro', amount: 19.99, currency: 'USD' });
 */
import type { PaymentProvider, InitiateOptions } from '@aquarian-metals/coin-moebius-core';

import { formatAtomic } from './assets.js';

export {
	ZANO_ASSET_ID,
	FREEDOM_DOLLAR_ASSET_ID,
	ZANO_NATIVE_ASSET,
	formatAtomic,
} from './assets.js';
export type { ZanoAsset } from './assets.js';

/**
 * Shape of the payment instructions presented to the buyer. A custom
 * `renderModal` receives this and is responsible for displaying it.
 */
export interface ZanoInstructions {
	paymentId: string;
	/** Integrated Zano address for this checkout. Carries the payment id, so the buyer pastes one thing. */
	address: string;
	/** Exact amount to send, in the asset's atomic units, as a string to avoid float precision loss. */
	atomicAmount: string;
	/** Same amount in whole units of the asset, for human display. */
	assetAmount: number;
	/** The asset the buyer pays with. The chain's own coin has an id too. */
	assetId: string;
	ticker: string;
	decimalPoint: number;
	/** `zano:action=send&…` link suitable for a QR code or a wallet deep link. Names the asset. */
	uri: string;
	/** Epoch milliseconds. After this, the merchant's indexer will mark the payment failed if unpaid. */
	expiresAt: number;
}

/** Client-side config. All secrets stay server-side. */
export interface ZanoProviderConfig {
	/**
	 * Provider id the payment manager routes on. Defaults to `'zano'`. Give
	 * a second instance its own id when offering more than one asset.
	 */
	id?: string;
	/** Display name. Defaults to `'Zano'`. */
	name?: string;
	/**
	 * Asset the buyer pays with. Omit to charge in ZANO. Sent to the checkout
	 * endpoint as `assetId`, where the creator looks the asset up on the
	 * merchant's own wallet.
	 */
	assetId?: string;
	/**
	 * Full URL (or relative path) of the checkout endpoint that calls
	 * `createZanoCreator(...)` on the server and returns
	 * {@link ZanoInstructions}. Defaults to `/api/checkout/zano`.
	 */
	checkoutEndpoint?: string;
	/**
	 * Optional URL (or relative path) of a status endpoint that returns the
	 * current `PaymentRecord` for a `paymentId`. When provided, the provider
	 * attaches it to the pending result's metadata so the caller can hand it
	 * to `payments.subscribeToStatus(paymentId, …)`.
	 */
	statusEndpoint?: string;
	/**
	 * Optional custom modal renderer. Receives the buyer-facing instructions
	 * and a `close()` callback. Must return a cleanup function that removes
	 * the modal from the DOM.
	 *
	 * When omitted, a minimal inline-styled modal shows the address, amount,
	 * asset, and the `zano:` link. The default is a working fallback, not a
	 * styling target.
	 */
	renderModal?: (instructions: ZanoInstructions, callbacks: { onClose: () => void }) => () => void;
	/** Optional `fetch` override. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
}

/**
 * Build a `PaymentProvider` for Zano. Calls `onPending` once the buyer-facing
 * modal is shown; never calls `onSuccess` directly, because chain
 * confirmations land asynchronously through the indexer, the webhook, and
 * the merchant's status store. Call `manager.subscribeToStatus(paymentId, …)`
 * after `initiate` resolves to be told when the payment settles.
 */
export function createZanoProvider(config: ZanoProviderConfig = {}): PaymentProvider {
	const id = config.id ?? 'zano';
	const checkoutEndpoint = config.checkoutEndpoint ?? '/api/checkout/zano';
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const renderer = config.renderModal ?? defaultRenderModal;

	return {
		id,
		name: config.name ?? 'Zano',
		async initiate(options: InitiateOptions, callbacks): Promise<void> {
			try {
				const instructions = await fetchInstructions(
					fetcher,
					checkoutEndpoint,
					options,
					config.assetId,
				);

				const cleanup = renderer(instructions, {
					onClose: () => cleanup(),
				});

				callbacks.onPending?.({
					status: 'pending',
					paymentId: instructions.paymentId,
					provider: id,
					amount: options.amount,
					currency: options.currency,
					metadata: {
						...(options.metadata ?? {}),
						address: instructions.address,
						atomicAmount: instructions.atomicAmount,
						assetAmount: instructions.assetAmount,
						assetId: instructions.assetId,
						ticker: instructions.ticker,
						decimalPoint: instructions.decimalPoint,
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

const ALLOWED_URI_SCHEMES = new Set(['zano:']);

function validateUri(uri: string): string {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new Error('coin-moebius/zano: checkout response contains an invalid URI');
	}
	if (!ALLOWED_URI_SCHEMES.has(parsed.protocol)) {
		throw new Error(
			`coin-moebius/zano: URI scheme "${parsed.protocol}" is not allowed (expected zano:)`,
		);
	}
	return uri;
}

async function fetchInstructions(
	fetcher: typeof fetch,
	endpoint: string,
	options: InitiateOptions,
	assetId: string | undefined,
): Promise<ZanoInstructions> {
	const response = await fetcher(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			productId: options.productId,
			amount: options.amount,
			currency: options.currency,
			...(assetId === undefined ? {} : { assetId }),
			metadata: options.metadata,
		}),
	});
	if (!response.ok) {
		throw new Error(`coin-moebius/zano: checkout endpoint responded ${response.status}`);
	}
	const payload = (await response.json()) as Partial<ZanoInstructions>;
	// Check every field the modal renders, not just the ones it routes on. A
	// missing number is not a blank on the screen, it is the word "undefined"
	// where an amount should be, or "NaN minutes" on the expiry line, and the
	// buyer has no way to tell that from a real instruction.
	if (
		typeof payload.paymentId !== 'string' ||
		typeof payload.address !== 'string' ||
		typeof payload.atomicAmount !== 'string' ||
		typeof payload.assetId !== 'string' ||
		typeof payload.ticker !== 'string' ||
		typeof payload.uri !== 'string' ||
		!Number.isFinite(payload.assetAmount) ||
		!Number.isInteger(payload.decimalPoint) ||
		!Number.isFinite(payload.expiresAt)
	) {
		throw new Error(
			'coin-moebius/zano: checkout response missing required fields (paymentId, address, atomicAmount, assetAmount, assetId, ticker, decimalPoint, uri, expiresAt)',
		);
	}
	payload.uri = validateUri(payload.uri);
	return payload as ZanoInstructions;
}

/**
 * Minimal default modal. Names the asset and the network on every line
 * that matters, because one Zano address takes every asset and a wallet
 * that ignores the link's asset falls back to ZANO. Uses inline styles to
 * survive arbitrary host-page CSS. No QR rendering, to keep the browser
 * bundle small; render your own inside a custom `renderModal`.
 */
function defaultRenderModal(
	instructions: ZanoInstructions,
	callbacks: { onClose: () => void },
): () => void {
	const overlay = document.createElement('div');
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-labelledby', 'cm-zano-title');
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
	const ticker = escapeHtml(instructions.ticker);
	// Print the atomic integer, not the float beside it. The atomic value is
	// what settles the invoice, and it is the only form that cannot show the
	// buyer binary noise or exponent notation in place of a payable number.
	const amount = `${escapeHtml(formatAtomic(BigInt(instructions.atomicAmount), instructions.decimalPoint))} ${ticker}`;

	card.innerHTML = `
		<h2 id="cm-zano-title" style="margin:0 0 8px;font-size:1.25rem;">Pay on Zano</h2>
		<p style="margin:0 0 16px;color:#555;">Send <strong>exactly</strong> ${amount} to the address below. Send only ${ticker} on the Zano network. Expires in ~${expiresIn} minutes.</p>
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
