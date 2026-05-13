// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	CoinMoebiusBuyElement,
	COIN_MOEBIUS_BUY_TAG,
	type PublicProjectInfo,
} from '../src/element-class.js';

/**
 * Tests for the `<coin-moebius-buy>` custom element. Runs inside happy-dom
 * (Vitest pragma at the top). We register the element manually rather than
 * importing the side-effect module to keep each test in control of when
 * registration happens.
 */

if (!customElements.get(COIN_MOEBIUS_BUY_TAG)) {
	customElements.define(COIN_MOEBIUS_BUY_TAG, CoinMoebiusBuyElement);
}

interface StubbedElement {
	el: CoinMoebiusBuyElement;
	fetchStub: ReturnType<typeof vi.fn>;
	navigateStub: ReturnType<typeof vi.fn>;
}

function mountElement(attrs: Record<string, string>, slotText = ''): StubbedElement {
	const el = document.createElement(COIN_MOEBIUS_BUY_TAG) as CoinMoebiusBuyElement;
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	if (slotText) el.textContent = slotText;
	const fetchStub = vi.fn();
	const navigateStub = vi.fn();
	el.setFetch(fetchStub);
	el.setNavigate(navigateStub);
	document.body.appendChild(el);
	return { el, fetchStub, navigateStub };
}

beforeEach(() => {
	document.body.innerHTML = '';
});

const defaultAttrs = {
	endpoint: 'http://test',
	'project-id': 'proj_test',
	'product-id': 'prod_test',
	amount: '9.99',
	currency: 'USD',
};

function publicInfoResponse(providers: PublicProjectInfo['providers']): Response {
	return new Response(JSON.stringify({ projectId: 'proj_test', providers }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

describe('<coin-moebius-buy> trigger button', () => {
	it('renders a button with the default label when no override is set', () => {
		const { el } = mountElement(defaultAttrs);
		const button = el.shadowRoot!.querySelector('button[part="button"]');
		expect(button).not.toBeNull();
		expect(button!.textContent).toBe('Buy');
	});

	it('renders the `label` attribute as the button text when provided', () => {
		const { el } = mountElement({ ...defaultAttrs, label: 'Get yours' });
		expect(el.shadowRoot!.querySelector('button[part="button"]')!.textContent).toBe('Get yours');
	});

	it('renders the slotted text content as the button text', () => {
		const { el } = mountElement(defaultAttrs, 'Buy now — $9.99');
		expect(el.shadowRoot!.querySelector('button[part="button"]')!.textContent).toBe(
			'Buy now — $9.99',
		);
	});

	it('escapes HTML in the label to prevent XSS', () => {
		const { el } = mountElement({ ...defaultAttrs, label: '<img src=x onerror=alert(1)>' });
		const button = el.shadowRoot!.querySelector('button[part="button"]')!;
		expect(button.innerHTML).not.toContain('<img');
		expect(button.textContent).toContain('<img');
	});
});

describe('<coin-moebius-buy> provider picker', () => {
	it('fetches public-info on first click and renders provider buttons', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(
			publicInfoResponse([
				{ id: 'stripe', name: 'Stripe', publishableKey: 'pk_test_x' },
				{ id: 'manual', name: 'Pay by mail', mailingAddress: '123 Main' },
			]),
		);

		await el.open();

		expect(fetchStub).toHaveBeenCalledTimes(1);
		const calledUrl = fetchStub.mock.calls[0][0] as string;
		expect(calledUrl).toContain('/api/projects/proj_test/public-info');

		const buttons = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.provider'));
		expect(buttons).toHaveLength(2);
		expect(buttons.map((b) => b.dataset.providerId)).toEqual(['stripe', 'manual']);
	});

	it('reuses the cached public-info on a second click without refetching', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(
			publicInfoResponse([{ id: 'stripe', name: 'Stripe', publishableKey: 'pk_test_x' }]),
		);

		await el.open();
		// Close + reopen.
		el.shadowRoot!.querySelector<HTMLButtonElement>('.close')!.click();
		await el.open();

		expect(fetchStub).toHaveBeenCalledTimes(1);
	});

	it('surfaces an error state when public-info responds non-2xx', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(new Response('', { status: 503 }));

		const errors: CustomEvent[] = [];
		el.addEventListener('cm-error', (e) => errors.push(e as CustomEvent));

		await el.open();

		expect(el.shadowRoot!.querySelector('.error')).not.toBeNull();
		expect(errors).toHaveLength(1);
	});
});

