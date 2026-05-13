/**
 * `<coin-moebius-buy>` — drop-in custom element that turns a static site into
 * a working checkout in two lines: one `<script>` tag for the registration
 * import, one element with the required attributes.
 *
 *     <coin-moebius-buy
 *       endpoint="https://api.coinmoebius.com"
 *       project-id="proj_abcd1234"
 *       product-id="goldback-bundle"
 *       amount="59.99"
 *       currency="USD">
 *       Buy now — $59.99
 *     </coin-moebius-buy>
 *
 * The element fetches the project's enabled providers from
 * `/api/projects/:id/public-info` on first click (not on mount — pages that
 * never get clicked don't pay the request). It then shows a modal with one
 * button per provider. Clicking a provider:
 *
 *   - **stripe / cryptomus** → `POST /api/checkout/:provider/:projectId`,
 *     redirect the buyer to the returned URL.
 *   - **manual** → same POST, but the response carries a reference code +
 *     mailing instructions which we render inline in the modal.
 *
 * Customization:
 *
 *   - Attribute `label` (or slotted text content) overrides the button text.
 *   - CSS custom properties: `--cm-color`, `--cm-bg`, `--cm-button-bg`,
 *     `--cm-button-color`, `--cm-button-radius`, `--cm-modal-overlay`,
 *     `--cm-modal-bg`.
 *   - `::part()` selectors: `button`, `modal`, `dialog`, `provider`,
 *     `provider-icon`, `provider-name`, `close`, `instructions`.
 *   - Events (CustomEvent, all cancelable): `cm-load-providers`,
 *     `cm-checkout-started`, `cm-error`.
 *
 * The element is intentionally framework-agnostic. It depends on nothing
 * outside the browser globals and the public Coin Moebius HTTP API — drop
 * it into any HTML page, Astro / Hugo / 11ty / Jekyll site, or even a
 * raw email-rendered preview (provided the renderer supports custom elements).
 */

/** Shape of `/api/projects/:projectId/public-info`. Kept in sync with the Cloud Worker. */
export interface PublicProjectInfo {
	projectId: string;
	providers: PublicProviderInfo[];
}

/** One enabled provider as advertised by the public-info endpoint. */
export interface PublicProviderInfo {
	id: string;
	name: string;
	publishableKey?: string;
	mailingAddress?: string;
	expectedCurrency?: string;
	goldbackRate?: number;
}

/** Shape of `/api/checkout/:provider/:projectId` for redirect-style providers. */
interface CheckoutRedirectResponse {
	url: string;
}

/** Shape of `/api/checkout/manual/:projectId`. */
interface CheckoutManualResponse {
	referenceCode: string;
	mailingAddress: string;
	expectedCurrency: string;
	amount: number;
	currency: string;
}

/** Observed attributes — drives `attributeChangedCallback`. */
const OBSERVED_ATTRS = [
	'endpoint',
	'project-id',
	'product-id',
	'amount',
	'currency',
	'label',
] as const;

/** Friendly display names for the v1 providers. Unknown ids fall back to the id. */
const PROVIDER_DISPLAY: Record<string, { name: string; icon: string }> = {
	stripe: { name: 'Credit card', icon: '💳' },
	cryptomus: { name: 'Cryptocurrency', icon: '🪙' },
	manual: { name: 'Pay by mail', icon: '✉️' },
};

const DEFAULT_LABEL = 'Buy';

/**
 * Shadow-DOM stylesheet. Encapsulated from the host page's CSS — the element
 * looks the same regardless of the surrounding stylesheet. Customization is
 * via custom properties and ::part(), declared on the host page's CSS.
 */
