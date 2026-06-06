import type { PaymentResult, WebhookEvent } from '@aquarian-metals/coin-moebius-core';
import type { PaymentStore } from './types.js';

/**
 * A provider-specific webhook verifier. Each payment provider's `/server`
 * package exposes a function matching this shape (see Stripe's
 * `createStripeVerifier`, Cryptomus's `createCryptomusVerifier`, etc.).
 *
 * Returns a `WebhookEvent` (a `kind: 'payment'` payment result or a
 * `kind: 'subscription'` subscription event) when the verifier handles
 * the event, or `null` when the signature is valid but the event isn't
 * one the consumer should act on (e.g., Stripe's `product.created` on
 * a webhook subscribed to everything). Callers should treat `null` as
 * "ignore this event, return 200 to the provider" rather than a failure.
 */
export type Verifier = (rawBody: unknown, headers?: unknown) => Promise<WebhookEvent | null>;

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
	 * Dispatch a raw webhook body + headers to a provider's verifier.
	 *
	 * Provider resolution (C3 — provider-confusion safe):
	 *   1. If `providerId` is passed, it's used as-is. Pass it from a TRUSTED
	 *      source — e.g. the webhook URL path you control (`/webhook/:provider`)
	 *      — NOT from request data.
	 *   2. Otherwise, if exactly one verifier is registered, that one is used
	 *      (unambiguous; an attacker can't steer the choice).
	 *   3. Otherwise (multiple verifiers, no explicit id) it REJECTS rather than
	 *      trusting the attacker-controllable `x-provider` header / `provider`
	 *      body field to pick among them.
	 *
	 * Returns a `WebhookEvent` for a recognized event, `null` when the signed
	 * event isn't one the consumer should act on (see {@link Verifier}).
	 */
	verify(rawBody: unknown, headers?: unknown, providerId?: string): Promise<WebhookEvent | null>;
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
		verify(rawBody, headers, providerId) {
			let resolved = providerId;

			if (!resolved) {
				const headerRecord = headers as Record<string, string | undefined> | undefined;
				const bodyRecord = rawBody as Record<string, string | undefined> | undefined;
				const sniffed = headerRecord?.['x-provider'] ?? bodyRecord?.provider;

				if (registry.size === 1) {
					// Unambiguous: only one verifier can possibly handle this.
					resolved = registry.keys().next().value;
				} else if (registry.size >= 2) {
					// C3: with multiple verifiers, do NOT pick using the
					// attacker-controllable `x-provider` header / `provider` body
					// field — that's provider confusion (route a forged payload to a
					// weaker verifier). Make the caller pass the id from a trusted
					// channel (e.g. the webhook URL path) instead.
					return Promise.reject(
						new Error(
							sniffed
								? `coin-moebius: refusing to resolve the provider from request data ("${sniffed}") when ${registry.size} verifiers are registered. Pass the provider id explicitly — verify(body, headers, providerId) — from a trusted source such as the webhook URL path.`
								: 'coin-moebius: no provider id given and multiple verifiers are registered. Pass it explicitly: verify(body, headers, providerId).',
						),
					);
				} else {
					// Empty registry: nothing to confuse. Carry the requested id
					// through only so the "no verifier registered" error can name it.
					resolved = sniffed;
				}
			}

			const verifier = registry.get(resolved ?? '');
			if (!verifier) {
				return Promise.reject(
					new Error(`coin-moebius: no verifier registered for provider "${resolved}"`),
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
