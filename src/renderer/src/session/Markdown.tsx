import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { cn } from "../ui/cn";
import { normalizeLanguage } from "./code-language";
import { useFindPattern } from "./find-context";
import { rehypeFindHighlight } from "./transcript-search";
import { MermaidBlock } from "./MermaidBlock";
import { blockCodeOf } from "./markdown-code";
import {
  createHighlightStore,
  HIGHLIGHT_THEME,
  type HighlightLines,
  type HighlighterLike,
} from "./highlight-store";

/**
 * Markdown and code rendering (plan step 5).
 *
 * Shiki is loaded lazily, only when a code block appears, and with an empty
 * language set so each block pulls in just its own grammar. Crucially it is used
 * through `codeToTokens` and rendered as React elements — no HTML string is ever
 * injected, so a code block cannot smuggle markup into the transcript. If the
 * highlighter cannot load (packaging, CSP, a missing grammar) the block falls
 * back to plain text: highlighting is a nicety, never a reason for the
 * transcript to show nothing.
 */

/**
 * Inline code's pill (2026-11-06 transcript-markdown-parity).
 *
 * `bg-code-bg` is a derived ink wash rather than `bg-raised`: the light palette
 * makes `raised` white, and the user bubble is white too. See `tokens.css`.
 */
const INLINE_CODE_CLASS =
  "rounded-xs bg-code-bg px-1 py-0.5 font-mono text-[0.9em] text-ink break-words";

let highlighterPromise: Promise<HighlighterLike | null> | null = null;

function loadHighlighter(): Promise<HighlighterLike | null> {
  highlighterPromise ??= import("shiki/bundle/web")
    .then(async (module) => {
      const created = await module.createHighlighter({ themes: [HIGHLIGHT_THEME], langs: [] });
      // SAFETY: `createHighlighter` returns codeToHtml/codeToTokens plus many
      // loader helpers; we only call the two methods declared above, and the
      // token shape is shiki's own documented `{content, color}`.
      return created as unknown as HighlighterLike;
    })
    .catch(() => null);
  return highlighterPromise;
}

/**
 * One cache for every code block in the app (2026-11-07 plan).
 *
 * Component state cannot survive a virtualized row unmounting, so the tokens
 * live outside React; the store also bounds itself by entry count and source
 * size. See `highlight-store.ts` for the cache contract.
 */
const blockHighlights = createHighlightStore(loadHighlighter);

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const resolved = normalizeLanguage(language);
  const key = `${resolved}\u0000${code}`;
  const [highlighted, setHighlighted] = useState<{ key: string; tokens: HighlightLines } | null>(
    null,
  );

  // Two defences against the reported flash. `cached` makes a remount paint
  // colour on its very first frame. `sync` tokenizes during render when Shiki
  // and this grammar are already warm, so a block seen for the first time in
  // this mount is coloured too. Both are synchronous, so nothing paints grey
  // and then recolours a frame later.
  const immediate = useMemo(
    () => blockHighlights.cached(key) ?? blockHighlights.sync(key, code, resolved),
    [key, code, resolved],
  );

  useEffect(() => {
    // A warm block is already painted; only the first load (or a cold grammar)
    // needs the async path.
    if (immediate) return;
    let cancelled = false;
    void blockHighlights.load(key, code, resolved).then((tokens) => {
      if (!cancelled && tokens) setHighlighted({ key, tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [immediate, key, code, resolved]);

  // An empty token list has nothing to paint; treating it as "no highlight"
  // keeps the source visible instead of rendering an empty <pre>.
  const painted = highlighted?.key === key ? highlighted.tokens : immediate;
  const current = painted && painted.length > 0 ? painted : null;

  return (
    <pre className="overflow-x-auto rounded-sm border border-line bg-sunken p-3 font-mono text-xs">
      <code>
        {current
          ? current.map((line, lineIndex) => (
              <span key={lineIndex} className="block">
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} style={token.color ? { color: token.color } : undefined}>
                    {token.content}
                  </span>
                ))}
                {"\n"}
              </span>
            ))
          : code}
      </code>
    </pre>
  );
}

