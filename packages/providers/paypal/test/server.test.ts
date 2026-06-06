import { describe, it, expect, vi } from 'vitest';
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';
import { createPrivateKey, createSign } from 'node:crypto';
import {
	createPaypalVerifier,
	createPaypalManualVerifier,
	crc32,
	getPaypalPortalUrl,
} from '../src/server.js';

/**
 * Tests for both PayPal verifier implementations.
 *
 *   - REST-endpoint verifier: stub the OAuth + verify endpoints via injected
 *     `fetcher`. Assert request shape and that a "SUCCESS" verification
 *     response yields the expected `PaymentResult`. Also check token caching
 *     behavior (one OAuth call across many webhooks).
 *
 *   - Manual verifier: a self-signed RSA-2048 cert and matching private key
 *     are embedded below. Signing happens via Node's `crypto` (Vitest runs
 *     in Node so this is fine for test); verification runs through our
 *     package's pure-Web-Crypto code path. The cert URL is set to a value
 *     matching the trusted PayPal prefix so the safe-by-default guard
 *     passes; a separate test confirms the guard rejects untrusted URLs.
 *
 * The keypair is a throwaway, generated once for this test file. Never used
 * anywhere else.
 */

// Trusted live cert host prefix — must match `TRUSTED_CERT_PREFIXES.live`
// in src/server.ts. A trailing path segment is fine; the verifier matches
// by prefix on the full URL.
const TRUSTED_CERT_URL = 'https://api.paypal.com/v1/notifications/certs/CERT-TEST';

