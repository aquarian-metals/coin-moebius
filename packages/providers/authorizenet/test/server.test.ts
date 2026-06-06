import { describe, it, expect } from 'vitest';
import { asPayment, asSubscription } from '@aquarian-metals/coin-moebius-core';
import {
	createAuthorizenetVerifier,
	computeAuthorizenetSignature,
	getAuthorizenetPortalUrl,
} from '../src/server.js';

const SIGNATURE_KEY = 'A1B2C3D4E5F6_unit_test_key';

interface SampleBuildOptions {
	eventType?: string;
	amount?: string;
}

function sampleBody(opts: SampleBuildOptions = {}): string {
	return JSON.stringify({
		notificationId: 'notif_001',
		eventType: opts.eventType ?? 'net.authorize.payment.authcapture.created',
		eventDate: '2026-05-19T18:30:00Z',
		webhookId: 'whk_test',
		payload: {
			id: 'TRANS_ID_001',
			authAmount: opts.amount ?? '9.99',
			settleAmount: opts.amount ?? '9.99',
			avsResponse: 'Y',
			responseCode: 1,
		},
	});
}

async function signedHeaders(body: string, key = SIGNATURE_KEY): Promise<Record<string, string>> {
	const hex = await computeAuthorizenetSignature(new TextEncoder().encode(body), key);
	return { 'x-anet-signature': `sha512=${hex}` };
}

describe('computeAuthorizenetSignature', () => {
	it('produces a 128-char hex SHA-512 digest', async () => {
		const hex = await computeAuthorizenetSignature(
			new TextEncoder().encode(sampleBody()),
			SIGNATURE_KEY,
		);
		expect(hex).toMatch(/^[0-9a-f]{128}$/);
	});

	it('is deterministic for the same inputs', async () => {
		const a = await computeAuthorizenetSignature(
			new TextEncoder().encode(sampleBody()),
			SIGNATURE_KEY,
		);
		const b = await computeAuthorizenetSignature(
			new TextEncoder().encode(sampleBody()),
			SIGNATURE_KEY,
		);
		expect(a).toBe(b);
	});

	it('changes when the body changes by even one byte', async () => {
		const a = await computeAuthorizenetSignature(
			new TextEncoder().encode(sampleBody()),
			SIGNATURE_KEY,
		);
		const b = await computeAuthorizenetSignature(
			new TextEncoder().encode(sampleBody() + ' '),
			SIGNATURE_KEY,
		);
		expect(a).not.toBe(b);
	});
});

