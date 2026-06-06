import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

/**
 * Configuration for the manual / async payment provider.
 */
export interface ManualProviderConfig {
	/**
	 * Endpoint on the seller's backend that mints a reference code and returns
	 * mailing instructions. Receives `{ productId, amount, currency, metadata }`
	 * via POST; must return a {@link ManualCheckoutResponse}.
	 *
	 * Defaults to `/api/checkout/manual`.
	 */
	checkoutEndpoint?: string;

	/**
	 * Optional custom modal renderer. When provided, replaces the built-in
	 * default modal entirely. Must return a cleanup function that removes the
	 * modal from the DOM.
	 *
	 * When omitted, a minimal inline-styled modal is rendered. The default is
	 * intended as a working fallback, not a styling target — most production
	 * sites will provide their own renderer here.
	 */
	renderModal?: (
		instructions: ManualInstructions,
		callbacks: { onShipped: () => void; onCancel: () => void },
	) => () => void;
}

/**
 * Mailing-instructions payload presented to the buyer.
 */
export interface ManualInstructions {
	referenceCode: string;
	mailingAddress: string;
	expectedAmount: number;
	expectedCurrency: string;
	humanInstructions: string;
}

/**
 * Response shape the `checkoutEndpoint` must return.
 */
export interface ManualCheckoutResponse {
	txId: string;
	referenceCode: string;
	mailingAddress: string;
	expectedAmount: number;
	expectedCurrency: string;
	instructions: string;
}

/**
 * Create a manual / async payment provider.
 *
 * The manual provider differs from card / crypto providers in three ways:
 * 1. It has no third-party script to load — confirmation happens out-of-band.
 * 2. It does not poll for status — manual confirmations take days, and email
 *    is the right channel for "your payment was received."
 * 3. There is no signature verification on the server side — the "event"
 *    that transitions a transaction to `succeeded` is an authenticated
 *    dashboard click by the seller, not an external webhook.
 *
 * The buyer's experience: click "Pay by mail" → see a modal with a reference
 * code and mailing address → mail the physical payment → close the page.
 * They get an email when the seller confirms receipt.
 *
 * @example
 *   const payments = createPaymentManager({
 *     providers: [createManualProvider({ checkoutEndpoint: '/api/checkout/manual' })],
 *   });
 *   payments.initiate({ productId: 'x', amount: 30, currency: 'Goldback', providerId: 'manual' });
 */
