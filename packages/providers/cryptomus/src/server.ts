import type { WebhookEvent } from '@aquarian-metals/coin-moebius-core';
import crypto from 'node:crypto';

// Cryptomus signs with: md5( base64(jsonBody) + paymentApiKey ).
// Reference: https://doc.cryptomus.com/merchant-api/payments/webhook
function cryptomusSign(jsonBody: string, paymentApiKey: string): string {
	return crypto
		.createHash('md5')
		.update(Buffer.from(jsonBody).toString('base64') + paymentApiKey)
		.digest('hex');
}

// W5: Cryptomus signs the PHP `json_encode($data, JSON_UNESCAPED_UNICODE)` of
// the payload (sign field removed). PHP escapes forward slashes (`/` → `\/`)
// but leaves unicode unescaped; JS `JSON.stringify` does NEITHER the slash
// escaping. Cryptomus's own docs call this out and prescribe escaping slashes
// in non-PHP code, so we match: JSON.stringify (unescaped unicode) + escape
// `/`. Without this, any payload containing a slash (a URL, some addresses)
// would mismatch and a legitimate webhook would be rejected.
function phpJsonEncode(value: unknown): string {
	return JSON.stringify(value).replace(/\//g, '\\/');
}

export interface CryptomusVerifierConfig {
	merchantUuid: string;
	paymentApiKey: string;
}

export function createCryptomusVerifier(config: CryptomusVerifierConfig) {
	// Replay note: unlike the Monero verifier, we can't enforce a freshness
	// window here — Cryptomus's webhook payload carries no timestamp/nonce to
	// bind, and we don't control their sender. Replay is instead neutralized at
	// the store layer: the monotonic `PaymentStore` guard makes a re-delivered
	// status idempotent, and `markStatusAnnounced` gives exactly-once outbound
	// announcement. Consumers MUST use an idempotent store (every gateway resends
	// anyway). See packages/server/src/memory.ts.
	//
	// The signature check (MD5 hash) is synchronous, unlike Stripe's
	// `constructEventAsync`. We keep `async` anyway because the contract is
	// "this function always returns a Promise" — that lets thrown errors
	// surface as rejections (via `await expect(...).rejects.toThrow()`),
	// matches the Stripe verifier's signature, and lets every provider be
	// awaited uniformly in the verifier dispatch layer.
	// eslint-disable-next-line @typescript-eslint/require-await
	return async function verifyCryptomusWebhook(
		rawBody: unknown,
		_headers: unknown,
	): Promise<WebhookEvent> {
		// Accept EITHER the raw JSON string (the natural webhook body) or an
		// already-parsed object. One verifier registry can then feed both Stripe
		// (which needs the raw string for its signature) and Cryptomus from the
		// SAME value: pass the raw request body and each provider takes what it
		// needs. (The signature is still computed over the re-serialized fields;
		// matching Cryptomus's exact PHP json_encode output byte-for-byte is a
		// separate, sample-dependent task.)
		let raw: Record<string, unknown>;
		if (typeof rawBody === 'string') {
			try {
				raw = JSON.parse(rawBody) as Record<string, unknown>;
			} catch {
				throw new Error('coin-moebius/cryptomus: body is not valid JSON');
			}
		} else {
			raw = rawBody as Record<string, unknown>;
		}
		const receivedSign = raw.sign;
		if (!receivedSign || typeof receivedSign !== 'string') {
			throw new Error('coin-moebius/cryptomus: missing sign field');
		}

		const { sign: _sign, ...payloadForSign } = raw;
		void _sign;
		const expectedSign = cryptomusSign(phpJsonEncode(payloadForSign), config.paymentApiKey);

		if (!timingSafeStringEqual(expectedSign, receivedSign)) {
			throw new Error('coin-moebius/cryptomus: invalid signature');
		}

		const status = raw.status as string;
		const md = raw.metadata as Record<string, unknown> | undefined;

		return {
			kind: 'payment',
			status:
				status === 'paid' || status === 'paid_over' || status === 'confirmed'
					? 'success'
					: 'pending',
			paymentId: (raw.uuid ?? raw.order_id) as string,
			provider: 'cryptomus',
			amount: parseFloat(String(raw.amount)),
			currency: raw.currency as string,
			metadata: {
				address: raw.address,
				txHash: raw.txid ?? undefined,
				confirmations: raw.confirmations ?? 0,
				...(md ?? {}),
			},
			timestamp: Date.now(),
			raw,
		};
	};
}

export interface CryptomusCreatorConfig {
	merchantUuid: string;
	paymentApiKey: string;
	/** Public URL Cryptomus posts the webhook to (your `payment-webhook` function). */
	callbackUrl: string;
	/** URL the buyer is sent back to after the Cryptomus checkout. */
	returnUrl: string;
	/** Override for testing / self-hosted Cryptomus deployments. */
	apiUrl?: string;
}

export interface CryptomusCreateInput {
	productId: string;
	amount: number;
	/**
	 * Coin to invoice in. Use a Cryptomus-supported ticker (e.g., `'XMR'`,
	 * `'BTC'`, `'USDT'`). Required — there is no default, since
	 * "the right coin to invoice" depends entirely on the caller's intent.
	 */
	currency: string;
	metadata?: Record<string, unknown>;
}

export interface CryptomusCreateResult {
	uuid: string;
	address: string;
	qr?: string;
	amount?: string;
	raw: unknown;
}

/**
 * Server-only helper for the create-payment call. Wrap this in your serverless
 * function (e.g. `/api/create-cryptomus-payment`) and have the browser provider
 * post to that URL via `createCryptomusProvider({ createEndpoint })`.
 *
 * Never expose `paymentApiKey` to the browser.
 */
export function createCryptomusCreator(config: CryptomusCreatorConfig) {
	const apiUrl = config.apiUrl ?? 'https://api.cryptomus.com/v1/payment';

	return async function createCryptomusPayment(
		input: CryptomusCreateInput,
	): Promise<CryptomusCreateResult> {
		const body = {
			amount: input.amount.toString(),
			currency: input.currency,
			order_id: `${input.productId}-${Date.now()}`,
			url_callback: config.callbackUrl,
			url_return: config.returnUrl,
		};

		// W5: sign AND send the PHP-style encoding (escaped slashes). The create
		// body carries callback/return URLs, so a plain JSON.stringify would sign
		// bytes Cryptomus re-encodes differently and reject the request.
		const json = phpJsonEncode(body);
		const sign = cryptomusSign(json, config.paymentApiKey);

		const response = await fetch(apiUrl, {
			method: 'POST',
			headers: {
				merchant: config.merchantUuid,
				sign,
				'Content-Type': 'application/json',
			},
			body: json,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`coin-moebius/cryptomus: create failed ${response.status} ${text}`);
		}

		const data = (await response.json()) as {
			result?: { uuid?: string; address?: string; qr?: string; amount?: string };
		};

		const result = data.result;
		if (!result?.uuid || !result?.address) {
			throw new Error('coin-moebius/cryptomus: missing uuid/address in Cryptomus response');
		}

		return {
			uuid: result.uuid,
			address: result.address,
			qr: result.qr,
			amount: result.amount,
			raw: data,
		};
	};
}

function timingSafeStringEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) {
		mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return mismatch === 0;
}
