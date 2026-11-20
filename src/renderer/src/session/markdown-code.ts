/**
 * Block-code extraction for the transcript's markdown renderer.
 *
 * `react-markdown` 10 has no `inline` flag: its `code` component is called for
 * both an inline span and a fenced/indented block. The only stable
 * discriminator is the hast shape — a block is `pre > code`, a span is a bare
 * `code`. A `language-*` class cannot be used: a fence without an info string
 * has no class at all, and an inline span has none either.
 *
 * The text is read from the hast node instead of React children so a
 * `rehypeFindHighlight` `<mark>` (or any future inline node) inside a fence can
 * never turn the source into `[object Object]`.
 */

export interface MarkdownCodeBlock {
  /** The fence body, with exactly one trailing newline removed. */
  code: string;
  /** The fence info string's first token (`ts`, `bash`, …), or null. */
  language: string | null;
}

interface HastNode {
  type?: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function isElement(node: HastNode | undefined): node is HastNode & { tagName: string } {
  return node?.type === "element" && typeof node.tagName === "string";
}

/** The first `language-*` class of a code element, if it has one. */
function languageOf(properties: Record<string, unknown> | undefined): string | null {
  const className = properties?.className;
  const classes = Array.isArray(className)
    ? className.filter((value): value is string => typeof value === "string")
    : typeof className === "string"
      ? className.split(/\s+/)
      : [];
  for (const value of classes) {
    const match = /^language-(\S+)$/i.exec(value);
    const language = match?.[1];
    if (language) return language;
  }
  return null;
}

/** Recursively concatenates every text node under `node`. */
function textOf(node: HastNode): string {
  if (typeof node.value === "string") return node.value;
  let text = "";
  for (const child of node.children ?? []) text += textOf(child);
  return text;
}

/**
 * The block a `pre` node represents, or null when the node is not a
 * `pre > code` pair (an inline span, raw HTML, a malformed tree).
 */
export function blockCodeOf(node: unknown): MarkdownCodeBlock | null {
  if (!node || typeof node !== "object") return null;
  const element = node as HastNode;
  if (!isElement(element) || element.tagName !== "pre") return null;
  const code = element.children?.find((child) => isElement(child) && child.tagName === "code");
  if (!code) return null;
  return {
    // `mdast-util-to-hast` appends one newline to a fence's value; strip that
    // one so the highlighter and the Copy action see the source as written.
    code: textOf(code).replace(/\n$/, ""),
    language: languageOf(code.properties),
  };
}
