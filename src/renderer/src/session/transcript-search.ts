/**
 * Transcript find (2026-10-26 session-parity plan step 11).
 *
 * Terminal Pi searches its alt-screen transcript with `ctrl+f`/`ctrl+shift+f`.
 * The desktop transcript is virtualized, so `webContents.findInPage` cannot see
 * off-screen rows; the matcher therefore runs over the transcript's **item
 * model** — the same list the renderer draws from — and returns the item ids a
 * caller scrolls to.
 *
 * Everything here is pure so it can be tested against a 10k-item fixture
 * without a DOM.
 */

import type { TranscriptItem } from "./session-events";

export interface FindMatch {
  /** The transcript item the match lives in. */
  itemId: string;
  /** Zero-based index among all matches, in transcript order. */
  index: number;
  /** A short window around the match, for the find bar's context line. */
  excerpt: string;
}

export interface FindResult {
  matches: FindMatch[];
  /** The compiled pattern (null when the query is empty). */
  pattern: RegExp | null;
  /** A user-facing error for an invalid regular expression. */
  error: string | null;
}

const DEFAULT_LIMIT = 500;
const EXCERPT_RADIUS = 40;

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiles a query into a case-insensitive global pattern. A literal query is
 * escaped, so `a.b` finds the literal text; regex mode surfaces the engine's own
 * message instead of silently finding nothing.
 */
export function compileFindPattern(
  query: string,
  useRegex = false,
): { pattern: RegExp | null; error: string | null } {
  if (query.length === 0) return { pattern: null, error: null };
  if (!useRegex) return { pattern: new RegExp(escapeRegExp(query), "gi"), error: null };
  try {
    return { pattern: new RegExp(query, "gi"), error: null };
  } catch (error) {
    return {
      pattern: null,
      error: error instanceof Error ? error.message : "Invalid regular expression",
    };
  }
}

/** Splits `text` into alternating plain and matched parts (never zero-length). */
export function splitByPattern(
  text: string,
  pattern: RegExp,
): Array<{ text: string; match: boolean }> {
  const scanner = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  const parts: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;
  for (let found = scanner.exec(text); found !== null; found = scanner.exec(text)) {
    // A zero-width match would loop forever and renders nothing; step past it.
    if (found[0].length === 0) {
      scanner.lastIndex += 1;
      continue;
    }
    if (found.index > cursor) parts.push({ text: text.slice(cursor, found.index), match: false });
    parts.push({ text: found[0], match: true });
    cursor = found.index + found[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  return parts;
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Everything a row shows, in reading order, that find should search. */
export function searchableTextOf(item: TranscriptItem): string {
  if (item.kind === "message") {
    const chunks: string[] = [item.message.customType ?? ""];
    for (const block of item.message.blocks) {
      if (block.kind === "text" || block.kind === "thinking") chunks.push(block.text);
      else if (block.kind === "toolCall") {
        chunks.push(block.name, block.arguments);
      }
    }
    return chunks.join("\n");
  }
  if (item.kind === "tool") {
    return [
      item.tool.toolName,
      asText(item.tool.args),
      item.tool.partial ?? "",
      item.tool.resultText ?? "",
    ].join("\n");
  }
  return [item.notice.text, item.notice.detail ?? ""].join("\n");
}

function excerptAround(haystack: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(haystack.length, index + length + EXCERPT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < haystack.length ? "…" : "";
  return `${prefix}${haystack.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

export function findInTranscript(
  items: readonly TranscriptItem[],
  query: string,
  options: { useRegex?: boolean; limit?: number } = {},
): FindResult {
  const { pattern, error } = compileFindPattern(query, options.useRegex === true);
  if (!pattern) return { matches: [], pattern: null, error };
  const limit = options.limit ?? DEFAULT_LIMIT;
  const matches: FindMatch[] = [];
  for (const item of items) {
    const haystack = searchableTextOf(item);
    if (haystack.length === 0) continue;
    const scanner = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (let found = scanner.exec(haystack); found !== null; found = scanner.exec(haystack)) {
      if (found[0].length === 0) {
        scanner.lastIndex += 1;
        continue;
      }
      if (matches.length >= limit) return { matches, pattern, error };
      matches.push({
        itemId: item.id,
        index: matches.length,
        excerpt: excerptAround(haystack, found.index, found[0].length),
      });
    }
  }
  return { matches, pattern, error };
}

/**
 * The next/previous index with wrapping. `direction` is +1 for next, -1 for
 * previous; an empty list answers -1 so the caller can render "no matches".
 */
export function stepMatchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/**
 * A minimal rehype plugin that wraps every match inside text nodes in
 * `<mark class="pi-find">` (plan step 11: "inline highlight via a small AST
 * transform (no new dependency)").
 *
 * It walks the hast tree by hand: react-markdown exposes text nodes only through
 * a plugin, and adding `rehype-highlight`-style dependencies for one `<mark>` is
 * not worth the surface. Code blocks, tables and inline code are plain text
 * nodes too, so a match inside a tool result or snippet highlights as well.
 */
interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

export function rehypeFindHighlight(pattern: RegExp): () => (tree: HastNode) => void {
  const visit = (node: HastNode): void => {
    const children = node.children;
    if (!children || children.length === 0) return;
    const next: HastNode[] = [];
    for (const child of children) {
      if (child.type === "text" && typeof child.value === "string" && child.value.length > 0) {
        const parts = splitByPattern(child.value, pattern);
        if (parts.some((part) => part.match)) {
          for (const part of parts) {
            next.push(
              part.match
                ? {
                    type: "element",
                    tagName: "mark",
                    properties: { className: ["pi-find"] },
                    children: [{ type: "text", value: part.text }],
                  }
                : { type: "text", value: part.text },
            );
          }
          continue;
        }
      }
      visit(child);
      next.push(child);
    }
    node.children = next;
  };
  return () =>
    (tree: HastNode): void =>
      visit(tree);
}