const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIICxDCCAawCCQDAXTnxONqvPDANBgkqhkiG9w0BAQsFADAjMSEwHwYDVQQDDBhj
b2luLW1vZWJpdXMtcGF5cGFsLXRlc3QwIBcNMjYwNTE5MTgxNDMwWhgPMjEyNjA0
MjUxODE0MzBaMCMxITAfBgNVBAMMGGNvaW4tbW9lYml1cy1wYXlwYWwtdGVzdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALW4yYfn+b3NYr8S15P04Ga9
qCHc6q2H5IyGPehfCcnAzWj0f4afxjqTNGdFIVyDOIqgBzRLAokh354jSjo/V1at
fP+kJH1fahhjo60WwuBGiDk7k/0FcteKBLKK+P60xmDt8cxQUQ8OnNNH0XAG6H73
rw8EbwtaQAEPEhxAIojLZ1Kyp5mUHN+lE0J/J/YcGzPycsr0pK8owBc2nxwatths
4A09KzT1Ytq8gbY+9YKwIwBVwljh4SsU5qmdUUcEG9U1O/JkQnXo3UDNNd776MKM
9s+z3ZRBRQmmJuF4nzPmMGoW7ECtf36fufUUUqED7aDPLVBbRd0wUFFrBKvK7McC
AwEAATANBgkqhkiG9w0BAQsFAAOCAQEAr3OgQPD4tRVvkMFoaR/xmGsCHGJYEVh7
Hgzjd3uZ2/7s1HJB3wJdCZldidMDFIIR+YBcB1mTxsMULv7X22dGG0yocbX+3oQP
0hBRBveOzGTNtPxWRTZJusUXadniev7cz3TIORMeDMvQZr3E8LSEnTmtbaAg5oCW
VIQBUOyirMyjMYF6fn9/nWQ+nMwtyRq6yH8ycNH530qxHFBldlWDFNajOowMIPhg
//fSDhJE8Q5BKR3a7St++DQihURpwuGB7OYJXn5DPaoEs59Y0TUL2y6tzr4QmN01
vPq7Fv1hPVBCNxj5cBh+SzDz4yMo6MbjMQI8F+iP8x4ZCC6FkivZig==
-----END CERTIFICATE-----`;

const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC1uMmH5/m9zWK/
EteT9OBmvagh3Oqth+SMhj3oXwnJwM1o9H+Gn8Y6kzRnRSFcgziKoAc0SwKJId+e
I0o6P1dWrXz/pCR9X2oYY6OtFsLgRog5O5P9BXLXigSyivj+tMZg7fHMUFEPDpzT
R9FwBuh+968PBG8LWkABDxIcQCKIy2dSsqeZlBzfpRNCfyf2HBsz8nLK9KSvKMAX
Np8cGrbYbOANPSs09WLavIG2PvWCsCMAVcJY4eErFOapnVFHBBvVNTvyZEJ16N1A
zTXe++jCjPbPs92UQUUJpibheJ8z5jBqFuxArX9+n7n1FFKhA+2gzy1QW0XdMFBR
awSryuzHAgMBAAECggEBAJEWYWluEBq3cgDGZXKPD99Xy3aF8KTuG88Km0D9KE55
7ka+91agGF/KCgvtyO4ZIrqjfD0HKpYcgnK7EFejHPNqfqOJBU1IMegZHaRjyOHR
zo+LfuOERyXJ32hBxv1tjfnz4JtVAPL5osKZ06ETEuvUi2N9Eb/JpdJymu4NUsVN
8Gqq8wHgcwG1tHDrjfhJZ14CHvzUZ27t2Eg6L1E4jdyZ8IOI7LFD7FX/TiEMld2A
2RLW9PbAO1lj+x8CU4LNoe2x5KVf8DMDBbHEo9rkx39pxrDxPQpkp6H2LSZEt01t
YTgUeRzDaNEqNP31u8QdWannYwlsYbZ7NuzeT7a6wXkCgYEA4vh6iEGkUkHBcH8o
hDNLhPXWvmQGNW9kmxYGgLSt/BaDq5B0Acu/UotiXI5proMwTczSzL4lsFGZ4JLj
s8gzCTpRvZZsqQYoU0r+orU79ocmhG7K3GRhWDET/G1wvet1zipuIaBoKB9mmMGk
beRxnjvi6uh3M+jbz+nFEt4ZI+MCgYEAzPbDQcSaC826vllJ5TBsrIkkX80dPCPy
MlTaMGvMm3+fm0qMJrRaINZUASKiP731+Vu6TeaaJfhwTUPP6GTdvZxmu7M418lq
dPKrUQOOS5Pxezc9uSWSlZ1WoiQjDhe4lsl2hSgD/UYXHINaPZrNjLIs2beRbiY6
ogkW+RzZEM0CgYAjHEEINu9OcjGUT3dbC/xQsx7nEN4NAhBUFVIoMsr/RhRUQ+JO
LNCJ2ln662TZxB2Cy36IgZme7uCY5uAmfX+3m7ftVgm1E+jFCcLeNJ70AfApaGIl
Obn9RIpM8DkSiAwPOm0S8pdqLYFXfA0NmtsgmS7/G7rk4s6uGQGNa6ID9QKBgQCu
9yNdXEAIPXnhjgUnsbvDWVsEsOr48NKKpqaPWSaTw1FzViLn02NwzqVtRqxsb3Ov
ht82KtmB+l+bhXzQrHIhr4Z/SpIGmvjWlmUqRjfNSqCEh3aYO3uzXlmbFfAa0qMP
jTEwoCUvqwqFm5eIKUK4jUz+Gdb6yYWZ1tqWk0q1LQKBgDfbt4H+RU38Al2t2dnC
H/xTiv6p1ebcYjRmhvH/XxIOHeUR+FuiCfkLQ7WvQPR6dxUGf9PN5QyGja5COEsk
zgfUBMCfroi19Dd4GbePzRmy7/jvPbmcmLjTbvE7eVLr8d5jYxu6ePO98slL9phv
yEPXSrg2v7exRINHRCdUzv80
-----END PRIVATE KEY-----`;

const WEBHOOK_ID = 'WEBHOOK_TEST_ID';

function captureCompletedBody(amount = '9.99'): string {
	return JSON.stringify({
		event_type: 'PAYMENT.CAPTURE.COMPLETED',
		resource_type: 'capture',
		resource: {
			id: 'CAPTURE_ABC',
			amount: { value: amount, currency_code: 'USD' },
			supplementary_data: { related_ids: { order_id: 'ORDER_XYZ' } },
		},
	});
}

function signPaypalManualPayload(input: {
	transmissionId: string;
	transmissionTime: string;
	body: string;
}): string {
	const bytes = new TextEncoder().encode(input.body);
	const crc = crc32(bytes).toString(10);
	const signedString = `${input.transmissionId}|${input.transmissionTime}|${WEBHOOK_ID}|${crc}`;
	const key = createPrivateKey(TEST_PRIVATE_KEY_PEM);
	const sign = createSign('RSA-SHA256');
	sign.update(signedString);
	sign.end();
	return sign.sign(key).toString('base64');
}