/**
 * `streaming` reaches the `pre` renderer through context, not a closure
 * (2026-11-07 transcript-highlight-stability).
 *
 * `components` used to be built inside `Markdown`, which gave every renderer a
 * new function identity on every render. `react-markdown` uses those functions
 * as React element types, so a re-render (a store push, a click, the focus
 * re-sync) unmounted and remounted the whole Markdown subtree — and `CodeBlock`
 * lost its highlighted tokens. The map below is created once for the life of the
 * bundle.
 */
const MarkdownStreamingContext = createContext(false);

function MarkdownPre({ node, children: content }: { node?: unknown; children?: ReactNode }) {
  // The context read is what lets this one identity serve both the streaming and
  // settled states without being recreated per render.
  const streaming = useContext(MarkdownStreamingContext);
  const block = blockCodeOf(node);
  if (!block) return <pre>{content}</pre>;
  // A mermaid fence is a diagram, not source (plan step 19); the component falls
  // back to the same code block when it cannot draw.
  if (block.language?.toLowerCase() === "mermaid") {
    return <MermaidBlock code={block.code} streaming={streaming} />;
  }
  return <CodeBlock code={block.code} {...(block.language ? { language: block.language } : {})} />;
}

/**
 * Module-level element overrides.
 *
 * Every entry must stay a stable reference: a changed element type makes React
 * unmount and remount that subtree. A per-instance value (today only
 * `streaming`) belongs in a context, never in a closure over this object.
 */
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children: label }) => (
    <a
      href={href}
      className="text-accent underline"
      onClick={(event) => {
        // The renderer never navigates itself; the OS opens the URL.
        event.preventDefault();
        if (href) void window.pi?.openExternal(href);
      }}
    >
      {label}
    </a>
  ),
  // A span is a bare `code`; a block is `pre > code`. react-markdown 10 has no
  // `inline` prop, and a `language-*` class is not a reliable discriminator (a
  // fence without an info string has none), so `MarkdownPre` owns the AST-shape
  // decision.
  code: ({ children: content }) => <code className={INLINE_CODE_CLASS}>{content}</code>,
  pre: MarkdownPre,
  table: ({ children: content }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-raised [&_th]:px-2 [&_th]:py-1">
        {content}
      </table>
    </div>
  ),
  ul: ({ children: content }) => <ul className="my-2 list-disc space-y-1 pl-5">{content}</ul>,
  ol: ({ children: content }) => <ol className="my-2 list-decimal space-y-1 pl-5">{content}</ol>,
  p: ({ children: content }) => <p className="my-2 first:mt-0 last:mb-0">{content}</p>,
  h1: ({ children: content }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{content}</h3>,
  h2: ({ children: content }) => <h3 className="mt-3 mb-1 text-sm font-semibold">{content}</h3>,
  h3: ({ children: content }) => <h4 className="mt-3 mb-1 text-sm font-semibold">{content}</h4>,
  blockquote: ({ children: content }) => (
    <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-muted">
      {content}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
};

interface MarkdownProps {
  children: string;
  className?: string;
  /** True while the message streams; `markdown.mermaid: final` waits for it. */
  streaming?: boolean;
}

/**
 * Markdown surface.
 *
 * Memoized because a transcript row re-renders on unrelated store pushes
 * (`SessionView` subscribes to many slices) and re-parsing unchanged Markdown is
 * wasted work. Every prop is a primitive, so a shallow compare is safe; a future
 * per-instance prop must be a primitive too, or reach the renderers through a
 * context (as `streaming` does).
 */
export const Markdown = memo(function Markdown({
  children,
  className,
  streaming = false,
}: MarkdownProps) {
  // The transcript's find bar publishes its pattern through a context, so every
  // markdown surface (message text, summaries, extension output) highlights the
  // same query without threading a prop through each row (plan step 11).
  const findPattern = useFindPattern();
  const rehypePlugins = useMemo(
    () => (findPattern ? [rehypeFindHighlight(findPattern)] : []),
    [findPattern],
  );
  return (
    <div className={cn("pi-markdown text-sm leading-relaxed", className)}>
      <MarkdownStreamingContext.Provider value={streaming}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[...rehypePlugins, rehypeKatex]}
          components={MARKDOWN_COMPONENTS}
        >
          {children}
        </ReactMarkdown>
      </MarkdownStreamingContext.Provider>
    </div>
  );
});