export default function createManualProvider(config: ManualProviderConfig = {}): PaymentProvider {
	const checkoutEndpoint = config.checkoutEndpoint ?? '/api/checkout/manual';
	const renderer = config.renderModal ?? defaultRenderModal;

	const provider: PaymentProvider = {
		id: 'manual',
		name: 'Pay by mail',

		async initiate(
			options: InitiateOptions,
			callbacks: {
				onSuccess: (result: PaymentResult) => void;
				onPending?: (result: PaymentResult) => void;
				onError: (error: Error) => void;
			},
		) {
			try {
				const checkout = await fetchCheckout(checkoutEndpoint, options);

				const cleanup = renderer(
					{
						referenceCode: checkout.referenceCode,
						mailingAddress: checkout.mailingAddress,
						expectedAmount: checkout.expectedAmount,
						expectedCurrency: checkout.expectedCurrency,
						humanInstructions: checkout.instructions,
					},
					{
						onShipped: () => {
							cleanup();
							callbacks.onPending?.({
								status: 'pending',
								paymentId: checkout.txId,
								provider: provider.id,
								amount: options.amount,
								currency: options.currency,
								metadata: {
									...(options.metadata ?? {}),
									referenceCode: checkout.referenceCode,
									mailingAddress: checkout.mailingAddress,
								},
								timestamp: Date.now(),
							});
						},
						onCancel: () => {
							cleanup();
							// Buyer chose to abandon — not an error, no callback.
						},
					},
				);
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};

	return provider;
}

/**
 * POST to the checkout endpoint and validate the response shape.
 *
 * Kept separate from `initiate` for testability — the network call is the
 * one piece worth mocking in isolation.
 */
async function fetchCheckout(
	endpoint: string,
	options: InitiateOptions,
): Promise<ManualCheckoutResponse> {
	const response = await fetch(endpoint, {
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
		throw new Error(`coin-moebius/manual: checkout endpoint returned ${response.status}`);
	}

	const checkout = (await response.json()) as Partial<ManualCheckoutResponse>;
	if (
		typeof checkout.txId !== 'string' ||
		typeof checkout.referenceCode !== 'string' ||
		typeof checkout.mailingAddress !== 'string'
	) {
		throw new Error('coin-moebius/manual: checkout response missing required fields');
	}

	return checkout as ManualCheckoutResponse;
}

/**
 * Minimal default modal — communicates the instructions and gives the buyer
 * the "I've shipped" / "Cancel" choice. Uses inline styles to avoid any host
 * page CSS interfering with the rendering. For a fully branded modal,
 * provide a custom `renderModal` via {@link ManualProviderConfig}.
 *
 * Accessibility: `role="dialog"` + `aria-modal="true"`, focuses the primary
 * action on open, restores focus to the previously focused element on close,
 * Escape key cancels.
 */
function defaultRenderModal(
	instructions: ManualInstructions,
	callbacks: { onShipped: () => void; onCancel: () => void },
): () => void {
	const overlay = document.createElement('div');
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-labelledby', 'cm-manual-title');
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
		'max-width:480px',
		'width:100%',
		'box-shadow:0 20px 60px rgba(0,0,0,0.2)',
	].join(';');

	card.innerHTML = `
		<h2 id="cm-manual-title" style="margin:0 0 16px;font-size:1.25rem;">Pay by mail</h2>
		<p style="margin:0 0 16px;">${escapeHtml(instructions.humanInstructions)}</p>
		<div style="background:#f5f5f5;padding:16px;border-radius:4px;margin-bottom:16px;font-family:ui-monospace,monospace;font-size:0.9rem;">
			<div><strong>Reference:</strong> ${escapeHtml(instructions.referenceCode)}</div>
			<div style="margin-top:8px;"><strong>Mail to:</strong></div>
			<div style="white-space:pre-line;">${escapeHtml(instructions.mailingAddress)}</div>
			<div style="margin-top:8px;"><strong>Amount:</strong> ${instructions.expectedAmount} ${escapeHtml(instructions.expectedCurrency)}</div>
		</div>
		<div style="display:flex;gap:8px;justify-content:flex-end;">
			<button type="button" data-action="cancel" style="padding:8px 16px;border:1px solid #ddd;background:#fff;border-radius:4px;cursor:pointer;font:inherit;">Cancel</button>
			<button type="button" data-action="shipped" style="padding:8px 16px;border:none;background:#1a1a1a;color:#fff;border-radius:4px;cursor:pointer;font:inherit;">I've shipped it</button>
		</div>
	`;

	overlay.appendChild(card);
	document.body.appendChild(overlay);

	const previouslyFocused = document.activeElement as HTMLElement | null;
	const shippedBtn = card.querySelector<HTMLButtonElement>('[data-action="shipped"]');
	const cancelBtn = card.querySelector<HTMLButtonElement>('[data-action="cancel"]');
	shippedBtn?.focus();

	shippedBtn?.addEventListener('click', () => callbacks.onShipped());
	cancelBtn?.addEventListener('click', () => callbacks.onCancel());

	// Escape closes the modal.
	const onKey = (e: KeyboardEvent) => {
		if (e.key === 'Escape') callbacks.onCancel();
	};
	document.addEventListener('keydown', onKey);

	return () => {
		document.removeEventListener('keydown', onKey);
		overlay.remove();
		previouslyFocused?.focus();
	};
}

/**
 * Minimal HTML escaper for values interpolated into the default modal markup.
 * Custom modals provided via `renderModal` can use a framework's templating
 * and don't need this.
 */
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