describe('crc32 helper', () => {
	it('matches well-known CRC32 of "123456789" = 0xCBF43926 (3421780262)', () => {
		expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
	});

	it('produces 0 for an empty input', () => {
		expect(crc32(new Uint8Array(0))).toBe(0);
	});
});

describe('createPaypalVerifier (REST endpoint)', () => {
	function setupFetchStub(opts: { verificationStatus: 'SUCCESS' | 'FAILURE' }): {
		fetcher: typeof fetch;
		calls: Array<{ url: string; init?: RequestInit }>;
	} {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetcher: typeof fetch = async (url, init) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			calls.push({ url: urlStr, init });
			if (urlStr.endsWith('/v1/oauth2/token')) {
				return new Response(JSON.stringify({ access_token: 'access_tok_xyz', expires_in: 3600 }), {
					status: 200,
				});
			}
			if (urlStr.endsWith('/v1/notifications/verify-webhook-signature')) {
				return new Response(JSON.stringify({ verification_status: opts.verificationStatus }), {
					status: 200,
				});
			}
			throw new Error(`unexpected fetch to ${urlStr}`);
		};
		return { fetcher, calls };
	}

	function paypalHeaders(): Record<string, string> {
		return {
			'paypal-transmission-id': 'TRANS_ID_1',
			'paypal-transmission-time': '2026-05-19T18:00:00Z',
			'paypal-cert-url': TRUSTED_CERT_URL,
			'paypal-transmission-sig': 'sig_value',
			'paypal-auth-algo': 'SHA256withRSA',
		};
	}

	it('maps PAYMENT.CAPTURE.COMPLETED to success and surfaces amount + order id', async () => {
		const { fetcher, calls } = setupFetchStub({ verificationStatus: 'SUCCESS' });
		const verifier = createPaypalVerifier({
			clientId: 'client_id',
			clientSecret: 'client_secret',
			webhookId: WEBHOOK_ID,
			fetcher,
		});

		const result = asPayment(await verifier.verify(captureCompletedBody(), paypalHeaders()));
		expect(result?.status).toBe('success');
		expect(result?.provider).toBe('paypal');
		expect(result?.paymentId).toBe('ORDER_XYZ');
		expect(result?.amount).toBe(9.99);
		expect(result?.currency).toBe('USD');

		// Calls in order: OAuth, verify
		expect(calls[0].url).toContain('/v1/oauth2/token');
		expect(calls[1].url).toContain('/v1/notifications/verify-webhook-signature');
		// OAuth uses Basic auth from clientId:clientSecret
		const oauthAuth = (calls[0].init?.headers as Record<string, string>)?.Authorization;
		expect(oauthAuth).toMatch(/^Basic /);
		// Verify uses Bearer with the access token we returned
		const verifyAuth = (calls[1].init?.headers as Record<string, string>)?.Authorization;
		expect(verifyAuth).toBe('Bearer access_tok_xyz');
	});

	it('forwards the transmission fields + webhook_id + parsed event body to the verify endpoint', async () => {
		const { fetcher, calls } = setupFetchStub({ verificationStatus: 'SUCCESS' });
		const verifier = createPaypalVerifier({
			clientId: 'client_id',
			clientSecret: 'client_secret',
			webhookId: WEBHOOK_ID,
			fetcher,
		});
		await verifier.verify(captureCompletedBody(), paypalHeaders());

		const verifyCall = calls.find((c) => c.url.endsWith('/verify-webhook-signature'));
		const bodyStr = typeof verifyCall?.init?.body === 'string' ? verifyCall.init.body : '{}';
		const body = JSON.parse(bodyStr) as Record<string, unknown>;
		expect(body.auth_algo).toBe('SHA256withRSA');
		expect(body.cert_url).toBe(TRUSTED_CERT_URL);
		expect(body.transmission_id).toBe('TRANS_ID_1');
		expect(body.transmission_time).toBe('2026-05-19T18:00:00Z');
		expect(body.transmission_sig).toBe('sig_value');
		expect(body.webhook_id).toBe(WEBHOOK_ID);
		expect((body.webhook_event as { event_type?: string }).event_type).toBe(
			'PAYMENT.CAPTURE.COMPLETED',
		);
	});

	it('rejects when PayPal reports verification_status !== SUCCESS', async () => {
		const { fetcher } = setupFetchStub({ verificationStatus: 'FAILURE' });
		const verifier = createPaypalVerifier({
			clientId: 'client_id',
			clientSecret: 'client_secret',
			webhookId: WEBHOOK_ID,
			fetcher,
		});
		await expect(verifier.verify(captureCompletedBody(), paypalHeaders())).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('caches the OAuth token across multiple webhooks for the same clientId', async () => {
		const { fetcher, calls } = setupFetchStub({ verificationStatus: 'SUCCESS' });
		const verifier = createPaypalVerifier({
			clientId: 'client_id',
			clientSecret: 'client_secret',
			webhookId: WEBHOOK_ID,
			fetcher,
		});
		await verifier.verify(captureCompletedBody(), paypalHeaders());
		await verifier.verify(captureCompletedBody(), paypalHeaders());
		await verifier.verify(captureCompletedBody(), paypalHeaders());
		const oauthCalls = calls.filter((c) => c.url.includes('/v1/oauth2/token'));
		expect(oauthCalls.length).toBe(1);
	});

	it('rejects when a required paypal-* header is missing', async () => {
		const { fetcher } = setupFetchStub({ verificationStatus: 'SUCCESS' });
		const verifier = createPaypalVerifier({
			clientId: 'client_id',
			clientSecret: 'client_secret',
			webhookId: WEBHOOK_ID,
			fetcher,
		});
		const headers = paypalHeaders();
		delete headers['paypal-transmission-sig'];
		await expect(verifier.verify(captureCompletedBody(), headers)).rejects.toThrow(
			/missing one or more required paypal-/,
		);
	});

	it('rejects when clientId is missing', async () => {
		const { fetcher } = setupFetchStub({ verificationStatus: 'SUCCESS' });
		const verifier = createPaypalVerifier({
			clientId: '',
			clientSecret: 'client_secret',
			webhookId: WEBHOOK_ID,
			fetcher,
		});
		await expect(verifier.verify(captureCompletedBody(), paypalHeaders())).rejects.toThrow(
			/clientId missing/,
		);
	});

	it('uses the sandbox base URL when mode is sandbox', async () => {
		const { fetcher, calls } = setupFetchStub({ verificationStatus: 'SUCCESS' });
		const verifier = createPaypalVerifier({
			clientId: 'client_id',
			clientSecret: 'client_secret',
			webhookId: WEBHOOK_ID,
			mode: 'sandbox',
			fetcher,
		});
		await verifier.verify(captureCompletedBody(), paypalHeaders());
		expect(calls[0].url).toContain('api-m.sandbox.paypal.com');
	});
});

describe('createPaypalManualVerifier (local RSA)', () => {
	const TRANSMISSION_ID = 'TRANS_ID_MANUAL';
	const TRANSMISSION_TIME = '2026-05-19T18:00:00Z';

	function certFetcher(): typeof fetch {
		return async (url) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr === TRUSTED_CERT_URL) {
				return new Response(TEST_CERT_PEM, { status: 200 });
			}
			return new Response('not found', { status: 404 });
		};
	}

	function signedHeaders(body: string): Record<string, string> {
		const sig = signPaypalManualPayload({
			transmissionId: TRANSMISSION_ID,
			transmissionTime: TRANSMISSION_TIME,
			body,
		});
		return {
			'paypal-transmission-id': TRANSMISSION_ID,
			'paypal-transmission-time': TRANSMISSION_TIME,
			'paypal-cert-url': TRUSTED_CERT_URL,
			'paypal-transmission-sig': sig,
			'paypal-auth-algo': 'SHA256withRSA',
		};
	}

	it('verifies a correctly signed PAYMENT.CAPTURE.COMPLETED body', async () => {
		const body = captureCompletedBody();
		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			fetcher: certFetcher(),
		});
		const result = asPayment(await verifier.verify(body, signedHeaders(body)));
		expect(result?.status).toBe('success');
		expect(result?.paymentId).toBe('ORDER_XYZ');
		expect(result?.amount).toBe(9.99);
	});

	it('rejects a tampered body', async () => {
		const body = captureCompletedBody();
		const headers = signedHeaders(body);
		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			fetcher: certFetcher(),
		});
		const tampered = body.replace('9.99', '0.01');
		await expect(verifier.verify(tampered, headers)).rejects.toThrow(/invalid signature/);
	});

	it('rejects a paypal-cert-url not on the trusted PayPal host', async () => {
		const body = captureCompletedBody();
		const headers = signedHeaders(body);
		headers['paypal-cert-url'] = 'https://evil.example.com/notifications/certs/CERT';
		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			fetcher: certFetcher(),
		});
		await expect(verifier.verify(body, headers)).rejects.toThrow(/refusing untrusted/);
	});

	it('uses the sandbox cert prefix when mode is sandbox', async () => {
		const body = captureCompletedBody();
		const sandboxCertUrl = 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST';
		// Live URL must be rejected when mode is sandbox
		const headers = signedHeaders(body);
		headers['paypal-cert-url'] = sandboxCertUrl;

		const sandboxFetcher: typeof fetch = async (url) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr === sandboxCertUrl) return new Response(TEST_CERT_PEM, { status: 200 });
			return new Response('not found', { status: 404 });
		};

		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			mode: 'sandbox',
			fetcher: sandboxFetcher,
		});
		const result = asPayment(await verifier.verify(body, headers));
		expect(result?.status).toBe('success');

		// The same sandbox-prefixed URL must be REJECTED in live mode.
		const liveVerifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			mode: 'live',
			fetcher: sandboxFetcher,
		});
		await expect(liveVerifier.verify(body, headers)).rejects.toThrow(/refusing untrusted/);
	});

	it('caches the cert across multiple webhooks (one fetch only)', async () => {
		const body = captureCompletedBody();
		const fetcherSpy = vi.fn(async (url: RequestInfo | URL) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr === TRUSTED_CERT_URL) return new Response(TEST_CERT_PEM, { status: 200 });
			return new Response('not found', { status: 404 });
		});
		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			fetcher: fetcherSpy,
		});
		await verifier.verify(body, signedHeaders(body));
		await verifier.verify(body, signedHeaders(body));
		await verifier.verify(body, signedHeaders(body));
		expect(fetcherSpy).toHaveBeenCalledTimes(1);
	});

	it('rejects when a required paypal-* header is missing', async () => {
		const body = captureCompletedBody();
		const headers = signedHeaders(body);
		delete headers['paypal-transmission-id'];
		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			fetcher: certFetcher(),
		});
		await expect(verifier.verify(body, headers)).rejects.toThrow(
			/missing one or more required paypal-/,
		);
	});
});