describe('<coin-moebius-buy> checkout flow', () => {
	it('redirects to the Stripe checkout URL on stripe pick', async () => {
		const { el, fetchStub, navigateStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(
			publicInfoResponse([{ id: 'stripe', name: 'Stripe', publishableKey: 'pk_test_x' }]),
		);
		fetchStub.mockResolvedValueOnce(
			new Response(JSON.stringify({ url: 'https://checkout.stripe.com/session_xyz' }), {
				status: 200,
			}),
		);

		await el.open();
		el.shadowRoot!.querySelector<HTMLButtonElement>(
			'.provider[data-provider-id="stripe"]',
		)!.click();
		await flushPromises();

		expect(fetchStub).toHaveBeenCalledTimes(2);
		const [, checkoutCall] = fetchStub.mock.calls;
		expect(checkoutCall[0] as string).toContain('/api/checkout/stripe/proj_test');
		expect(navigateStub).toHaveBeenCalledWith('https://checkout.stripe.com/session_xyz');
	});

	it('renders manual instructions inline instead of redirecting', async () => {
		const { el, fetchStub, navigateStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(
			publicInfoResponse([{ id: 'manual', name: 'Pay by mail', mailingAddress: '123 Main St' }]),
		);
		fetchStub.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					referenceCode: 'GBK-7F2A',
					mailingAddress: '123 Main St',
					expectedCurrency: 'Goldback',
					amount: 9.99,
					currency: 'USD',
				}),
				{ status: 200 },
			),
		);

		await el.open();
		el.shadowRoot!.querySelector<HTMLButtonElement>(
			'.provider[data-provider-id="manual"]',
		)!.click();
		await flushPromises();

		expect(navigateStub).not.toHaveBeenCalled();
		const instructions = el.shadowRoot!.querySelector('[part="instructions"]');
		expect(instructions).not.toBeNull();
		expect(instructions!.textContent).toContain('GBK-7F2A');
		expect(instructions!.textContent).toContain('123 Main St');
	});

	it('emits a cancelable cm-checkout-started event and respects preventDefault', async () => {
		const { el, fetchStub, navigateStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(publicInfoResponse([{ id: 'stripe', name: 'Stripe' }]));

		el.addEventListener('cm-checkout-started', (e) => e.preventDefault());

		await el.open();
		el.shadowRoot!.querySelector<HTMLButtonElement>(
			'.provider[data-provider-id="stripe"]',
		)!.click();
		await flushPromises();

		// Cancelled event → no second fetch, no navigation.
		expect(fetchStub).toHaveBeenCalledTimes(1);
		expect(navigateStub).not.toHaveBeenCalled();
	});

	it('throws if the amount attribute is not a positive number', async () => {
		const { el, fetchStub, navigateStub } = mountElement({ ...defaultAttrs, amount: 'oops' });
		fetchStub.mockResolvedValueOnce(publicInfoResponse([{ id: 'stripe', name: 'Stripe' }]));

		const errors: CustomEvent[] = [];
		el.addEventListener('cm-error', (e) => errors.push(e as CustomEvent));

		await el.open();
		el.shadowRoot!.querySelector<HTMLButtonElement>(
			'.provider[data-provider-id="stripe"]',
		)!.click();
		await flushPromises();

		expect(navigateStub).not.toHaveBeenCalled();
		expect(errors).toHaveLength(1);
		expect((errors[0].detail as { error: Error }).error.message).toContain('amount');
	});
});

describe('<coin-moebius-buy> modal lifecycle', () => {
	it('closes the modal when the Cancel button is clicked', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(publicInfoResponse([{ id: 'stripe', name: 'Stripe' }]));

		await el.open();
		expect(el.shadowRoot!.querySelector('.modal')).not.toBeNull();
		el.shadowRoot!.querySelector<HTMLButtonElement>('.close')!.click();
		expect(el.shadowRoot!.querySelector('.modal')).toBeNull();
	});

	it('closes the modal when the backdrop is clicked', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(publicInfoResponse([{ id: 'stripe', name: 'Stripe' }]));

		await el.open();
		const overlay = el.shadowRoot!.querySelector<HTMLDivElement>('.modal')!;
		overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// Note: happy-dom's event.target equality holds; we cheat by simulating
		// the direct overlay click via a click() on the element itself.
		overlay.click();
		expect(el.shadowRoot!.querySelector('.modal')).toBeNull();
	});

	it('closes the modal on Escape', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(publicInfoResponse([{ id: 'stripe', name: 'Stripe' }]));

		await el.open();
		expect(el.shadowRoot!.querySelector('.modal')).not.toBeNull();

		el.shadowRoot!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
		);
		expect(el.shadowRoot!.querySelector('.modal')).toBeNull();
	});
});

describe('<coin-moebius-buy> accessibility', () => {
	it('marks the dialog with role/aria-modal/aria-labelledby for screen readers', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(publicInfoResponse([{ id: 'stripe', name: 'Stripe' }]));

		await el.open();
		const dialog = el.shadowRoot!.querySelector('.dialog')!;
		expect(dialog.getAttribute('role')).toBe('dialog');
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		expect(dialog.getAttribute('aria-labelledby')).toBe('cm-dialog-title');
	});

	it('marks each provider button with an aria-label that names the provider', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(
			publicInfoResponse([
				{ id: 'stripe', name: 'Stripe' },
				{ id: 'manual', name: 'Pay by mail' },
			]),
		);

		await el.open();
		const buttons = Array.from(el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.provider'));
		expect(buttons[0].getAttribute('aria-label')).toContain('Credit card');
		expect(buttons[1].getAttribute('aria-label')).toContain('Pay by mail');
	});

	it('cycles focus within the dialog when Tab/Shift+Tab is pressed', async () => {
		const { el, fetchStub } = mountElement(defaultAttrs);
		fetchStub.mockResolvedValueOnce(
			publicInfoResponse([
				{ id: 'stripe', name: 'Stripe' },
				{ id: 'manual', name: 'Pay by mail' },
			]),
		);

		await el.open();
		// happy-dom may not have moved focus on its own — drive it explicitly.
		const focusables = Array.from(
			el.shadowRoot!.querySelectorAll<HTMLButtonElement>('.dialog button'),
		);
		// Should be: 2 provider buttons + 1 close button = 3 focusable.
		expect(focusables).toHaveLength(3);
		focusables[0].focus();
		expect(el.shadowRoot!.activeElement).toBe(focusables[0]);

		el.shadowRoot!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
		);
		expect(el.shadowRoot!.activeElement).toBe(focusables[1]);

		// Shift+Tab from the first wraps to the last.
		focusables[0].focus();
		el.shadowRoot!.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
		);
		expect(el.shadowRoot!.activeElement).toBe(focusables[focusables.length - 1]);
	});
});

/** Flush microtask + macrotask queues. happy-dom resolves nested promises lazily. */
async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}
