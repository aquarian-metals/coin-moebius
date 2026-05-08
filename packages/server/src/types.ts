import type { PaymentResult } from '@aquarianmetals/coin-moebius-core';

export interface PaymentRecord extends PaymentResult {
	confirmations?: number;
	createdAt: number;
	updatedAt: number;
}

export interface PaymentStore {
	upsert(record: PaymentRecord): Promise<void>;
	get(paymentId: string): Promise<PaymentRecord | null>;
}