describe('event → PaymentResult mapping (REST verifier, by event_type)', () => {
	function makeStubbedVerifier() {
		const fetcher: typeof fetch = async (url) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr.endsWith('/v1/oauth2/token')) {
				return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
					status: 200,
				});
			}
			return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), {
				status: 200,
			});
		};
		return createPaypalVerifier({
			clientId: 'c',
			clientSecret: 's',
			webhookId: WEBHOOK_ID,
			fetcher,
		});
	}

	function paypalHeaders(): Record<string, string> {
		return {
			'paypal-transmission-id': 'TRANS_ID_2',
			'paypal-transmission-time': '2026-05-19T18:00:00Z',
			'paypal-cert-url': TRUSTED_CERT_URL,
			'paypal-transmission-sig': 'sig_value',
			'paypal-auth-algo': 'SHA256withRSA',
		};
	}

	async function verify(eventBody: Record<string, unknown>) {
		const verifier = makeStubbedVerifier();
		return asPayment(await verifier.verify(JSON.stringify(eventBody), paypalHeaders()));
	}

	it('maps CHECKOUT.ORDER.APPROVED to pending', async () => {
		const result = await verify({
			event_type: 'CHECKOUT.ORDER.APPROVED',
			resource: {
				id: 'ORDER_XYZ',
				purchase_units: [{ amount: { value: '12.34', currency_code: 'USD' } }],
			},
		});
		expect(result?.status).toBe('pending');
		expect(result?.amount).toBe(12.34);
		expect(result?.paymentId).toBe('ORDER_XYZ');
	});

	it('maps PAYMENT.CAPTURE.DENIED to failed', async () => {
		const result = await verify({
			event_type: 'PAYMENT.CAPTURE.DENIED',
			resource: {
				id: 'CAP_X',
				amount: { value: '5.00', currency_code: 'USD' },
				supplementary_data: { related_ids: { order_id: 'ORDER_DENIED' } },
			},
		});
		expect(result?.status).toBe('failed');
	});

	it('maps PAYMENT.CAPTURE.DECLINED to failed', async () => {
		const result = await verify({
			event_type: 'PAYMENT.CAPTURE.DECLINED',
			resource: { id: 'CAP_X', amount: { value: '5', currency_code: 'USD' } },
		});
		expect(result?.status).toBe('failed');
	});

	it('maps PAYMENT.CAPTURE.REFUNDED to refunded', async () => {
		const result = await verify({
			event_type: 'PAYMENT.CAPTURE.REFUNDED',
			resource: { id: 'REFUND_X', amount: { value: '2.50', currency_code: 'USD' } },
		});
		expect(result?.status).toBe('refunded');
		expect(result?.amount).toBe(2.5);
	});

	it('maps PAYMENT.CAPTURE.REVERSED to refunded', async () => {
		const result = await verify({
			event_type: 'PAYMENT.CAPTURE.REVERSED',
			resource: { id: 'REV_X', amount: { value: '1.00', currency_code: 'USD' } },
		});
		expect(result?.status).toBe('refunded');
	});

	it('maps CUSTOMER.DISPUTE.CREATED to disputed (using dispute_amount)', async () => {
		const result = await verify({
			event_type: 'CUSTOMER.DISPUTE.CREATED',
			resource: {
				id: 'DISPUTE_X',
				dispute_amount: { value: '7.77', currency_code: 'USD' },
			},
		});
		expect(result?.status).toBe('disputed');
		expect(result?.amount).toBe(7.77);
	});

	it('returns null for CUSTOMER.DISPUTE.RESOLVED (log only)', async () => {
		const result = await verify({
			event_type: 'CUSTOMER.DISPUTE.RESOLVED',
			resource: { id: 'DISPUTE_X' },
		});
		expect(result).toBeNull();
	});

	it('returns null for unrecognized event types (signature still validated)', async () => {
		const result = await verify({
			event_type: 'BILLING.SUBSCRIPTION.CREATED',
			resource: { id: 'SUB_X' },
		});
		expect(result).toBeNull();
	});

	it('returns the resource id as paymentId when no underlying order_id is present', async () => {
		const result = await verify({
			event_type: 'PAYMENT.CAPTURE.COMPLETED',
			resource: { id: 'CAPTURE_NO_ORDER', amount: { value: '1.00', currency_code: 'USD' } },
		});
		expect(result?.paymentId).toBe('CAPTURE_NO_ORDER');
	});

	it('returns empty paymentId when neither order_id nor resource id is present', async () => {
		const result = await verify({
			event_type: 'PAYMENT.CAPTURE.COMPLETED',
			resource: { amount: { value: '1.00', currency_code: 'USD' } },
		});
		expect(result?.paymentId).toBe('');
	});
});

