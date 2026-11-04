/**
 * Clipboard access (2026-10-30 copy plan).
 *
 * The renderer copies in four places — a transcript message, a checkpoint ref,
 * an Office document id and the Office diagnostics bundle — and each used to
 * call `navigator.clipboard` by hand. A denied permission therefore looked like
 * a successful copy: the promise rejected into a catch that did nothing. This
 * module is the one place that decides how text reaches the clipboard and it
 * reports whether it worked, so a caller can say "copy failed" instead of
 * pretending.
 *
 * The selection helpers exist because the extension TUI surface is a focused
 * terminal-like element: Ctrl+C must copy a real DOM selection instead of being
 * forwarded to the extension as `^C` (see `TuiSurface`). Both helpers require
 * the selection's anchor **and** focus to be inside the supplied root, so a
 * selection that starts in the transcript and ends in the rail is not mistaken
 * for a surface selection.
 */

/** Copies `text`, returning whether it reached the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  if (text.length === 0) return false;
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // A denied permission falls through to the legacy path; the fallback is
      // what makes copy work in an older/embedded webview.
    }
  }
  return legacyCopy(text);
}

/**
 * The pre-Async-Clipboard path. `execCommand` is deprecated but is the only
 * fallback when `navigator.clipboard` is missing or denied, and it is guarded so
 * a test environment without it simply reports failure.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** The selected text when both ends of the selection are inside `root`. */
export function selectedTextWithin(root: Element | null): string | null {
  if (!root || typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;
  if (!root.contains(anchorNode) || !root.contains(focusNode)) return null;
  const text = selection.toString();
  return text.length > 0 ? text : null;
}

/** Whether a non-collapsed selection lives entirely inside `root`. */
export function hasSelectionWithin(root: Element | null): boolean {
  return selectedTextWithin(root) !== null;
}
