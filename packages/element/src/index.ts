/**
 * Side-effect entry point. Importing this module registers
 * `<coin-moebius-buy>` with the browser's custom-element registry.
 *
 * For consumers who want the class without the side effect (e.g., to
 * register under a different tag, or to extend it), import from
 * `@aquarian-metals/coin-moebius-element/element-class` instead.
 *
 * Registration is idempotent: re-importing this module in the same page
 * (e.g., from two bundles that both depend on it) won't throw — we check
 * the registry first.
 */
import { CoinMoebiusBuyElement, COIN_MOEBIUS_BUY_TAG } from './element-class.js';

export { CoinMoebiusBuyElement, COIN_MOEBIUS_BUY_TAG } from './element-class.js';
export type { PublicProjectInfo, PublicProviderInfo } from './element-class.js';

// Browser-only side effect. Guarded so the module loads without throwing in
// SSR / Node environments — useful for tools that pre-render pages including
// the element's HTML (the element does nothing until the browser hydrates).
if (typeof customElements !== 'undefined' && !customElements.get(COIN_MOEBIUS_BUY_TAG)) {
	customElements.define(COIN_MOEBIUS_BUY_TAG, CoinMoebiusBuyElement);
}
