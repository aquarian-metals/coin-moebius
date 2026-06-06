# Accessibility

The `<coin-moebius-buy>` button is built to meet **WCAG 2.1 Level AA**. Because
the button renders its own UI inside a Shadow DOM, the checkout popup it opens is
accessible out of the box. You drop in the element and your buyers get a keyboard
and screen reader friendly checkout without writing any ARIA yourself.

This page documents what the element supports, where responsibility is shared
with you (the site owner), and the formal conformance report (VPAT).

## What you get for free

Every instance of the button ships with:

- **A real modal dialog.** `role="dialog"`, `aria-modal="true"`, and a heading
  the dialog is labeled by.
- **Full keyboard support.** Tab and Shift+Tab cycle inside the dialog, Escape
  closes it, and focus is trapped while it is open. Focus returns to the button
  that opened it when the dialog closes.
- **Visible focus.** A `:focus-visible` outline on every control for keyboard
  users, without showing a ring on mouse click.
- **Announced status.** Loading uses `role="status"`, errors use `role="alert"`,
  and the dialog body is a polite live region, so screen readers hear what is
  happening.
- **Labeled controls.** Provider buttons, the optional amount input, and the
  trigger all have accessible names. An amount of zero or less is marked
  `aria-invalid` with a described error hint.
- **Headings.** The dialog title is an `<h2>` and the pay by mail sections are
  `<h3>`, so heading navigation works.
- **Reduced motion.** Transitions are dropped under
  `prefers-reduced-motion: reduce`.
- **AA color contrast on the built-in themes** (light and dark), including the
  success and error text.
- **Target size.** Buttons inside the dialog are at least 44 by 44 pixels.

## Your responsibility (shared items)

A few things depend on the page the button lives on, or on how you style it:

1. **Custom colors.** If you override `--cm-button-bg`, `--cm-button-color`,
   `--cm-color-danger`, `--cm-color-success`, or restyle parts with `::part()`,
   you own the contrast of whatever you pick. See "Theming without breaking
   contrast" below.
2. **The trigger's name when you use an icon.** Text inside the button (or the
   `label` attribute) names it. If you slot an icon with no text, set a `label`
   so the button is not announced as just "Buy". The element warns in the
   console when it detects this.
3. **The surrounding page.** Page language (`<html lang>`), landmark structure,
   heading order around the button, and a unique page title are part of your
   page, not the button.

## Theming without breaking contrast

The element exposes status colors as custom properties so you can match your
brand. The defaults already meet AA on the built-in surfaces. If you change
them, keep these minimums against the popup background:

- Body and status text: at least **4.5:1**.
- The focus outline and any control border you rely on to identify a control:
  at least **3:1**.

```css
coin-moebius-buy {
  /* Safe on a light popup (#f5f5f5): both clear 4.5:1. */
  --cm-color-danger: #b91c1c;
  --cm-color-success: #15803d;
}
```

Pick colors with a contrast checker before shipping. The element does not
validate your overrides at runtime, so a low contrast choice will not be caught
for you.

## Testing

Accessibility is covered by automated tests in `packages/element/test`:

- `element.test.ts` asserts the dialog roles, focus trap, status roles, heading
  elements, the invalid amount state, and the trigger fallback name.
- `contrast.test.ts` computes WCAG contrast ratios over the built-in palette and
  fails if any default text token drops below 4.5:1.

These run with the rest of the suite via `npm test`.

---

## Conformance report (VPAT 2.5, WCAG 2.1)

**Product:** `<coin-moebius-buy>` custom element.
**Standard:** Web Content Accessibility Guidelines 2.1, Levels A and AA.
**Terms:** _Supports_ = meets the criterion. _Partially Supports_ = meets it with
exceptions. _Does Not Support_ = does not meet it. _Not Applicable_ = the
criterion does not apply to this component.

### Table 1: Level A