describe('REST verifier — body + config edge cases', () => {
	function setupFetch(verificationStatus: 'SUCCESS' | 'FAILURE') {
		return (async (url: RequestInfo | URL) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr.endsWith('/v1/oauth2/token')) {
				return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
					status: 200,
				});
			}
			return new Response(JSON.stringify({ verification_status: verificationStatus }), {
				status: 200,
			});
		}) as typeof fetch;
	}

	function headers(): Record<string, string> {
		return {
			'paypal-transmission-id': 'T_ID',
			'paypal-transmission-time': '2026-05-19T18:00:00Z',
			'paypal-cert-url': TRUSTED_CERT_URL,
			'paypal-transmission-sig': 'sig',
			'paypal-auth-algo': 'SHA256withRSA',
		};
	}

	it('rejects when clientSecret is missing', async () => {
		const v = createPaypalVerifier({
			clientId: 'c',
			clientSecret: '',
			webhookId: WEBHOOK_ID,
			fetcher: setupFetch('SUCCESS'),
		});
		await expect(
			v.verify(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }), headers()),
		).rejects.toThrow(/clientSecret missing/);
	});

	it('rejects when webhookId is missing', async () => {
		const v = createPaypalVerifier({
			clientId: 'c',
			clientSecret: 's',
			webhookId: '',
			fetcher: setupFetch('SUCCESS'),
		});
		await expect(
			v.verify(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }), headers()),
		).rejects.toThrow(/webhookId missing/);
	});

	it('throws when the OAuth endpoint returns non-2xx', async () => {
		const badAuthFetcher: typeof fetch = async (url) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr.endsWith('/v1/oauth2/token')) {
				return new Response('unauthorized', { status: 401 });
			}
			return new Response('{}', { status: 200 });
		};
		const v = createPaypalVerifier({
			clientId: 'c',
			clientSecret: 's',
			webhookId: WEBHOOK_ID,
			fetcher: badAuthFetcher,
		});
		await expect(
			v.verify(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }), headers()),
		).rejects.toThrow(/oauth token request failed/);
	});

	it('throws when the verify endpoint returns non-2xx', async () => {
		const badVerifyFetcher: typeof fetch = async (url) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr.endsWith('/v1/oauth2/token')) {
				return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
					status: 200,
				});
			}
			return new Response('server error', { status: 500 });
		};
		const v = createPaypalVerifier({
			clientId: 'c',
			clientSecret: 's',
			webhookId: WEBHOOK_ID,
			fetcher: badVerifyFetcher,
		});
		await expect(
			v.verify(JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED' }), headers()),
		).rejects.toThrow(/verify-webhook-signature failed/);
	});

	it('accepts a Uint8Array body and an object body equivalently', async () => {
		const v = createPaypalVerifier({
			clientId: 'c',
			clientSecret: 's',
			webhookId: WEBHOOK_ID,
			fetcher: setupFetch('SUCCESS'),
		});
		const body = { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'R' } };
		const fromString = asPayment(await v.verify(JSON.stringify(body), headers()));
		const fromBytes = asPayment(
			await v.verify(new TextEncoder().encode(JSON.stringify(body)), headers()),
		);
		const fromObject = asPayment(await v.verify(body, headers()));
		expect(fromString?.paymentId).toBe(fromBytes?.paymentId);
		expect(fromObject?.paymentId).toBe(fromBytes?.paymentId);
	});

	it('rejects an unsupported body type (e.g., a number)', async () => {
		const v = createPaypalVerifier({
			clientId: 'c',
			clientSecret: 's',
			webhookId: WEBHOOK_ID,
			fetcher: setupFetch('SUCCESS'),
		});
		await expect(v.verify(42, headers())).rejects.toThrow(/unsupported body type/);
	});
});

