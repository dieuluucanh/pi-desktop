/**
 * Displayed-row measurement for a textarea's caret.
 *
 * The composer is a plain `<textarea>`, and a long line wraps at the control's
 * width. The browser moves the caret by **displayed** rows when the user presses
 * a plain `ArrowUp`/`ArrowDown`; history must only take the key when the caret is
 * already on the first/last displayed row. There is no DOM API that exposes a
 * textarea's line layout, so this module recreates it: an offscreen div carries
 * the textarea's computed text styles and padding, holds the same value, and a
 * one-character `Range` probe reports which row the caret is on. (A collapsed
 * range cannot distinguish the two sides of a soft-wrap boundary.)
 *
 * Terminal Pi measures the same thing from its own visual-line map
 * (`pi-tui/dist/components/editor.js:328-337`: `isOnFirstVisualLine` /
 * `isOnLastVisualLine`).
 *
 * The zero-width space after the value is deliberate: a trailing newline does
 * not create a line box in a `pre-wrap` div, but the textarea still shows (and
 * lets the caret sit on) that empty last line. The sentinel forces the line to
 * exist, so `lastRow` and a caret at `value.length` cover the trailing-newline
 * case too. A zero-width glyph cannot wrap an already-full line.
 *
 * Every failure path returns `null` instead of guessing. The caller then falls
 * back to its logical-line check: jsdom has no layout (and no
 * `Range.getBoundingClientRect`), a hidden box has no width, and
 * `line-height: normal` cannot be converted into rows.
 */

/** A caret position in the textarea's displayed (soft-wrapped) lines. */
export interface VisualLinePosition {
  /** The 0-based displayed row the caret is on. */
  row: number;
  /** The 0-based displayed row of the buffer's last line. */
  lastRow: number;
}

/**
 * The text-affecting properties copied from the textarea to the mirror.
 * `line-height` is included because the row maths divides by it; the rest keep
 * the mirror's wrapping identical to the control's.
 *
 * Deliberately not copied: colours, borders, background and the scrollbar — they
 * do not change line breaking. Padding is copied separately by
 * {@link MIRRORED_PADDING}.
 */
const MIRRORED_TEXT_STYLES = [
  "direction",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-kerning",
  "font-feature-settings",
  "letter-spacing",
  "line-height",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "word-spacing",
  "white-space",
  "overflow-wrap",
  "word-break",
  "writing-mode",
] as const;