const STYLES = `
:host {
	display: inline-block;
	font-family: var(--cm-font, system-ui, -apple-system, sans-serif);
	color: var(--cm-color, #111);
}

button[part="button"] {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 0.5em;
	padding: 0.6em 1.2em;
	font: inherit;
	font-weight: 600;
	color: var(--cm-button-color, #fff);
	background: var(--cm-button-bg, #111);
	border: none;
	border-radius: var(--cm-button-radius, 6px);
	cursor: pointer;
	transition: opacity 120ms ease;
}

button[part="button"]:hover { opacity: 0.92; }
button[part="button"]:disabled { opacity: 0.6; cursor: progress; }

.modal {
	position: fixed;
	inset: 0;
	background: var(--cm-modal-overlay, rgba(0, 0, 0, 0.5));
	display: flex;
	align-items: center;
	justify-content: center;
	z-index: 10000;
}

.dialog {
	background: var(--cm-modal-bg, #fff);
	color: var(--cm-color, #111);
	border-radius: 12px;
	padding: 1.5rem;
	max-width: min(420px, calc(100vw - 2rem));
	width: 100%;
	max-height: calc(100vh - 2rem);
	overflow-y: auto;
	box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.dialog h2 {
	font-size: 1.125rem;
	margin: 0 0 0.5rem 0;
	font-weight: 700;
}

.dialog .total {
	margin: 0 0 1rem 0;
	font-size: 0.875rem;
	opacity: 0.75;
}

.providers {
	display: flex;
	flex-direction: column;
	gap: 0.5rem;
	margin-bottom: 1rem;
}

.provider {
	display: flex;
	align-items: center;
	gap: 0.75rem;
	padding: 0.75rem 1rem;
	font: inherit;
	font-weight: 500;
	color: inherit;
	background: transparent;
	border: 1px solid rgba(0, 0, 0, 0.15);
	border-radius: 8px;
	cursor: pointer;
	text-align: left;
	transition: background 120ms ease;
}

.provider:hover { background: rgba(0, 0, 0, 0.04); }
.provider:disabled { opacity: 0.6; cursor: progress; }

.provider-icon { font-size: 1.25rem; }
.provider-name { flex: 1; }

.close {
	background: transparent;
	border: none;
	font: inherit;
	font-size: 0.875rem;
	color: inherit;
	cursor: pointer;
	opacity: 0.6;
	padding: 0.25rem 0.5rem;
}
.close:hover { opacity: 1; }

.instructions {
	display: flex;
	flex-direction: column;
	gap: 0.75rem;
	margin-bottom: 1rem;
}
.instructions code {
	display: inline-block;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	padding: 0.4rem 0.6rem;
	background: rgba(0, 0, 0, 0.06);
	border-radius: 4px;
	font-size: 0.95em;
}

.error {
	color: #b91c1c;
	font-size: 0.875rem;
	margin: 0.5rem 0;
}

@media (prefers-color-scheme: dark) {
	:host { color: var(--cm-color, #f3f4f6); }
	.dialog { background: var(--cm-modal-bg, #1f2937); }
	.provider { border-color: rgba(255, 255, 255, 0.15); }
	.provider:hover { background: rgba(255, 255, 255, 0.06); }
	.instructions code { background: rgba(255, 255, 255, 0.08); }
}
`;

/** Internal modal state — null when closed. */
type ModalState =
	| { kind: 'loading' }
	| { kind: 'picking'; providers: PublicProviderInfo[] }
	| { kind: 'instructions'; payload: CheckoutManualResponse; provider: PublicProviderInfo }
	| { kind: 'error'; message: string };

export class CoinMoebiusBuyElement extends HTMLElement {
	static get observedAttributes(): readonly string[] {
		return OBSERVED_ATTRS;
	}

