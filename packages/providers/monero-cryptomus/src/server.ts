import type { PaymentResult } from '@coin-moebius/core';
import crypto from 'node:crypto';

export interface CryptomusVerifierConfig {
	merchantUuid: string;
	paymentApiKey: string;
}

export function createCryptomusVerifier(config: CryptomusVerifierConfig) {
	return async function verifyCryptomusWebhook(rawBody: unknown, headers: unknown): Promise<PaymentResult> {
		void headers;
		void config.merchantUuid;
		const raw = rawBody as Record<string, unknown>;
		const receivedSign = raw.sign;
		if (!receivedSign || typeof receivedSign !== 'string') {
			throw new Error('coin-moebius/monero-cryptomus: missing sign field');
		}

		const { sign, ...payloadForSign } = raw;
		void sign;
		const payloadString = JSON.stringify(payloadForSign);

		const expectedSign = crypto.createHmac('sha256', config.paymentApiKey).update(payloadString).digest('hex');

		if (expectedSign !== receivedSign) {
			throw new Error('coin-moebius/monero-cryptomus: invalid signature');
		}

		const status = raw.status as string;

		const md = raw.metadata as Record<string, unknown> | undefined;

		const result: PaymentResult = {
			status: status === 'confirmed' ? 'success' : 'pending',
			paymentId: (raw.uuid || raw.order_id) as string,
			provider: 'monero-cryptomus',
			amount: parseFloat(String(raw.amount)),
			currency: raw.currency as string,
			metadata: {
				address: raw.address,
				txHash: raw.txid || undefined,
				confirmations: raw.confirmations || 0,
				...(md ?? {}),
			},
			timestamp: Date.now(),
			raw,
		};

		return result;
	};
}