const MIRRORED_PADDING = [
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;

/** Forces the trailing empty line of a `\n`-terminated value to have a line box. */
const SENTINEL = "\u200b";

/** Parses a computed px value, treating anything unparsable as zero. */
function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The line metrics the row maths needs. */
interface RowMetrics {
  contentTop: number;
  lineHeight: number;
}

/** The mirror's text node and a reusable range for probing it. */
interface TextProbe {
  range: Range;
  text: Text;
}

/**
 * The top of a range's box, or null when this environment has no layout.
 * jsdom implements `Element.getBoundingClientRect` but not the Range one; a
 * missing method means "cannot measure", not "row 0".
 */
function rangeTop(range: Range): number | null {
  // SAFETY: the DOM types always declare this method, but jsdom (the renderer
  // test environment) does not implement it. The optional shape is the runtime
  // truth; the call below is guarded.
  const measure = (range as unknown as { getBoundingClientRect?: () => DOMRect })
    .getBoundingClientRect;
  const rect = measure ? measure.call(range) : null;
  if (!rect || !(rect.height > 0)) return null;
  return rect.top;
}

/** The top of the line box holding one character. */
function charTop(probe: TextProbe, index: number): number | null {
  probe.range.setStart(probe.text, index);
  probe.range.setEnd(probe.text, index + 1);
  return rangeTop(probe.range);
}

/** Converts a box top into a displayed row. */
function rowOfTop(top: number | null, metrics: RowMetrics): number | null {
  return top === null ? null : Math.round((top - metrics.contentTop) / metrics.lineHeight);
}

/**
 * The displayed row the caret belongs to.
 *
 * A collapsed range cannot tell the two sides of a **soft-wrap** boundary
 * apart: browsers report the end of the previous line, which made Up recall
 * history one row early. A normal character is therefore measured as a
 * one-character range — the caret is on the same displayed row as the character
 * after it. A hard newline is different: the caret before it sits at the end of
 * that line, so the line's last character is the probe. Only an empty line has
 * no character to probe; there the collapsed caret is unambiguous, because a
 * hard break (unlike a soft wrap) has a definite side.
 */
function caretRow(
  probe: TextProbe,
  value: string,
  offset: number,
  metrics: RowMetrics,
): number | null {
  const character = value[offset] ?? "";
  if (character !== "\n") {
    return rowOfTop(charTop(probe, offset), metrics);
  }
  const lineStart = value.lastIndexOf("\n", offset - 1) + 1;
  if (lineStart < offset) {
    return rowOfTop(charTop(probe, offset - 1), metrics);
  }
  probe.range.setStart(probe.text, offset);
  probe.range.collapse(true);
  return rowOfTop(rangeTop(probe.range), metrics);
}

/**
 * The caret's displayed row (`row`) and the buffer's last displayed row
 * (`lastRow`) for a textarea, or `null` when layout is unavailable.
 *
 * The mirror is removed before returning, including on every early exit.
 */
export function textareaVisualLines(
  node: HTMLTextAreaElement,
  offset: number,
): VisualLinePosition | null {
  // `wrap="off"` never soft-wraps, so logical lines are the displayed lines.
  if (node.wrap === "off") return null;

  const value = node.value;
  if (value.length === 0) return { row: 0, lastRow: 0 };

  const width = node.clientWidth;
  if (!(width > 0)) return null;

  const styles = getComputedStyle(node);
  const lineHeight = pixels(styles.getPropertyValue("line-height"));
  if (!(lineHeight > 0)) return null;
  const paddingTop = pixels(styles.getPropertyValue("padding-top"));
  const paddingBottom = pixels(styles.getPropertyValue("padding-bottom"));

  const body = document.body;
  if (!body) return null;

  const mirror = document.createElement("div");
  mirror.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: -10000px",
    "visibility: hidden",
    "pointer-events: none",
    "box-sizing: border-box",
    `width: ${width}px`,
    "height: auto",
    "margin: 0",
    "border: 0",
    "overflow: visible",
  ].join(";");
  for (const property of MIRRORED_TEXT_STYLES) {
    const computed = styles.getPropertyValue(property);
    if (computed) mirror.style.setProperty(property, computed);
  }
  for (const property of MIRRORED_PADDING) {
    const computed = styles.getPropertyValue(property);
    if (computed) mirror.style.setProperty(property, computed);
  }
  // `clientWidth` already excludes the border and the scrollbar and includes the
  // padding, which is exactly what a border-box div of this width reproduces.
  mirror.textContent = value + SENTINEL;

  body.appendChild(mirror);
  try {
    const mirrorRect = mirror.getBoundingClientRect();
    const contentTop = mirrorRect.top + paddingTop;
    const contentHeight = mirrorRect.height - paddingTop - paddingBottom;
    if (!Number.isFinite(contentHeight) || contentHeight <= 0) return null;
    const lastRow = Math.max(0, Math.round(contentHeight / lineHeight) - 1);

    const text = mirror.firstChild;
    if (!(text instanceof Text)) return null;

    const caret = Math.min(Math.max(Math.trunc(offset), 0), value.length);
    const metrics: RowMetrics = { contentTop, lineHeight };
    const probe: TextProbe = { range: document.createRange(), text };
    const row = caret >= value.length ? lastRow : caretRow(probe, value, caret, metrics);
    if (row === null || !Number.isFinite(row)) return null;
    return { row: Math.min(Math.max(row, 0), lastRow), lastRow };
  } finally {
    mirror.remove();
  }
}