	private modalState: ModalState | null = null;
	private cachedProjectInfo: PublicProjectInfo | null = null;
	private fetchImpl: typeof fetch = (...args) => fetch(...args);
	private navigateImpl: (url: string) => void = (url) => {
		window.location.assign(url);
	};
	/**
	 * Element that had focus before the modal opened. We restore focus here
	 * when the modal closes — standard a11y pattern so keyboard users don't
	 * get yanked back to the top of the document.
	 */
	private triggerForRestore: HTMLElement | null = null;
	/** Keydown handler bound on modal open; unbound on close. */
	private modalKeydownHandler: EventListener | null = null;

	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
	}

	connectedCallback(): void {
		this.render();
	}

	attributeChangedCallback(): void {
		// Re-render the trigger so attribute changes (e.g., label, amount)
		// reflect immediately. The modal is rendered on demand and reads
		// attributes at click time, so it doesn't need re-rendering here.
		if (this.modalState === null) this.render();
	}

	// --- public API ------------------------------------------------------

	/**
	 * Trigger the picker programmatically. Equivalent to a user clicking the
	 * default button. Used by consumers who want to wrap the element with
	 * their own UI.
	 */
	open(): Promise<void> {
		return this.handleClick();
	}

	/**
	 * Inject a custom fetch implementation. Primarily for tests — production
	 * usage relies on the page's global `fetch`.
	 */
	setFetch(fn: typeof fetch): void {
		this.fetchImpl = fn;
	}

	/**
	 * Inject a custom navigation implementation. Primarily for tests — production
	 * usage redirects via `window.location.assign`.
	 */
	setNavigate(fn: (url: string) => void): void {
		this.navigateImpl = fn;
	}

	// --- internals -------------------------------------------------------

	private getRequiredAttr(name: string): string {
		const value = this.getAttribute(name);
		if (!value) {
			throw new Error(`coin-moebius-buy: missing required attribute "${name}"`);
		}
		return value;
	}

	private async handleClick(): Promise<void> {
		try {
			// Capture the focused element before we rip control away — only on
			// the initial open, not on intra-modal transitions.
			if (this.modalState === null) {
				this.triggerForRestore = (document.activeElement as HTMLElement | null) ?? this;
			}
			this.modalState = { kind: 'loading' };
			this.render();

			this.dispatchCustomEvent('cm-load-providers');
			const info = await this.loadProjectInfo();
			this.modalState = { kind: 'picking', providers: info.providers };
			this.render();
		} catch (err) {
			this.surfaceError(err);
		}
	}

	private async loadProjectInfo(): Promise<PublicProjectInfo> {
		if (this.cachedProjectInfo) return this.cachedProjectInfo;
		const endpoint = this.getRequiredAttr('endpoint');
		const projectId = this.getRequiredAttr('project-id');
		const response = await this.fetchImpl(
			`${endpoint.replace(/\/$/, '')}/api/projects/${encodeURIComponent(projectId)}/public-info`,
		);
		if (!response.ok) {
			throw new Error(`coin-moebius-buy: public-info responded ${response.status}`);
		}
		const info = (await response.json()) as PublicProjectInfo;
		this.cachedProjectInfo = info;
		return info;
	}

	private async pickProvider(provider: PublicProviderInfo): Promise<void> {
		try {
			const cancelEvent = this.dispatchCustomEvent('cm-checkout-started', {
				provider: provider.id,
			});
			if (cancelEvent.defaultPrevented) return;

			const endpoint = this.getRequiredAttr('endpoint');
			const projectId = this.getRequiredAttr('project-id');
			const body = {
				productId: this.getRequiredAttr('product-id'),
				amount: Number.parseFloat(this.getRequiredAttr('amount')),
				currency: this.getRequiredAttr('currency'),
			};
			if (!Number.isFinite(body.amount) || body.amount <= 0) {
				throw new Error('coin-moebius-buy: amount attribute must be a positive number');
			}

			const response = await this.fetchImpl(
				`${endpoint.replace(/\/$/, '')}/api/checkout/${encodeURIComponent(provider.id)}/${encodeURIComponent(projectId)}`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				},
			);
			if (!response.ok) {
				throw new Error(`coin-moebius-buy: checkout responded ${response.status}`);
			}

			if (provider.id === 'manual') {
				const payload = (await response.json()) as CheckoutManualResponse;
				this.modalState = { kind: 'instructions', payload, provider };
				this.render();
			} else {
				const payload = (await response.json()) as CheckoutRedirectResponse;
				if (!payload.url) {
					throw new Error('coin-moebius-buy: checkout response missing redirect URL');
				}
				this.navigateImpl(payload.url);
			}
		} catch (err) {
			this.surfaceError(err);
		}
	}

	private surfaceError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		this.modalState = { kind: 'error', message };
		this.render();
		const event = new CustomEvent('cm-error', {
			detail: { error: err },
			bubbles: true,
			composed: true,
			cancelable: false,
		});
		this.dispatchEvent(event);
	}

	private dispatchCustomEvent(name: string, detail?: Record<string, unknown>): CustomEvent {
		const event = new CustomEvent(name, {
			detail: detail ?? {},
			bubbles: true,
			composed: true,
			cancelable: true,
		});
		this.dispatchEvent(event);
		return event;
	}

	private closeModal(): void {
		this.modalState = null;
		// Tear down the trap before re-rendering — otherwise the listener
		// stays bound to a detached node.
		if (this.modalKeydownHandler) {
			(this.shadowRoot as unknown as EventTarget | null)?.removeEventListener(
				'keydown',
				this.modalKeydownHandler,
			);
			this.modalKeydownHandler = null;
		}
		this.render();

		// Restore focus to whatever held it before the modal opened. Defer
		// one frame so the DOM has settled — focusing a button that's about
		// to be re-rendered fails silently.
		const restore = this.triggerForRestore;
		this.triggerForRestore = null;
		if (restore && typeof restore.focus === 'function') {
			queueMicrotask(() => restore.focus());
		}
	}

	/**
	 * Focus-trap implementation. While the modal is open:
	 *   - `Escape` closes the modal.
	 *   - `Tab` cycles forward through focusable elements within the dialog.
	 *   - `Shift+Tab` cycles backward.
	 * Focus can't escape the dialog; that's the contract of a modal dialog.
	 */
	private installFocusTrap(shadow: ShadowRoot): void {
		if (this.modalKeydownHandler) {
			(shadow as unknown as EventTarget).removeEventListener('keydown', this.modalKeydownHandler);
		}
		this.modalKeydownHandler = ((event: Event) => {
			const kbd = event as KeyboardEvent;
			if (kbd.key === 'Escape') {
				kbd.preventDefault();
				this.closeModal();
				return;
			}
			if (kbd.key !== 'Tab') return;
			const focusables = this.collectFocusables(shadow);
			if (focusables.length === 0) return;

			const active = shadow.activeElement as HTMLElement | null;
			const currentIndex = active ? focusables.indexOf(active) : -1;
			const dir = kbd.shiftKey ? -1 : 1;
			let nextIndex = currentIndex + dir;
			if (nextIndex < 0) nextIndex = focusables.length - 1;
			if (nextIndex >= focusables.length) nextIndex = 0;

			kbd.preventDefault();
			focusables[nextIndex].focus();
		});
		(shadow as unknown as EventTarget).addEventListener('keydown', this.modalKeydownHandler);
	}

	private collectFocusables(shadow: ShadowRoot): HTMLElement[] {
		const selectors = [
			'button:not([disabled])',
			'[href]',
			'input:not([disabled])',
			'select:not([disabled])',
			'textarea:not([disabled])',
			'[tabindex]:not([tabindex="-1"])',
		].join(',');
		const dialog = shadow.querySelector<HTMLElement>('.dialog');
		if (!dialog) return [];
		return Array.from(dialog.querySelectorAll<HTMLElement>(selectors));
	}

	// --- rendering -------------------------------------------------------

	private render(): void {
		const shadow = this.shadowRoot;
		if (!shadow) return;

		const label = this.getAttribute('label') ?? this.textContent?.trim() ?? '';
		const buttonLabel = label || DEFAULT_LABEL;
		const modalHtml = this.renderModal();

		shadow.innerHTML = `
<style>${STYLES}</style>
<button part="button" type="button">${escapeHtml(buttonLabel)}</button>
${modalHtml}
`;

		const trigger = shadow.querySelector('button[part="button"]');
		trigger?.addEventListener('click', () => {
			void this.handleClick();
		});

		this.wireModalEvents(shadow);
	}

	private renderModal(): string {
		const state = this.modalState;
		if (state === null) return '';

		const amount = this.getAttribute('amount') ?? '';
		const currency = this.getAttribute('currency') ?? '';

		const total =
			amount && currency
				? `<p class="total">${escapeHtml(amount)} ${escapeHtml(currency)}</p>`
				: '';

		let body = '';
		if (state.kind === 'loading') {
			body = `<p>Loading payment options…</p>`;
		} else if (state.kind === 'error') {
			body = `<p class="error" part="error">${escapeHtml(state.message)}</p>`;
		} else if (state.kind === 'picking') {
			body = `
				<div class="providers" role="group" aria-label="Payment providers">
					${state.providers
						.map((p) => {
							const display = PROVIDER_DISPLAY[p.id] ?? { name: p.name, icon: '💸' };
							return `
								<button
									class="provider"
									part="provider"
									data-provider-id="${escapeAttr(p.id)}"
									type="button"
									aria-label="Pay with ${escapeAttr(display.name)}"
								>
									<span class="provider-icon" part="provider-icon" aria-hidden="true">${escapeHtml(display.icon)}</span>
									<span class="provider-name" part="provider-name">${escapeHtml(display.name)}</span>
								</button>
							`;
						})
						.join('')}
				</div>
			`;
		} else if (state.kind === 'instructions') {
			body = `
				<div class="instructions" part="instructions">
					<p>Mail your payment to:</p>
					<p><strong>${escapeHtml(state.payload.mailingAddress)}</strong></p>
					<p>Include the reference code with your payment:</p>
					<p><code>${escapeHtml(state.payload.referenceCode)}</code></p>
					<p>Amount: <strong>${escapeHtml(state.payload.amount.toString())} ${escapeHtml(state.payload.expectedCurrency)}</strong></p>
				</div>
			`;
		}

		return `
			<div class="modal" part="modal">
				<div
					class="dialog"
					part="dialog"
					role="dialog"
					aria-modal="true"
					aria-labelledby="cm-dialog-title"
					aria-describedby="cm-dialog-status"
				>
					<h2 id="cm-dialog-title">Pay ${escapeHtml(currency)}</h2>
					${total}
					<div id="cm-dialog-status" class="dialog__status" aria-live="polite" aria-atomic="true">
						${body}
					</div>
					<button class="close" part="close" type="button">Cancel</button>
				</div>
			</div>
		`;
	}

	private wireModalEvents(shadow: ShadowRoot): void {
		// No modal currently mounted — nothing to wire and no trap needed.
		if (this.modalState === null) return;

		const close = shadow.querySelector('.close');
		close?.addEventListener('click', () => this.closeModal());

		const overlay = shadow.querySelector('.modal');
		overlay?.addEventListener('click', (event) => {
			if (event.target === overlay) this.closeModal();
		});

		shadow.querySelectorAll<HTMLButtonElement>('.provider').forEach((btn) => {
			btn.addEventListener('click', () => {
				const id = btn.dataset.providerId;
				const state = this.modalState;
				if (!id || state?.kind !== 'picking') return;
				const provider = state.providers.find((p) => p.id === id);
				if (provider) void this.pickProvider(provider);
			});
		});

		this.installFocusTrap(shadow);

		// Move focus into the dialog so keyboard users land where the action
		// is. Pick the first non-Cancel focusable — provider buttons in the
		// picking state, the close button otherwise.
		queueMicrotask(() => {
			const focusables = this.collectFocusables(shadow);
			const target =
				focusables.find((el) => !el.classList.contains('close')) ?? focusables[0] ?? null;
			target?.focus();
		});
	}
}

/** Element tag name. Exported so consumers can detect / re-use it. */
export const COIN_MOEBIUS_BUY_TAG = 'coin-moebius-buy';

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
	return escapeHtml(value);
}
