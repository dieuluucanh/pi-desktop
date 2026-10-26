/**
 * Paste markers (2026-10-26 session-parity plan step 20).
 *
 * Terminal Pi collapses a large paste into one token (`pi-tui/editor.js`) so a
 * 200-line file does not bury the prompt. The desktop keeps the same workflow on
 * its plain textarea: the marker lives in the draft, the body lives in renderer
 * memory, and only the expanded text is ever sent or mirrored to the host.
 *
 * The marker is deliberately part of the text: native undo, word navigation and
 * clipboard behaviour keep working, and a restart leaves a marker whose content
 * is gone — which is why it says so instead of silently sending a token.
 */

/** More than this many lines collapses a paste. */
export const PASTE_LINE_THRESHOLD = 10;
/** ...or more than this many characters. */
export const PASTE_CHAR_THRESHOLD = 1_000;

/** `[paste #3 +240 lines]` / `[paste #4 4200 chars]`. */
export const PASTE_MARKER_PATTERN = /\[paste #(\d+) (?:\+(\d+) lines|(\d+) chars)\]/g;

export interface PasteMarker {
  id: number;
  start: number;
  end: number;
  text: string;
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

/** True when a paste is large enough to be collapsed. */
export function shouldCollapsePaste(text: string): boolean {
  return lineCount(text) > PASTE_LINE_THRESHOLD || text.length > PASTE_CHAR_THRESHOLD;
}

/** The marker a collapsed paste leaves in the draft. */
export function pasteMarkerText(id: number, text: string): string {
  const lines = lineCount(text);
  return lines > PASTE_LINE_THRESHOLD
    ? `[paste #${id} +${lines} lines]`
    : `[paste #${id} ${text.length} chars]`;
}

/** Every marker currently in a draft, in order. */
export function findPasteMarkers(text: string): PasteMarker[] {
  const markers: PasteMarker[] = [];
  const scanner = new RegExp(PASTE_MARKER_PATTERN.source, "g");
  for (let found = scanner.exec(text); found !== null; found = scanner.exec(text)) {
    markers.push({
      id: Number(found[1]),
      start: found.index,
      end: found.index + found[0].length,
      text: found[0],
    });
  }
  return markers;
}

/** Marker ids with no body in this session's map (a restart lost them). */
export function lostPasteIds(text: string, known: ReadonlySet<number>): number[] {
  return [...new Set(findPasteMarkers(text).map((marker) => marker.id))].filter(
    (id) => !known.has(id),
  );
}

/** Replaces every marker whose body is known; an unknown marker stays as text. */
export function expandPasteMarkers(
  text: string,
  bodies: ReadonlyMap<number, string>,
  onMissing?: (id: number) => void,
): string {
  return text.replace(
    new RegExp(PASTE_MARKER_PATTERN.source, "g"),
    (whole: string, idText: string) => {
      const id = Number(idText);
      const body = bodies.get(id);
      if (body === undefined) {
        onMissing?.(id);
        return whole;
      }
      return body;
    },
  );
}

/**
 * Collapses a text into markers (used when a draft arrives from outside the
 * textarea, e.g. an extension's `setEditorText`). Round-tripping an existing
 * marker is a no-op.
 */
export function collapsePastes(text: string, register: (body: string) => string): string {
  if (!shouldCollapsePaste(text)) return text;
  if (findPasteMarkers(text).length > 0 && text.trimStart().startsWith("[paste #")) {
    return text;
  }
  return register(text);
}
