import type { PaymentResult } from '@aquarian-metals/coin-moebius-core';
import type { PaymentStore } from './types.js';

/**
 * A provider-specific webhook verifier. Each payment provider's `/server`
 * package exposes a function matching this shape (see Stripe's
 * `createStripeVerifier`, Cryptomus's `createCryptomusVerifier`, etc.).
 *
 * Returns `null` when the verifier successfully verified the signature but
 * the event isn't a payment event the consumer should act on (e.g., Stripe's
 * `product.created` for a subscribed-to-everything webhook). Callers should
 * treat `null` as "ignore this event, return 200 to the provider" rather than
 * a failure.
 */
export type Verifier = (rawBody: unknown, headers?: unknown) => Promise<PaymentResult | null>;

/**
 * A registry of payment-provider verifiers, instantiated per-consumer so no
 * registration state is shared across users of this package.
 *
 * Create one via {@link createVerifierRegistry}, register the verifiers you
 * use, then dispatch incoming webhook bodies to the right verifier via
 * {@link VerifierRegistry.verify}.
 */
export interface VerifierRegistry {
	/**
	 * Register a verifier for the given provider id. Subsequent calls to
	 * {@link VerifierRegistry.verify} that resolve the same provider id will
	 * dispatch to this verifier. Re-registering a provider id replaces the
	 * previous verifier.
	 */
	register(providerId: string, verifier: Verifier): void;

	/**
	 * Resolve a provider from the request (header `x-provider` or body field
	 * `provider`), then dispatch the raw body + headers to that provider's
	 * verifier. Returns a `PaymentResult` for a real payment event, `null`
	 * when the signed event isn't one the consumer should act on (see
	 * {@link Verifier}). Rejects when no provider id is resolvable or no
	 * verifier is registered for it.
	 */
	verify(rawBody: unknown, headers?: unknown): Promise<PaymentResult | null>;
}

/**
 * Create a fresh verifier registry. Each call returns an isolated instance —
 * registrations on one don't affect any other. This makes the package safe
 * to use in multi-tenant runtimes (one registry per tenant) and removes
 * cross-test contamination concerns.
 *
 * @example
 *   const verifiers = createVerifierRegistry();
 *   verifiers.register('stripe', createStripeVerifier({ endpointSecret }));
 *   verifiers.register('cryptomus', createCryptomusVerifier({ ... }));
 *
 *   // In your webhook handler:
 *   const result = await verifiers.verify(req.body, req.headers);
 */
export function createVerifierRegistry(): VerifierRegistry {
	const registry = new Map<string, Verifier>();

	return {
		register(providerId, verifier) {
			registry.set(providerId, verifier);
		},
		verify(rawBody, headers) {
			const headerRecord = headers as Record<string, string | undefined> | undefined;
			const bodyRecord = rawBody as Record<string, string | undefined> | undefined;
			const providerId = headerRecord?.['x-provider'] ?? bodyRecord?.provider;
			const verifier = registry.get(providerId ?? '');

			if (!verifier) {
				return Promise.reject(
					new Error(`coin-moebius: no verifier registered for provider "${providerId}"`),
				);
			}

			return verifier(rawBody, headers);
		},
	};
}

/**
 * Server-side polling helper for delayed-confirmation flows. Polls a
 * {@link PaymentStore} directly on a configurable interval until the
 * payment lands in `success` (or `pending`, repeatedly, until `timeoutMs`).
 *
 * Note: there's a sibling helper on the browser side —
 * `payments.subscribeToStatus(paymentId, { statusEndpoint, ... })` from
 * `@aquarian-metals/coin-moebius-core`. The split is by environment:
 *
 * - **This one** (server): polls a {@link PaymentStore} directly. Use when
 *   the polling happens server-side (e.g., a worker waiting on a delayed
 *   webhook before triggering downstream logic).
 * - **Browser version**: polls an HTTP endpoint via `fetch`. Use when the
 *   polling happens in the buyer's browser, where no `PaymentStore` is
 *   reachable.
 *
 * They share no implementation; pick the one whose environment matches.
 */
export function createStatusSubscriber(store: PaymentStore) {
	return function subscribeToStatus(
		paymentId: string,
		handlers: {
			onPending?: (result: PaymentResult) => void;
			onSuccess?: (result: PaymentResult) => void;
			onTimeout?: () => void;
		},
		options: { pollIntervalMs?: number; timeoutMs?: number } = {},
	) {
		const { pollIntervalMs = 15000, timeoutMs = 30 * 60 * 1000 } = options;
		const start = Date.now();

		// setInterval expects a sync callback; we run async work in an IIFE
		// wrapped with `void` for explicit fire-and-forget semantics. The
		// re-entrancy edge case (slow store.get overlapping the next tick) is
		// a known Phase 3 candidate for a setTimeout-chain refactor.
		const interval = setInterval(() => {
			void (async () => {
				if (Date.now() - start > timeoutMs) {
					clearInterval(interval);
					handlers.onTimeout?.();
					return;
				}

				const record = await store.get(paymentId);
				if (!record) return;

				if (record.status === 'pending') handlers.onPending?.(record);
				if (record.status === 'success') {
					clearInterval(interval);
					handlers.onSuccess?.(record);
				}
			})();
		}, pollIntervalMs);

		return () => clearInterval(interval);
	};
}

export { createMemoryStore } from './memory.js';
export type { PaymentStore, PaymentRecord } from './types.js';
