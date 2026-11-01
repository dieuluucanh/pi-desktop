/**
 * Auto-growing textareas.
 *
 * Both composers are two rows high by default, but a prompt or a commit message
 * is frequently longer than that. A fixed `rows` value hides the rest behind a
 * tiny scroll area (or, worse, pushes the send/commit button out of view), so
 * the box grows with its content and then scrolls at a cap.
 *
 * The cap is a pixel constant rather than a Tailwind class so the measurement
 * and the CSS cannot drift: {@link useAutoGrowTextarea} writes both `height` and
 * `max-height` from the same number. The CSS floor (`min-h-16`) still applies,
 * which is what keeps an empty box at its intended two rows.
 *
 * Measuring trick: set `height: auto`, read `scrollHeight`, add the element's
 * border, then set an explicit `height`. `scrollHeight` excludes the border and
 * the app uses `box-sizing: border-box`, so omitting the border shaves the last
 * line by 2 px. jsdom reports `scrollHeight === 0` (no layout); the hook leaves
 * the CSS sizing alone there, and the tests mock the value when they need to
 * exercise the clamp.
 */

import { useLayoutEffect, type RefObject } from "react";

/** The session prompt's cap: the old `max-h-48` (12 rem at a 16 px root). */
export const PROMPT_MAX_HEIGHT_PX = 192;

/** The commit message's cap. Eight lines of `text-xs` plus padding/border. */
export const COMMIT_MESSAGE_MAX_HEIGHT_PX = 160;

/**
 * Clamps a measured height into `[0, max]`, rounding up so a wrapped line can
 * never be cut in half. A non-finite or non-positive measurement means "no
 * layout yet" and yields 0, which the hook treats as "leave the CSS alone".
 */
export function clampedTextareaHeight(measured: number, max: number): number {
  if (!Number.isFinite(measured) || measured <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 0;
  return Math.min(max, Math.ceil(measured));
}

/**
 * Keeps a textarea as tall as its content, up to `maxPx`.
 *
 * Runs after every committed render (including an external draft restored from
 * history) and before paint, so the box never flashes at the wrong height.
 */
export function useAutoGrowTextarea(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxPx: number,
): void {
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;

    node.style.maxHeight = `${maxPx}px`;
    // Reset first: a previously set explicit height would make `scrollHeight`
    // report the old height for short content.
    node.style.height = "auto";
    const border = Math.max(0, node.offsetHeight - node.clientHeight);
    const height = clampedTextareaHeight(node.scrollHeight + border, maxPx);
    if (height > 0) node.style.height = `${height}px`;
  }, [ref, value, maxPx]);
}
