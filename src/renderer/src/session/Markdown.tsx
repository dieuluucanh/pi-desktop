import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../ui/cn";
import { normalizeLanguage } from "./code-language";

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

interface TokenLike {
  content: string;
  color?: string;
}

interface HighlighterLike {
  loadLanguage(language: string): Promise<void>;
  codeToTokens(code: string, options: { lang: string; theme: string }): { tokens: TokenLike[][] };
}

const HIGHLIGHT_THEME = "github-dark";

let highlighterPromise: Promise<HighlighterLike | null> | null = null;
const loadedLanguages = new Set<string>();

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

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const resolved = normalizeLanguage(language);
  const key = `${resolved}\u0000${code}`;
  const [highlighted, setHighlighted] = useState<{ key: string; tokens: TokenLike[][] } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const highlighter = await loadHighlighter();
      if (!highlighter || cancelled) return;
      try {
        if (!loadedLanguages.has(resolved)) {
          await highlighter.loadLanguage(resolved);
          loadedLanguages.add(resolved);
        }
        const { tokens } = highlighter.codeToTokens(code, {
          lang: resolved,
          theme: HIGHLIGHT_THEME,
        });
        if (!cancelled) setHighlighted({ key, tokens });
      } catch {
        // Unknown grammar: the plain fallback below is what the user sees.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, key, resolved]);

  const current = highlighted?.key === key ? highlighted.tokens : null;

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

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("pi-markdown text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
          code: ({ className: codeClass, children: code }) => {
            const text = String(code ?? "").replace(/\n$/, "");
            const language = /language-([\w+#-]+)/.exec(codeClass ?? "")?.[1];
            return <CodeBlock code={text} {...(language ? { language } : {})} />;
          },
          pre: ({ children: content }) => <>{content}</>,
          table: ({ children: content }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-xs [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-raised [&_th]:px-2 [&_th]:py-1">
                {content}
              </table>
            </div>
          ),
          ul: ({ children: content }) => (
            <ul className="my-2 list-disc space-y-1 pl-5">{content}</ul>
          ),
          ol: ({ children: content }) => (
            <ol className="my-2 list-decimal space-y-1 pl-5">{content}</ol>
          ),
          p: ({ children: content }) => <p className="my-2 first:mt-0 last:mb-0">{content}</p>,
          h1: ({ children: content }) => (
            <h3 className="mt-3 mb-1 text-sm font-semibold">{content}</h3>
          ),
          h2: ({ children: content }) => (
            <h3 className="mt-3 mb-1 text-sm font-semibold">{content}</h3>
          ),
          h3: ({ children: content }) => (
            <h4 className="mt-3 mb-1 text-sm font-semibold">{content}</h4>
          ),
          blockquote: ({ children: content }) => (
            <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-muted">
              {content}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-line" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
