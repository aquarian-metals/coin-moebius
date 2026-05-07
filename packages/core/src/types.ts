export interface PaymentResult {
	status: 'success' | 'pending' | 'failed';
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
		}
	): void | Promise<void>;
}
