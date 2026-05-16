/**
 * Possible values for `PaymentResult.status`.
 *
 * - `success` — terminal positive state for the original payment.
 * - `pending` — payment is in flight (async confirmations, awaiting clearing, etc.).
 * - `failed` — terminal negative state (declined card, expired auth, hard fail).
 * - `refunded` — money returned to the buyer after a successful payment.
 *   Refunds can be partial — consumers reading `amount` should treat it as
 *   the amount refunded, not the original payment total.
 * - `disputed` — buyer initiated a chargeback / dispute. The funds may still
 *   be in your account at this moment; the provider is signaling the case
 *   exists so you can respond.
 * - `partial` — buyer paid less than the invoiced amount (most common with
 *   crypto invoices where the network sent under the requested value). The
 *   `amount` reflects what was actually received.
 */
export type PaymentStatus = 'success' | 'pending' | 'failed' | 'refunded' | 'disputed' | 'partial';

export interface PaymentResult {
	status: PaymentStatus;
	paymentId: string;
	provider: string;
	amount: number;
	currency: string;
	metadata: Record<string, unknown>;
	timestamp: number;
	raw?: unknown;
}

export interface InitiateOptions {
	productId: string;
	amount: number;
	currency: string;
	metadata?: Record<string, unknown>;
	providerId?: string;
}

export interface PaymentProvider {
	id: string;
	name: string;
	icon?: string;

	initiate(
		options: InitiateOptions,
		callbacks: {
			onSuccess: (result: PaymentResult) => void;
			onPending?: (result: PaymentResult) => void;
			onError: (error: Error) => void;
		},
	): void | Promise<void>;
}
