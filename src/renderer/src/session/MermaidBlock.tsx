import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/app-store";
import { CodeBlock } from "./Markdown";
import { normalizeMermaidMode, shouldRenderMermaid } from "./mermaid-mode";

/**
 * A Mermaid diagram in the transcript (2026-10-26 session-parity plan step 19).
 *
 * Mermaid is large, so it is imported lazily and only when a diagram is actually
 * going to be drawn. Rendering waits for an idle tick so a streaming fence does
 * not re-parse on every delta. Any failure — a syntax error, a missing chunk, a
 * strict-mode rejection — falls back to the code block plus the error, which is
 * also what terminal Pi shows for an unrenderable diagram.
 *
 * The SVG is inserted as **DOM nodes**, not an HTML string: it is parsed with
 * `DOMParser`, stripped of scripts, foreign content, event-handler attributes and
 * `javascript:` links, then imported. Mermaid already runs with
 * `securityLevel: "strict"`; this second pass is what keeps a compromised or
 * future-buggy renderer from executing markup in the app window.
 */

const RENDER_DELAY_MS = 120;

interface MermaidLike {
  initialize(options: Record<string, unknown>): void;
  render(
    id: string,
    text: string,
  ): Promise<{ svg: string; bindFunctions?: (element: Element) => void }>;
}

let mermaidPromise: Promise<MermaidLike | null> | null = null;
let initialized = false;
let diagramCounter = 0;

function loadMermaid(): Promise<MermaidLike | null> {
  mermaidPromise ??= import("mermaid")
    .then((module) => {
      const api = module.default;
      if (!initialized) {
        api.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "dark",
          fontFamily: "inherit",
        });
        initialized = true;
      }
      return api;
    })
    .catch(() => null);
  return mermaidPromise;
}

/** Sanitizes one parsed SVG root in place (scripts, handlers, javascript: links). */
function sanitizeSvg(root: Element): void {
  for (const node of root.querySelectorAll("script, foreignObject, iframe, object, embed")) {
    node.remove();
  }
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (
        (attribute.name === "href" || attribute.name === "xlink:href") &&
        /^\s*(javascript|data:text\/html)/i.test(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

export function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }) {
  const stored = useAppStore((state) => state.effectiveSetting("markdown.mermaid"));
  const mode = normalizeMermaidMode(stored);
  const draw = shouldRenderMermaid(mode, streaming);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<{ key: string; svg: string | null; error: string | null }>({
    key: "",
    svg: null,
    error: null,
  });

  useEffect(() => {
    if (!draw) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const mermaid = await loadMermaid();
        if (!mermaid || cancelled) return;
        diagramCounter += 1;
        try {
          const { svg } = await mermaid.render(`pi-mermaid-${diagramCounter}`, code);
          if (!cancelled) setState({ key: code, svg, error: null });
        } catch (error) {
          if (!cancelled) {
            setState({
              key: code,
              svg: null,
              error: error instanceof Error ? error.message : "This diagram could not be rendered.",
            });
          }
        }
      })();
    }, RENDER_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, draw]);

  const current = state.key === code ? state : null;
  const svg = current?.svg ?? null;

  // The sanitizer runs before the nodes enter this document.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!svg) {
      host.replaceChildren();
      return;
    }
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") {
      host.replaceChildren();
      return;
    }
    sanitizeSvg(root);
    host.replaceChildren(document.importNode(root, true));
  }, [svg]);

  if (!draw || current?.error) {
    return (
      <div data-testid="mermaid-fallback">
        <CodeBlock code={code} language="mermaid" />
        {current?.error ? (
          <p className="mt-1 text-[11px] text-warn">Mermaid: {current.error}</p>
        ) : null}
      </div>
    );
  }
  if (!current?.svg) {
    return (
      <div data-testid="mermaid-loading" className="rounded-sm border border-line bg-sunken p-3">
        <pre className="overflow-x-auto font-mono text-xs text-ink-muted">{code}</pre>
      </div>
    );
  }
  return (
    <div
      ref={hostRef}
      data-testid="mermaid-diagram"
      className="my-2 overflow-x-auto rounded-sm border border-line bg-sunken p-2 [&_svg]:h-auto [&_svg]:max-w-full"
    />
  );
}
