import type { PaymentResult } from '@aquarian-metals/coin-moebius-core';

/**
 * The five statuses a manual transaction can be in.
 */
export type ManualStatus = 'pending_manual' | 'succeeded' | 'manual_canceled' | 'manual_expired';

/**
 * Persistent state for a manual transaction. Sellers store one row per
 * transaction (typically in a `transactions` table) and update via the
 * state-machine helpers in this module.
 */
export interface ManualTransactionState {
	status: ManualStatus;
	referenceCode: string;
	createdAt: number;
	expectedAmount: number;
	expectedCurrency: string;
	receivedAmount?: number;
	confirmedAt?: number;
}

/**
 * Options for {@link generateReferenceCode}.
 */
export interface ReferenceCodeOptions {
	/**
	 * Prefix for the code. Defaults to `"GBK"` (Goldbacks). Use `"CASH"`,
	 * `"WIRE"`, `"CHECK"`, etc. when the manual flow isn't Goldback-specific.
	 */
	prefix?: string;

	/**
	 * Number of random characters after the prefix. Defaults to `4`. Each
	 * character is from an unambiguous alphabet (no `0`/`O`/`1`/`I`/`L`).
	 */
	length?: number;
}

/**
 * Unambiguous alphabet: A-Z and 2-9, minus characters that look alike when
 * handwritten on an envelope (`0`, `O`, `1`, `I`, `L`).
 */
const REFCODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Generate a human-readable reference code for a manual payment.
 *
 * Format: `<prefix>-<random>`. Default `GBK-XXXX` (e.g., `GBK-7F2A`).
 *
 * The random portion uses an unambiguous alphabet so the buyer can write
 * or type it onto an envelope without errors. Uses `crypto.getRandomValues`
 * for an unbiased distribution — the code doesn't need to be unguessable
 * but the alphabet bias of `Math.random()` would be sloppy.
 *
 * @example
 *   generateReferenceCode();                              // "GBK-7F2A"
 *   generateReferenceCode({ prefix: 'CASH', length: 6 }); // "CASH-K3PQRW"
 */
export function generateReferenceCode(opts: ReferenceCodeOptions = {}): string {
	const prefix = opts.prefix ?? 'GBK';
	const length = opts.length ?? 4;

	const buf = new Uint8Array(length);
	crypto.getRandomValues(buf);

	let random = '';
	for (let i = 0; i < length; i++) {
		random += REFCODE_ALPHABET[buf[i] % REFCODE_ALPHABET.length];
	}

	return `${prefix}-${random}`;
}

/**
 * Transition a manual transaction from `pending_manual` to `succeeded`.
 *
 * Called when the seller clicks "Mark received" in their dashboard. Returns
 * both the new state (for persistence) and the normalized `PaymentResult`
 * to fire on the SDK's status endpoint.
 *
 * `result.metadata.amountMatch` is `false` when the seller typed in a
 * received amount that differs from what was originally expected — useful
 * for the dashboard to flag potential discrepancies.
 *
 * @throws if the current state isn't `pending_manual` — idempotent callers
 *   should check `state.status` first; double-calls indicate a logic bug.
 */
export function markReceived(
	state: ManualTransactionState,
	receivedAmount: number,
): { state: ManualTransactionState; result: PaymentResult } {
	if (state.status !== 'pending_manual') {
		throw new Error(
			`coin-moebius/manual: cannot mark received — current status is "${state.status}", not "pending_manual"`,
		);
	}

	const now = Date.now();
	const nextState: ManualTransactionState = {
		...state,
		status: 'succeeded',
		receivedAmount,
		confirmedAt: now,
	};

	const result: PaymentResult = {
		status: 'success',
		paymentId: state.referenceCode,
		provider: 'manual',
		amount: receivedAmount,
		currency: state.expectedCurrency,
		metadata: {
			referenceCode: state.referenceCode,
			expectedAmount: state.expectedAmount,
			amountMatch: receivedAmount === state.expectedAmount,
		},
		timestamp: now,
	};

	return { state: nextState, result };
}

/**
 * Transition a manual transaction to `manual_canceled`.
 *
 * Called when the seller refuses to honor a pending payment — e.g., the
 * envelope never arrived, or it arrived empty. Notifying the buyer is the
 * caller's responsibility; this only updates the state.
 *
 * @throws if the current state isn't `pending_manual`.
 */
export function cancelPending(state: ManualTransactionState): ManualTransactionState {
	if (state.status !== 'pending_manual') {
		throw new Error(
			`coin-moebius/manual: cannot cancel — current status is "${state.status}", not "pending_manual"`,
		);
	}
	return { ...state, status: 'manual_canceled' };
}

/**
 * Transition a manual transaction to `manual_expired`.
 *
 * Called by the seller's nightly cron when a `pending_manual` transaction
 * has been open longer than the project's configured timeout (typically
 * 30 days). The reference code is not reused — uniqueness is enforced at
 * the transaction-row level via the seller's `UNIQUE(provider, provider_event_id)`
 * constraint.
 *
 * @throws if the current state isn't `pending_manual`.
 */
export function expirePending(state: ManualTransactionState): ManualTransactionState {
	if (state.status !== 'pending_manual') {
		throw new Error(
			`coin-moebius/manual: cannot expire — current status is "${state.status}", not "pending_manual"`,
		);
	}
	return { ...state, status: 'manual_expired' };
}
