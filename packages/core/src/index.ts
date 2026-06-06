import type { PaymentProvider, InitiateOptions, PaymentResult, PaymentStatus } from './types.js';
import type { WebhookEvent, SubscriptionEvent } from './types.js';

export type {
	PaymentProvider,
	InitiateOptions,
	PaymentResult,
	PaymentStatus,
	SubscriptionEvent,
	SubscriptionEventType,
	SubscriptionStatus,
	WebhookEvent,
} from './types.js';

export { minorUnitExponent, minorToMajorUnits, majorToMinorUnits } from './currency.js';

/**
 * Narrow a `WebhookEvent` to its `PaymentResult` variant. Returns the
 * inner payment shape (without the `kind` discriminator) when the event
 * is a payment, or `null` when the input is null/undefined or a
 * subscription event. Pair with `asSubscription` for an exhaustive switch.
 *
 * Accepts `null`/`undefined` so callers can chain it directly onto a
 * `verify()` call: `asPayment(await verifier.verify(body, headers))`.
 */
export function asPayment(event: WebhookEvent | null | undefined): PaymentResult | null {
	return event?.kind === 'payment' ? stripKind(event) : null;
}

/**
 * Narrow a `WebhookEvent` to its `SubscriptionEvent` variant. Returns the
 * inner subscription shape (without the `kind` discriminator) when the
 * event is a subscription, or `null` when the input is null/undefined or
 * a one-time payment event.
 */
export function asSubscription(event: WebhookEvent | null | undefined): SubscriptionEvent | null {
	return event?.kind === 'subscription' ? stripKind(event) : null;
}

function stripKind<T extends { kind: string }>(event: T): Omit<T, 'kind'> {
	const { kind: _kind, ...rest } = event;
	return rest;
}

/**
 * Buyer-shaped keys that should never be echoed to a browser. A verifier puts
 * the gateway's own buyer details on `metadata` (email, name, address, …) for
 * server-side use; sending the whole result back to the page would leak them.
 */
const BUYER_PII_KEYS = new Set([
	'email',
	'customer_email',
	'payer_email',
	'buyer_email',
	'customer_details',
	'billing_address',
	'shipping_address',
	'phone',
	'name',
	'first_name',
	'last_name',
	'ip_address',
]);

/**
 * Project a {@link PaymentResult} down to what's safe to return to a BROWSER
 * (W2). Drops the full `raw` gateway event and strips buyer PII from
 * `metadata`, leaving just status/amount/currency/ids. Use this on any status
 * endpoint the SDK's `subscribeToStatus` polls — the verifier's full result is
 * for your server, not the buyer's page.
 *
 * @example
 *   // status endpoint:
 *   res.json(toPublicPaymentResult(await store.get(paymentId)));
 */
export function toPublicPaymentResult(result: PaymentResult): PaymentResult {
	const safeMetadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(result.metadata ?? {})) {
		if (!BUYER_PII_KEYS.has(key)) safeMetadata[key] = value;
	}
	return {
		status: result.status,
		paymentId: result.paymentId,
		provider: result.provider,
		amount: result.amount,
		currency: result.currency,
		timestamp: result.timestamp,
		metadata: safeMetadata,
		// `raw` (full gateway event) is deliberately omitted.
	};
}

/**
 * Lifecycle precedence for a {@link PaymentStatus}. Higher = later in the
 * payment's life. Providers re-deliver and networks reorder, so a `pending`
 * webhook can arrive AFTER the `success` one for the same payment id. Stores
 * must not let that regress a settled payment back to pending — compare ranks
 * and only advance. `success` and `failed` are both terminal (equal rank), as
 * are `refunded`/`disputed`; among equals it's last-write-wins.
 */
const PAYMENT_STATUS_RANK: Record<PaymentStatus, number> = {
	pending: 0,
	partial: 1,
	success: 2,
	failed: 2,
	refunded: 3,
	disputed: 3,
};

/** Numeric lifecycle rank for a status (see {@link PAYMENT_STATUS_RANK}). */
export function paymentStatusRank(status: PaymentStatus): number {
	return PAYMENT_STATUS_RANK[status];
}

/**
 * True when moving from `prev` to `next` would REGRESS the payment lifecycle
 * (i.e. `next` ranks strictly lower than `prev`) — e.g. a late `pending` after
 * `success`. Stores should ignore such updates so a settled payment isn't
 * clobbered by a stale or replayed earlier-stage delivery.
 */
export function isStatusRegression(prev: PaymentStatus, next: PaymentStatus): boolean {
	return PAYMENT_STATUS_RANK[next] < PAYMENT_STATUS_RANK[prev];
}

export interface PaymentManagerConfig {
	providers: PaymentProvider[];
}

