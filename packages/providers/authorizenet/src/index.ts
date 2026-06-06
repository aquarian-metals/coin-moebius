/**
 * Authorize.Net client-side provider for Coin Moebius.
 *
 * Accept Hosted flow. Unlike Stripe / NOWPayments / PayPal / Coinbase Business
 * (which redirect via GET to a hosted URL), Authorize.Net requires a form
 * **POST** to land the buyer on the hosted page. The flow:
 *
 *   1. The provider POSTs the buyer's selection to the caller's
 *      `sessionEndpoint`, expecting `{ url, token }` back.
 *      - `url` is the Accept Hosted target (e.g.,
 *        `https://accept.authorize.net/payment/payment` for live,
 *        `https://test.authorize.net/payment/payment` for sandbox).
 *      - `token` is the 15-minute hosted-form token the caller's server
 *        minted via `getHostedPaymentPageRequest`.
 *   2. The provider fires `onPending`.
 *   3. The provider builds an off-DOM `<form action=url method=post>`, adds
 *      a hidden input `token=<token>`, attaches it to the document, and
 *      submits. The browser POSTs to Authorize.Net and the buyer lands on
 *      the hosted form. Same UX as the GET-redirect providers; just a
 *      mechanically different navigation step.
 *
 * After the buyer pays, the webhook lands on the server side. The SDK's
 * `subscribeToStatus` polls the merchant's `/status/<paymentId>` endpoint
 * for the eventual `onSuccess` call, exactly like every other provider.
 */
import type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
} from '@aquarian-metals/coin-moebius-core';

export interface AuthorizenetProviderConfig {
	/** Full URL of the session endpoint that returns `{ url, token }`. */
	sessionEndpoint: string;
	/** Optional fetch override — used by tests. Defaults to global `fetch`. */
	fetcher?: typeof fetch;
	/**
	 * Optional form-submit override — used by tests. Defaults to building an
	 * off-DOM `<form>`, adding hidden inputs for each field, attaching to
	 * `document.body`, calling `.submit()`, then removing.
	 */
	submitForm?: (action: string, fields: Record<string, string>) => void;
}

interface SessionResponse {
	url: string;
	token: string;
	/** Authorize.Net transaction reference, if the session endpoint mints one. */
	paymentId?: string;
}

function defaultSubmitForm(action: string, fields: Record<string, string>): void {
	const form = document.createElement('form');
	form.method = 'POST';
	form.action = action;
	form.style.display = 'none';
	for (const [name, value] of Object.entries(fields)) {
		const input = document.createElement('input');
		input.type = 'hidden';
		input.name = name;
		input.value = value;
		form.appendChild(input);
	}
	document.body.appendChild(form);
	form.submit();
}

/**
 * Build a `PaymentProvider` registered as `id: 'authorizenet'`. Fires
 * `onPending` immediately, then form-POSTs to the Accept Hosted page. Final
 * settlement lands on the server via webhook (HMAC-SHA512, see `./server`).
 */
export function createAuthorizenetProvider(config: AuthorizenetProviderConfig): PaymentProvider {
	const fetcher = config.fetcher ?? globalThis.fetch.bind(globalThis);
	const submitForm = config.submitForm ?? defaultSubmitForm;

	return {
		id: 'authorizenet',
		name: 'Authorize.Net',
		async initiate(options: InitiateOptions, callbacks): Promise<void> {
			try {
				const body: Record<string, unknown> = {
					productId: options.productId,
					amount: options.amount,
					currency: options.currency,
				};
				if (options.metadata) body.metadata = options.metadata;

				const response = await fetcher(config.sessionEndpoint, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				});
				if (!response.ok) {
					throw new Error(
						`coin-moebius/authorizenet: session endpoint responded ${response.status}`,
					);
				}
				const payload = (await response.json()) as SessionResponse;
				if (!payload.url || !payload.token) {
					throw new Error('coin-moebius/authorizenet: session response missing `url` or `token`');
				}

				const result: PaymentResult = {
					status: 'pending',
					paymentId: payload.paymentId ?? '',
					provider: 'authorizenet',
					amount: options.amount,
					currency: options.currency,
					metadata: options.metadata ?? {},
					timestamp: Date.now(),
				};
				callbacks.onPending?.(result);
				submitForm(payload.url, { token: payload.token });
			} catch (err) {
				callbacks.onError(err instanceof Error ? err : new Error(String(err)));
			}
		},
	};
}
