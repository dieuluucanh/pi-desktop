import type { CSSProperties } from "react";

import type { AnsiStyle } from "../../../shared/ansi";

/**
 * The selection treatment for extension-drawn UI (plan step 2).
 *
 * Pi marks the selected element of a `ctx.ui.custom` component with a
 * **background fill** — `theme.bg("selectedBg", …)`. The workflow extension's
 * questionnaire is the case the app meets in the wild: its tab row draws the
 * active tab with that fill and nothing else, so the desktop has to recognise
 * the signal itself.
 *
 * The desktop renders the fill as Pi's raw terminal hex, which reads as a dull
 * grey block inside the app's own palette and never says "selected". So the app
 * re-paints it with its own selection style: a tinted surface, a heavier
 * weight and an accent underline.
 *
 * The rule is deliberately narrow: it applies to **TUI-surface frames only**
 * (the `ctx.ui.custom` path). An extension *renderer* — a tool card, a custom
 * message — legitimately paints `userMessageBg` and `toolPendingBg` surfaces,
 * and those are surfaces, not selections.
 */

/**
 * The classes that mark a selected span: the app's selection surface plus an
 * accent underline. They are Tailwind utilities (not inline styles) so the
 * colour comes from the token file and the renderer stays testable.
 */
export const SELECTED_SPAN_CLASS = "bg-selected underline decoration-2 decoration-accent";

/** True when a span carries a background fill — Pi's "this is selected" mark. */
export function isSelectedSpan(style: AnsiStyle): boolean {
  return style.bg !== null;
}

/**
 * The app's selection style for a selected span. The surface and the underline
 * come from `SELECTED_SPAN_CLASS`; only the foreground is inline, because it is
 * Pi's own colour for that element.
 */
export function selectedSpanStyle(style: AnsiStyle): CSSProperties {
  const css: CSSProperties = { fontWeight: 600 };
  if (style.fg) css.color = style.fg;
  return css;
}