| Criterion                         | Conformance    | Remarks                                                                                        |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| 1.1.1 Non-text Content            | Supports       | Decorative icons are `aria-hidden`; every control has a text or `aria-label` name.             |
| 1.2.1 to 1.2.3 (time-based media) | Not Applicable | The element has no audio or video.                                                             |
| 1.3.1 Info and Relationships      | Supports       | Dialog role, `<h2>`/`<h3>` headings, grouped providers, labeled input with `aria-describedby`. |
| 1.3.2 Meaningful Sequence         | Supports       | DOM order matches reading and focus order.                                                     |
| 1.3.3 Sensory Characteristics     | Supports       | Instructions do not rely on shape or position alone.                                           |
| 1.4.1 Use of Color                | Supports       | Errors carry `role="alert"` text and success carries text, not color alone.                    |
| 1.4.2 Audio Control               | Not Applicable | No audio.                                                                                      |
| 2.1.1 Keyboard                    | Supports       | All actions are operable by keyboard.                                                          |
| 2.1.2 No Keyboard Trap            | Supports       | Escape and the close button dismiss the dialog; focus is restored to the trigger.              |
| 2.1.4 Character Key Shortcuts     | Not Applicable | No single-character shortcuts.                                                                 |
| 2.2.1 Timing Adjustable           | Not Applicable | No time limits.                                                                                |
| 2.2.2 Pause, Stop, Hide           | Not Applicable | No moving or auto-updating content.                                                            |
| 2.3.1 Three Flashes               | Not Applicable | No flashing content.                                                                           |
| 2.4.1 Bypass Blocks               | Not Applicable | Single component, no repeated blocks of content.                                               |
| 2.4.2 Page Titled                 | Not Applicable | The host page owns its title.                                                                  |
| 2.4.3 Focus Order                 | Supports       | Focus enters the dialog on open and follows a logical order.                                   |
| 2.4.4 Link Purpose (In Context)   | Supports       | Controls are buttons with descriptive names.                                                   |
| 2.5.1 Pointer Gestures            | Not Applicable | No multi-point or path-based gestures.                                                         |
| 2.5.2 Pointer Cancellation        | Supports       | Actions fire on the up event via native click.                                                 |
| 2.5.3 Label in Name               | Supports       | Visible text is contained in each control's accessible name.                                   |
| 2.5.4 Motion Actuation            | Not Applicable | No motion-activated features.                                                                  |
| 3.1.1 Language of Page            | Not Applicable | The host page declares `lang`.                                                                 |
| 3.2.1 On Focus                    | Supports       | Focus does not trigger a change of context.                                                    |
| 3.2.2 On Input                    | Supports       | Editing the amount gates the provider buttons; it does not change context.                     |
| 3.3.1 Error Identification        | Supports       | Errors use `role="alert"`; an invalid amount sets `aria-invalid` with a described hint.        |
| 3.3.2 Labels or Instructions      | Supports       | Inputs and buttons are labeled.                                                                |
| 4.1.1 Parsing                     | Supports       | Markup is well formed and generated programmatically.                                          |
| 4.1.2 Name, Role, Value           | Supports       | Roles, names, and states are exposed for all controls.                                         |

### Table 2: Level AA

| Criterion                                       | Conformance        | Remarks                                                                                                                                                    |
| ----------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.2.4 to 1.2.5 (captions, audio description)    | Not Applicable     | No time-based media.                                                                                                                                       |
| 1.3.4 Orientation                               | Supports           | Layout works in portrait and landscape; no orientation lock.                                                                                               |
| 1.3.5 Identify Input Purpose                    | Supports           | The amount field is a transaction value, not an autofill-identified field.                                                                                 |
| 1.4.3 Contrast (Minimum)                        | Supports           | Built-in light and dark themes meet 4.5:1, verified by `contrast.test.ts`. Custom color overrides are the site owner's responsibility.                     |
| 1.4.4 Resize Text                               | Supports           | Sizing uses relative units and scales to 200 percent.                                                                                                      |
| 1.4.5 Images of Text                            | Supports           | No images of text.                                                                                                                                         |
| 1.4.10 Reflow                                   | Supports           | The dialog has a max width, wraps, and scrolls within the viewport on small screens.                                                                       |
| 1.4.11 Non-text Contrast                        | Supports           | The focus outline uses the control's text color (meets 3:1). Control borders are decorative; controls are identified by their text.                        |
| 1.4.12 Text Spacing                             | Supports           | No fixed heights clip text when spacing is increased.                                                                                                      |
| 1.4.13 Content on Hover or Focus                | Supports           | Hover only adjusts opacity; no content appears that must be dismissed.                                                                                     |
| 2.4.5 Multiple Ways                             | Not Applicable     | Single component, not a set of pages.                                                                                                                      |
| 2.4.6 Headings and Labels                       | Supports           | Headings and labels describe their content.                                                                                                                |
| 2.4.7 Focus Visible                             | Supports           | A `:focus-visible` outline is shown on every control.                                                                                                      |
| 3.1.2 Language of Parts                         | Not Applicable     | Content language is inherited from the host page.                                                                                                          |
| 3.2.3 Consistent Navigation                     | Not Applicable     | Single component.                                                                                                                                          |
| 3.2.4 Consistent Identification                 | Supports           | Controls are identified consistently across states.                                                                                                        |
| 3.3.3 Error Suggestion                          | Supports           | The invalid amount hint states how to fix it ("Enter an amount greater than 0").                                                                           |
| 3.3.4 Error Prevention (Legal, Financial, Data) | Partially Supports | The pay by mail flow has an explicit confirm step. For redirect providers, final review and cancellation happen on the provider's own hosted payment page. |
| 4.1.3 Status Messages                           | Supports           | Loading and success use `role="status"`; errors use `role="alert"`; the dialog body is a polite live region.                                               |

### Beyond AA

- **2.5.8 Target Size (Minimum)** (WCAG 2.2 AA) and **2.5.5 Target Size**
  (WCAG 2.1 AAA): dialog buttons are at least 44 by 44 pixels.