describe('createAuthorizenetVerifier', () => {
	function makeVerifier() {
		return createAuthorizenetVerifier({ signatureKey: SIGNATURE_KEY });
	}

	it('maps authcapture to success and surfaces the amount + id', async () => {
		const verifier = makeVerifier();
		const body = sampleBody({ eventType: 'net.authorize.payment.authcapture.created' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('success');
		expect(result?.provider).toBe('authorizenet');
		expect(result?.paymentId).toBe('TRANS_ID_001');
		expect(result?.amount).toBe(9.99);
		expect(result?.currency).toBe('USD');
	});

	it('maps capture and priorAuthCapture to success', async () => {
		const verifier = makeVerifier();
		for (const eventType of [
			'net.authorize.payment.capture.created',
			'net.authorize.payment.priorAuthCapture.created',
		]) {
			const body = sampleBody({ eventType });
			const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
			expect(result?.status).toBe('success');
		}
	});

	it('maps authorization.created and fraud.held to pending', async () => {
		const verifier = makeVerifier();
		for (const eventType of [
			'net.authorize.payment.authorization.created',
			'net.authorize.payment.fraud.held',
		]) {
			const body = sampleBody({ eventType });
			const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
			expect(result?.status).toBe('pending');
		}
	});

	it('maps refund.created to refunded', async () => {
		const verifier = makeVerifier();
		const body = sampleBody({ eventType: 'net.authorize.payment.refund.created' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('refunded');
	});

	it('maps void.created and fraud.declined to failed', async () => {
		const verifier = makeVerifier();
		for (const eventType of [
			'net.authorize.payment.void.created',
			'net.authorize.payment.fraud.declined',
		]) {
			const body = sampleBody({ eventType });
			const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
			expect(result?.status).toBe('failed');
		}
	});

	it('maps fraud.approved to success', async () => {
		const verifier = makeVerifier();
		const body = sampleBody({ eventType: 'net.authorize.payment.fraud.approved' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('success');
	});

	it('returns null for unrecognized event types (signature still validated)', async () => {
		const verifier = makeVerifier();
		const body = sampleBody({ eventType: 'net.authorize.account.updated' });
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result).toBeNull();
	});

	it('accepts the bare-hex form without the sha512= prefix', async () => {
		const verifier = makeVerifier();
		const body = sampleBody();
		const hex = await computeAuthorizenetSignature(new TextEncoder().encode(body), SIGNATURE_KEY);
		const result = asPayment(await verifier.verify(body, { 'x-anet-signature': hex }));
		expect(result?.status).toBe('success');
	});

	it('accepts uppercased hex in the header (case-insensitive compare)', async () => {
		const verifier = makeVerifier();
		const body = sampleBody();
		const hex = await computeAuthorizenetSignature(new TextEncoder().encode(body), SIGNATURE_KEY);
		const result = await verifier.verify(body, {
			'X-ANET-Signature': `sha512=${hex.toUpperCase()}`,
		});
		expect(result?.status).toBe('success');
	});

	it('rejects a payload signed with the wrong key', async () => {
		const verifier = makeVerifier();
		const body = sampleBody();
		await expect(verifier.verify(body, await signedHeaders(body, 'wrong_key'))).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('rejects a tampered body with a stale signature', async () => {
		const verifier = makeVerifier();
		const body = sampleBody();
		const headers = await signedHeaders(body);
		const tampered = body.replace('9.99', '0.01');
		await expect(verifier.verify(tampered, headers)).rejects.toThrow(/invalid signature/);
	});

	it('rejects when the x-anet-signature header is missing', async () => {
		const verifier = makeVerifier();
		await expect(verifier.verify(sampleBody(), {})).rejects.toThrow(/missing/);
	});

	it('rejects when signatureKey is empty on the config', async () => {
		const verifier = createAuthorizenetVerifier({ signatureKey: '' });
		await expect(verifier.verify(sampleBody(), await signedHeaders(sampleBody()))).rejects.toThrow(
			/signatureKey missing/,
		);
	});

	it('accepts both a string body and a Uint8Array equivalently', async () => {
		const verifier = makeVerifier();
		const body = sampleBody();
		const headers = await signedHeaders(body);
		const fromString = asPayment(await verifier.verify(body, headers));
		const fromBytes = asPayment(await verifier.verify(new TextEncoder().encode(body), headers));
		expect(fromString?.paymentId).toBe(fromBytes?.paymentId);
	});

	it('prefers settleAmount over authAmount when both are present', async () => {
		const verifier = makeVerifier();
		const body = JSON.stringify({
			notificationId: 'n2',
			eventType: 'net.authorize.payment.refund.created',
			payload: { id: 'T2', authAmount: '20.00', settleAmount: '5.50' },
		});
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.amount).toBe(5.5);
	});

	it('rejects a signature whose length does not match the expected digest', async () => {
		const body = sampleBody();
		const verifier = makeVerifier();
		await expect(verifier.verify(body, { 'x-anet-signature': 'sha512=abcd' })).rejects.toThrow(
			/invalid signature/,
		);
	});

	it('accepts a pre-parsed object body equivalently to a string', async () => {
		const bodyString = sampleBody();
		const headers = await signedHeaders(bodyString);
		const verifier = makeVerifier();
		const result = asPayment(await verifier.verify(JSON.parse(bodyString), headers));
		expect(result?.status).toBe('success');
		expect(result?.paymentId).toBe('TRANS_ID_001');
	});

	it('returns null for a signed delivery that carries no eventType', async () => {
		const body = JSON.stringify({ notificationId: 'n', payload: { id: 'X' } });
		const verifier = makeVerifier();
		expect(await verifier.verify(body, await signedHeaders(body))).toBeNull();
	});

	it('handles a payment event with no payload (empty id, zero amount)', async () => {
		const body = JSON.stringify({
			notificationId: 'n',
			eventType: 'net.authorize.payment.refund.created',
		});
		const verifier = makeVerifier();
		const result = asPayment(await verifier.verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('refunded');
		expect(result?.paymentId).toBe('');
		expect(result?.amount).toBe(0);
	});
});

describe('event → SubscriptionEvent mapping (Authorize.net ARB)', () => {
	function makeVerifier() {
		return createAuthorizenetVerifier({ signatureKey: SIGNATURE_KEY });
	}

	it('maps net.authorize.customer.subscription.created to subscription.created', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_001',
			eventType: 'net.authorize.customer.subscription.created',
			payload: {
				id: '4567',
				name: 'Pro Plan',
				amount: '29.99',
				customerProfileId: 9123,
			},
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result).not.toBeNull();
		expect(result!.type).toBe('subscription.created');
		expect(result!.subscriptionId).toBe('4567');
		expect(result!.provider).toBe('authorizenet');
		expect(result!.productId).toBe('Pro Plan');
		expect(result!.customerRef).toBe('9123');
		expect(result!.status).toBe('active');
		expect(result!.amount).toBe(29.99);
	});

	it('maps net.authorize.payment.authcapture.created with subscriptionId to subscription.renewed', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_renew',
			eventType: 'net.authorize.payment.authcapture.created',
			payload: {
				id: 'TRANS_RENEW_001',
				subscriptionId: 4567,
				authAmount: '29.99',
				settleAmount: '29.99',
			},
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.renewed');
		expect(result!.subscriptionId).toBe('4567');
		expect(result!.status).toBe('active');
		expect(result!.amount).toBe(29.99);
	});

	it('does NOT treat net.authorize.payment.authcapture.created without subscriptionId as a renewal', async () => {
		const body = JSON.stringify({
			notificationId: 'plain_capture',
			eventType: 'net.authorize.payment.authcapture.created',
			payload: { id: 'TRANS_ONE_TIME', authAmount: '5.00', settleAmount: '5.00' },
		});
		const result = asPayment(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result?.status).toBe('success');
	});

	it('maps net.authorize.customer.subscription.failed to subscription.payment_failed', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_fail',
			eventType: 'net.authorize.customer.subscription.failed',
			payload: { id: '4567', amount: '29.99' },
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.payment_failed');
		expect(result!.status).toBe('past_due');
	});

	it('maps net.authorize.customer.subscription.updated to subscription.updated', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_upd',
			eventType: 'net.authorize.customer.subscription.updated',
			payload: { id: '4567' },
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.updated');
	});

	it('maps net.authorize.customer.subscription.suspended to subscription.updated with paused status', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_sus',
			eventType: 'net.authorize.customer.subscription.suspended',
			payload: { id: '4567' },
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.updated');
		expect(result!.status).toBe('paused');
	});

	it('maps net.authorize.customer.subscription.cancelled to subscription.canceled', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_can',
			eventType: 'net.authorize.customer.subscription.cancelled',
			payload: { id: '4567' },
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.canceled');
		expect(result!.status).toBe('canceled');
	});

	it('maps net.authorize.customer.subscription.expired to subscription.canceled', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_exp',
			eventType: 'net.authorize.customer.subscription.expired',
			payload: { id: '4567' },
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result!.type).toBe('subscription.canceled');
	});

	it('resolves the subscriptionId from the subscriptionId field when payload.id is absent', async () => {
		const body = JSON.stringify({
			notificationId: 'arb_sid',
			eventType: 'net.authorize.customer.subscription.created',
			payload: { subscriptionId: 998877, name: 'Pro Plan', customerProfileId: 555 },
		});
		const result = asSubscription(await makeVerifier().verify(body, await signedHeaders(body)));
		expect(result!.subscriptionId).toBe('998877');
		expect(result!.productId).toBe('Pro Plan');
		expect(result!.customerRef).toBe('555');
	});
});

describe('getAuthorizenetPortalUrl', () => {
	it('returns the live merchant interface URL by default', () => {
		expect(getAuthorizenetPortalUrl()).toBe('https://account.authorize.net/');
	});

	it('returns the sandbox merchant interface URL when mode is sandbox', () => {
		expect(getAuthorizenetPortalUrl({ mode: 'sandbox' })).toBe('https://sandbox.authorize.net/');
	});
});
