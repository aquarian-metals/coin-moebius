# @aquarian-metals/coin-moebius-element

## 0.3.0

### Minor Changes

- Initial release. Ships the `<coin-moebius-buy>` custom element — a drop-in HTML widget that gives any static site a working buy button + provider-picker modal with two lines of markup (one `<script>` tag, one element).

  **Features:**
  - Shadow-DOM-isolated UI; host page styles can't bleed in or be leaked out.
  - Lazy public-info fetch — only hits `/api/projects/:id/public-info` on first click, not on mount.
  - Per-provider checkout dispatch: Stripe/Cryptomus/NOWPayments redirect to hosted page; manual flow renders mailing instructions inline.
  - CSS-customizable via custom properties (`--cm-color`, `--cm-button-bg`, etc.) and `::part()` selectors (`button`, `modal`, `dialog`, `provider`, `close`, `instructions`).
  - Auto-registers `<coin-moebius-buy>` on import; class-only export available at `@aquarian-metals/coin-moebius-element/element-class` for advanced consumers.
  - Cancelable `cm-load-providers` / `cm-checkout-started` / `cm-error` CustomEvents for analytics + consent hooks.
  - Full accessibility: `role="dialog"` + `aria-modal="true"` + `aria-labelledby` + `aria-live` status region, focus trap (Tab/Shift+Tab cycle within dialog), Escape-to-close, focus restoration to the trigger on close.

  **Bundle size:** ~3 KB brotlied (well under the 8 KB budget).
