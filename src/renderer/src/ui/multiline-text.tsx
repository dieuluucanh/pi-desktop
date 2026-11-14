import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/**
 * Verbatim multi-line text (2026-11-14 transcript-line-parity).
 *
 * Terminal Pi prints extension-owned text as-is: `ctx.ui.notify`, a confirm
 * message, select option labels and `setWorkingMessage` all keep every source
 * line. HTML collapses those newlines unless `white-space` says otherwise, so
 * every surface that shows this text goes through this primitive. The text is
 * never parsed as Markdown — only `custom_message` / `custom` entry content is.
 *
 * A `<span>` keeps the primitive usable inside the existing `<p>`, `<button>`,
 * `<div>` and flex rows; the layout owner keeps its block/flex classes, and the
 * caller passes any extra class (for example `min-w-0`) through `className`.
 */
export const MULTILINE_TEXT_CLASS = "whitespace-pre-wrap break-words";

export function MultilineText({ className, children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} className={cn(MULTILINE_TEXT_CLASS, className)}>
      {children}
    </span>
  );
}