export function createPaymentManager(config: PaymentManagerConfig) {
	const providerMap = new Map(config.providers.map((p) => [p.id, p]));

	const listeners = {
		success: [] as ((result: PaymentResult) => void)[],
		pending: [] as ((result: PaymentResult) => void)[],
		error: [] as ((error: Error) => void)[],
	};

	const manager = {
		initiate(options: InitiateOptions) {
			const providerId = options.providerId ?? config.providers[0]?.id;
			const provider = providerMap.get(providerId);

			if (!provider) {
				throw new Error(`coin-moebius: unknown provider "${providerId}"`);
			}

			return provider.initiate(options, {
				onSuccess: (result: PaymentResult) => listeners.success.forEach((cb) => cb(result)),
				onPending: (result: PaymentResult) => listeners.pending.forEach((cb) => cb(result)),
				onError: (err: Error) => listeners.error.forEach((cb) => cb(err)),
			});
		},

		onSuccess(cb: (result: PaymentResult) => void) {
			listeners.success.push(cb);
			return () => {
				listeners.success = listeners.success.filter((l) => l !== cb);
			};
		},

		onPending(cb: (result: PaymentResult) => void) {
			listeners.pending.push(cb);
			return () => {
				listeners.pending = listeners.pending.filter((l) => l !== cb);
			};
		},

		onError(cb: (error: Error) => void) {
			listeners.error.push(cb);
			return () => {
				listeners.error = listeners.error.filter((l) => l !== cb);
			};
		},

		/**
		 * Browser-side polling helper for delayed-confirmation flows (Monero
		 * block confirmations, Cryptomus async settlement, etc.). Hits an HTTP
		 * status endpoint on a configurable interval until the payment lands
		 * in `success` (or `pending`, repeatedly, until `timeoutMs`).
		 *
		 * Note: there's a sibling helper on the server side —
		 * `createStatusSubscriber(store)` in `@aquarian-metals/coin-moebius-server`.
		 * The split is by environment:
		 *
		 * - **This one** (browser): polls an HTTP endpoint via `fetch`. Use
		 *   when the polling happens in the buyer's browser.
		 * - **Server version**: polls a `PaymentStore` directly. Use when
		 *   the polling happens server-side (e.g., a worker waiting for a
		 *   delayed webhook before triggering downstream logic).
		 *
		 * They have different signatures because they read from different
		 * data sources; they share no implementation. Pick the one whose
		 * environment matches your call site.
		 */
		subscribeToStatus(
			paymentId: string,
			handlers: {
				statusEndpoint: string;
				onPending?: (result: PaymentResult) => void;
				onSuccess?: (result: PaymentResult) => void;
				/** Fires once on a terminal NON-success status (failed / refunded /
				 *  disputed), then polling stops. Without it those statuses used to
				 *  poll forever (W1). */
				onFailed?: (result: PaymentResult) => void;
				onTimeout?: () => void;
			},
			options: { pollIntervalMs?: number; timeoutMs?: number } = {},
		) {
			const { statusEndpoint, onPending, onSuccess, onFailed, onTimeout } = handlers;
			const { pollIntervalMs = 15000, timeoutMs = 30 * 60 * 1000 } = options;
			const start = Date.now();

			// W1: a self-scheduling setTimeout chain (not setInterval) so a slow
			// fetch can't overlap the next tick and pile up; an AbortController so
			// cancel/terminal tears down any in-flight request; polling pauses while
			// the tab is hidden and stops on every terminal status — so a finished
			// (or failed/refunded) payment, or a backgrounded tab, never keeps
			// hammering the endpoint and burning the provider's rate limit.
			const controller = new AbortController();
			let stopped = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const stop = () => {
				stopped = true;
				if (timer !== undefined) clearTimeout(timer);
				controller.abort();
			};
			// Small +/-10% jitter so many buy buttons don't poll in lockstep.
			const nextDelay = () => pollIntervalMs * (0.9 + Math.random() * 0.2);
			const schedule = (delay: number) => {
				timer = setTimeout(() => void tick(), delay);
			};

			async function tick(): Promise<void> {
				if (stopped) return;
				if (Date.now() - start > timeoutMs) {
					stop();
					onTimeout?.();
					return;
				}
				// Don't poll a hidden tab — resume on the next tick when visible.
				if (typeof document !== 'undefined' && document.hidden) {
					schedule(nextDelay());
					return;
				}
				try {
					const url = `${statusEndpoint}?paymentId=${encodeURIComponent(paymentId)}`;
					const res = await fetch(url, { signal: controller.signal });
					if (res.ok) {
						const record = (await res.json()) as PaymentResult;
						if (record.status === 'success') {
							stop();
							onSuccess?.(record);
							return;
						}
						if (
							record.status === 'failed' ||
							record.status === 'refunded' ||
							record.status === 'disputed'
						) {
							stop();
							onFailed?.(record);
							return;
						}
						// `pending` / `partial`: still in flight — notify and keep polling.
						if (record.status === 'pending') onPending?.(record);
					}
				} catch {
					/* network error or abort — keep polling unless stopped */
				}
				if (!stopped) schedule(nextDelay());
			}

			schedule(pollIntervalMs);
			return stop;
		},
	};

	return manager;
}