describe('Manual verifier — PEM + cache edge cases', () => {
	it('rejects a PEM that does not contain a CERTIFICATE block', async () => {
		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			fetcher: async () => new Response('not-a-pem-at-all', { status: 200 }),
		});
		const body = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED' });
		const headers = {
			'paypal-transmission-id': 'T',
			'paypal-transmission-time': '2026-05-19T00:00:00Z',
			'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-BAD',
			'paypal-transmission-sig': 'AAAA',
			'paypal-auth-algo': 'SHA256withRSA',
		};
		await expect(verifier.verify(body, headers)).rejects.toThrow(/PEM missing CERTIFICATE block/);
	});

	it('throws when the cert fetch returns non-2xx', async () => {
		const verifier = createPaypalManualVerifier({
			webhookId: WEBHOOK_ID,
			fetcher: async () => new Response('not found', { status: 404 }),
		});
		const body = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED' });
		const headers = {
			'paypal-transmission-id': 'T',
			'paypal-transmission-time': '2026-05-19T00:00:00Z',
			'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-MISSING',
			'paypal-transmission-sig': 'AAAA',
			'paypal-auth-algo': 'SHA256withRSA',
		};
		await expect(verifier.verify(body, headers)).rejects.toThrow(/cert fetch failed/);
	});
});

