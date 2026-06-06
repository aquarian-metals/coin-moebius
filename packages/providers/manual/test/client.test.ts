// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import createManualProvider, { type ManualInstructions } from '../src/index.js';

/**
 * Default checkout-endpoint response used across most tests. Overridden in
 * individual cases when a specific shape is needed.
 */
const okCheckoutResponse = () =>
	new Response(
		JSON.stringify({
			txId: 'tx_abc123',
			referenceCode: 'GBK-7F2A',
			mailingAddress: '1234 Commerce Way\nSuite 567\nLehi, UT 84043',
			expectedAmount: 30,
			expectedCurrency: 'Goldback',
			instructions: 'Mail 30 Goldbacks to the address above. Include the reference code.',
		}),
		{ status: 200 },
	);

const baseOptions = {
	productId: 'ebook-42',
	amount: 30,
	currency: 'Goldback',
};

const baseCallbacks = () => ({
	onSuccess: vi.fn(),
	onPending: vi.fn(),
	onError: vi.fn(),
});

describe('createManualProvider — default modal (happy-dom)', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(okCheckoutResponse());
	});

	afterEach(() => {
		// Defensive — some tests may leave a modal mounted on failure.
		document.body.innerHTML = '';
		vi.restoreAllMocks();
	});

	it('renders a modal with role="dialog" and aria-modal="true" on initiate', async () => {
		const provider = createManualProvider();
		await provider.initiate(baseOptions, baseCallbacks());

		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();
		expect(dialog?.getAttribute('aria-modal')).toBe('true');
		expect(dialog?.getAttribute('aria-labelledby')).toBe('cm-manual-title');
	});

	it('displays the reference code, mailing address, amount, and currency', async () => {
		const provider = createManualProvider();
		await provider.initiate(baseOptions, baseCallbacks());

		const dialogText = document.querySelector('[role="dialog"]')?.textContent ?? '';
		expect(dialogText).toContain('GBK-7F2A');
		expect(dialogText).toContain('1234 Commerce Way');
		expect(dialogText).toContain('Lehi, UT 84043');
		expect(dialogText).toContain('30');
		expect(dialogText).toContain('Goldback');
		expect(dialogText).toContain('Mail 30 Goldbacks to the address above');
	});

	it('focuses the "I\'ve shipped it" button on open', async () => {
		const provider = createManualProvider();
		await provider.initiate(baseOptions, baseCallbacks());

		const shippedBtn = document.querySelector<HTMLButtonElement>('[data-action="shipped"]');
		expect(shippedBtn).not.toBeNull();
		expect(document.activeElement).toBe(shippedBtn);
	});

	it('fires onPending with the normalized PaymentResult when "I\'ve shipped" is clicked', async () => {
		const provider = createManualProvider();
		const callbacks = baseCallbacks();
		await provider.initiate(baseOptions, callbacks);

		const shippedBtn = document.querySelector<HTMLButtonElement>('[data-action="shipped"]');
		shippedBtn?.click();

		expect(callbacks.onPending).toHaveBeenCalledOnce();
		const result = callbacks.onPending.mock.calls[0][0];
		expect(result.status).toBe('pending');
		expect(result.paymentId).toBe('tx_abc123');
		expect(result.provider).toBe('manual');
		expect(result.amount).toBe(30);
		expect(result.currency).toBe('Goldback');
		expect(result.metadata).toMatchObject({
			referenceCode: 'GBK-7F2A',
			mailingAddress: expect.stringContaining('Commerce Way'),
		});
	});

	it('removes the modal from the DOM when "I\'ve shipped" is clicked', async () => {
		const provider = createManualProvider();
		await provider.initiate(baseOptions, baseCallbacks());

		document.querySelector<HTMLButtonElement>('[data-action="shipped"]')?.click();

		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('removes the modal and fires no callback when "Cancel" is clicked', async () => {
		const provider = createManualProvider();
		const callbacks = baseCallbacks();
		await provider.initiate(baseOptions, callbacks);

		document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(callbacks.onSuccess).not.toHaveBeenCalled();
		expect(callbacks.onPending).not.toHaveBeenCalled();
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it('removes the modal and fires no callback when Escape is pressed', async () => {
		const provider = createManualProvider();
		const callbacks = baseCallbacks();
		await provider.initiate(baseOptions, callbacks);

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(callbacks.onPending).not.toHaveBeenCalled();
	});

	it('restores focus to the previously focused element when the modal closes', async () => {
		const trigger = document.createElement('button');
		trigger.textContent = 'Pay by mail';
		document.body.appendChild(trigger);
		trigger.focus();
		expect(document.activeElement).toBe(trigger);

		const provider = createManualProvider();
		await provider.initiate(baseOptions, baseCallbacks());

		// Modal opens, focus moves to "I've shipped".
		expect(document.activeElement).not.toBe(trigger);

		// Cancel closes — focus should restore.
		document.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
		expect(document.activeElement).toBe(trigger);
	});

	it('escapes HTML in the displayed instructions, address, and reference code', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					txId: 'tx_xss',
					referenceCode: '<script>alert(1)</script>',
					mailingAddress: '<img onerror="alert(2)" src="x">',
					expectedAmount: 30,
					expectedCurrency: '<b>Goldback</b>',
					instructions: '<iframe src="https://evil.example"></iframe>',
				}),
				{ status: 200 },
			),
		);

		const provider = createManualProvider();
		await provider.initiate(baseOptions, baseCallbacks());

		// No script, img, iframe, or b tags should have been inserted from the
		// data payload. (The modal itself contains structural elements but no
		// dangerous content from the response.)
		const dialog = document.querySelector('[role="dialog"]')!;
		expect(dialog.querySelector('script')).toBeNull();
		expect(dialog.querySelector('iframe')).toBeNull();
		expect(dialog.querySelector('img')).toBeNull();
		// `<b>` from the currency should have been escaped, not interpreted.
		expect(dialog.querySelector('b')).toBeNull();
		// The escaped text should still be visible (as literal text).
		expect(dialog.textContent).toContain('<script>alert(1)</script>');
		expect(dialog.textContent).toContain('<b>Goldback</b>');
	});

	it('uses a custom renderModal when provided, skipping the default modal', async () => {
		const customCleanup = vi.fn();
		// Typed factory so `customRenderer.mock.calls[0]` knows its args shape.
		const customRenderer = vi.fn(
			(
				_instructions: ManualInstructions,
				_callbacks: { onShipped: () => void; onCancel: () => void },
			) => customCleanup,
		);

		const provider = createManualProvider({ renderModal: customRenderer });
		await provider.initiate(baseOptions, baseCallbacks());

		expect(customRenderer).toHaveBeenCalledOnce();
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		const call = customRenderer.mock.calls[0];
		expect(call).toBeDefined();
		const [instructions, callbacks] = call;
		expect(instructions.referenceCode).toBe('GBK-7F2A');
		expect(typeof callbacks.onShipped).toBe('function');
		expect(typeof callbacks.onCancel).toBe('function');
	});

	it('routes a non-OK checkout response to onError without rendering a modal', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 503 }));

		const provider = createManualProvider();
		const callbacks = baseCallbacks();
		await provider.initiate(baseOptions, callbacks);

		expect(callbacks.onError).toHaveBeenCalledOnce();
		expect((callbacks.onError.mock.calls[0][0] as Error).message).toMatch(/returned 503/);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it('routes a malformed checkout response (missing fields) to onError', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ txId: 'only-id' }), { status: 200 }),
		);

		const provider = createManualProvider();
		const callbacks = baseCallbacks();
		await provider.initiate(baseOptions, callbacks);

		expect(callbacks.onError).toHaveBeenCalledOnce();
		expect((callbacks.onError.mock.calls[0][0] as Error).message).toMatch(
			/missing required fields/,
		);
	});
});