describe('event → SubscriptionEvent mapping (PayPal billing events)', () => {
	// Reuse the REST verifier with a stubbed fetcher so the signature step
	// short-circuits to SUCCESS regardless of the event body. Subscription
	// mapping is purely a function of `event_type` + `resource`, so we
	// exercise it via signed-but-stubbed deliveries.
	function makeStubbedVerifier() {
		const fetcher: typeof fetch = async (url) => {
			const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
			if (urlStr.endsWith('/v1/oauth2/token')) {
				return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
					status: 200,
				});
			}
			return new Response(JSON.stringify({ verification_status: 'SUCCESS' }), { status: 200 });
		};
		return createPaypalVerifier({ clientId: 'c', clientSecret: 's', webhookId: 'wh-id', fetcher });
	}

	function paypalHeaders() {
		return {
			'paypal-transmission-id': 'T_SUB',
			'paypal-transmission-time': '2026-05-22T10:00:00Z',
			'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT-SUB',
			'paypal-transmission-sig': 'sig_sub',
			'paypal-auth-algo': 'SHA256withRSA',
		};
	}

	async function verifySub(eventBody: Record<string, unknown>) {
		const verifier = makeStubbedVerifier();
		return asSubscription(await verifier.verify(JSON.stringify(eventBody), paypalHeaders()));
	}

	it('maps BILLING.SUBSCRIPTION.ACTIVATED to subscription.created with active status', async () => {
		const result = await verifySub({
			event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
			resource: {
				id: 'I-SUB-001',
				status: 'ACTIVE',
				plan_id: 'P-PRO-MONTHLY',
				subscriber: { payer_id: 'PAYER42' },
				custom_id: 'user_bob_42',
				billing_info: {
					next_billing_time: '2026-06-22T10:00:00Z',
					last_payment: { amount: { value: '29.99', currency_code: 'USD' } },
				},
			},
		});
		expect(result).not.toBeNull();
		expect(result!.type).toBe('subscription.created');
		expect(result!.subscriptionId).toBe('I-SUB-001');
		expect(result!.provider).toBe('paypal');
		expect(result!.productId).toBe('P-PRO-MONTHLY');
		expect(result!.customerRef).toBe('PAYER42');
		expect(result!.status).toBe('active');
		expect(result!.amount).toBeCloseTo(29.99, 2);
		expect(result!.currency).toBe('USD');
		expect((result!.metadata as { customerRef: string }).customerRef).toBe('user_bob_42');
	});

	it('maps PAYMENT.SALE.COMPLETED with billing_agreement_id to subscription.renewed', async () => {
		const result = await verifySub({
			event_type: 'PAYMENT.SALE.COMPLETED',
			resource: {
				id: 'SALE-XYZ',
				billing_agreement_id: 'I-SUB-001',
				amount: { total: '29.99', value: '29.99', currency_code: 'USD' },
			},
		});
		expect(result!.type).toBe('subscription.renewed');
		expect(result!.subscriptionId).toBe('I-SUB-001');
	});

	it('does NOT treat PAYMENT.SALE.COMPLETED without billing_agreement_id as a subscription event', async () => {
		// One-time sales fall through to the payment path; this guards against
		// a regression where every PAYMENT.SALE.COMPLETED would be tagged as a
		// subscription renewal.
		const verifier = makeStubbedVerifier();
		const event = await verifier.verify(
			JSON.stringify({
				event_type: 'PAYMENT.SALE.COMPLETED',
				resource: { id: 'SALE-ONE-TIME' },
			}),
			paypalHeaders(),
		);
		// `null` is the expected return because the legacy one-time SALE path
		// isn't in our `mapEventType` switch.
		expect(event).toBeNull();
	});

	it('maps BILLING.SUBSCRIPTION.PAYMENT.FAILED to subscription.payment_failed with past_due status', async () => {
		const result = await verifySub({
			event_type: 'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
			resource: {
				id: 'I-SUB-FAIL',
				status: 'ACTIVE',
			},
		});
		expect(result!.type).toBe('subscription.payment_failed');
		expect(result!.status).toBe('past_due');
	});

	it('maps BILLING.SUBSCRIPTION.UPDATED to subscription.updated', async () => {
		const result = await verifySub({
			event_type: 'BILLING.SUBSCRIPTION.UPDATED',
			resource: {
				id: 'I-SUB-UPD',
				status: 'ACTIVE',
			},
		});
		expect(result!.type).toBe('subscription.updated');
		expect(result!.status).toBe('active');
	});

	it('maps BILLING.SUBSCRIPTION.SUSPENDED to subscription.updated with paused status', async () => {
		const result = await verifySub({
			event_type: 'BILLING.SUBSCRIPTION.SUSPENDED',
			resource: {
				id: 'I-SUB-SUS',
				status: 'SUSPENDED',
			},
		});
		expect(result!.type).toBe('subscription.updated');
		expect(result!.status).toBe('paused');
	});

	it('maps BILLING.SUBSCRIPTION.CANCELLED to subscription.canceled', async () => {
		const result = await verifySub({
			event_type: 'BILLING.SUBSCRIPTION.CANCELLED',
			resource: {
				id: 'I-SUB-CAN',
				status: 'CANCELLED',
			},
		});
		expect(result!.type).toBe('subscription.canceled');
		expect(result!.status).toBe('canceled');
	});
});

describe('getPaypalPortalUrl', () => {
	it('returns the live PayPal autopay page by default', () => {
		expect(getPaypalPortalUrl()).toBe('https://www.paypal.com/myaccount/autopay/');
	});

	it('returns the sandbox autopay page when mode is sandbox', () => {
		expect(getPaypalPortalUrl({ mode: 'sandbox' })).toBe(
			'https://www.sandbox.paypal.com/myaccount/autopay/',
		);
	});
});
