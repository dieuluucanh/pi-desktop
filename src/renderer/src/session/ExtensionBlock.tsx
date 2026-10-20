import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { RenderRequest, RenderTarget, RenderedFrame } from "../../../shared/extension-render";
import type { TuiFrame } from "../../../shared/tui-surface";
import { useAppStore } from "../state/app-store";
import { AnsiBlock } from "../tui/AnsiBlock";

/**
 * An extension-owned renderer's output (plan step 18).
 *
 * A registered `renderCall`/`renderResult`, `registerMessageRenderer` or
 * `registerEntryRenderer` runs in the host and returns ANSI lines. This asks for
 * that frame and shows it; when the item has no renderer (or the renderer threw)
 * it shows `fallback`, which is the app's native card — Pi's own fallback.
 *
 * Rendering is request/response rather than a pushed frame because two inputs
 * are renderer-local: `expanded` (the app's expand state, which the user can
 * flip) and `width` (the measured transcript grid). `input.version` is the
 * content signature, so a streaming tool re-requests as its result changes.
 */

/** Debounce between a content change and the render request (streaming tools). */
const RENDER_DEBOUNCE_MS = 30;

/** Fallback cell width before a real measurement (jsdom reports zero). */
const FALLBACK_CHAR_PX = 7.2;
const DEFAULT_COLUMNS = 100;
const MIN_COLUMNS = 20;
const MAX_COLUMNS = 400;

export interface ExtensionRenderInput {
  target: RenderTarget;
  /** `customType` for a message/entry; the tool name for a tool. */
  type: string;
  toolCallId?: string;
  args?: unknown;
  result?: unknown;
  message?: unknown;
  entry?: unknown;
  isPartial?: boolean;
  isError?: boolean;
  argsComplete?: boolean;
  showImages?: boolean;
  /** Changes whenever the rendered content changes (a tool's `version`). */
  version?: number | string;
}

/** Measures how many monospace cells the wrapper spans, so the host renders to fit. */
function useElementColumns(ref: React.RefObject<HTMLElement | null>): number {
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => {
      const width = node.getBoundingClientRect().width;
      if (width <= 0) return;
      const next = Math.max(
        MIN_COLUMNS,
        Math.min(MAX_COLUMNS, Math.floor(width / FALLBACK_CHAR_PX)),
      );
      setColumns((previous) => (previous === next ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

function toTuiFrame(frame: RenderedFrame): TuiFrame {
  return {
    seq: 0,
    width: frame.width,
    height: frame.lines.length,
    lines: frame.lines,
    cursor: null,
  };
}

function buildRequest(
  input: ExtensionRenderInput,
  width: number,
  expanded: boolean,
): RenderRequest {
  return {
    target: input.target,
    type: input.type,
    width,
    expanded,
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.args === undefined ? {} : { args: input.args }),
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.entry === undefined ? {} : { entry: input.entry }),
    ...(input.isPartial === true ? { isPartial: true } : {}),
    ...(input.isError === true ? { isError: true } : {}),
    ...(input.argsComplete === true ? { argsComplete: true } : {}),
    ...(input.showImages === undefined ? {} : { showImages: input.showImages }),
  };
}

export interface ExtensionBlockProps {
  tabId: string;
  input: ExtensionRenderInput;
  expanded: boolean;
  /** The native card to keep when there is no renderer. */
  fallback: ReactNode;
  /**
   * Pi hides a bare `CustomEntry` entirely when no `registerEntryRenderer`
   * matched it (`addCustomEntryToChat` → `CustomEntryComponent.hasContent()`),
   * whereas a `CustomMessage` always renders its own default box. A renderer that
   * *threw* still shows a card (Pi shows an error box), so only the genuinely
   * renderer-less case hides.
   */
  hideWhenUnrendered?: boolean;
  className?: string;
}

export function ExtensionBlock({
  tabId,
  input,
  expanded,
  fallback,
  hideWhenUnrendered = false,
  className,
}: ExtensionBlockProps): ReactElement {
  const request = useAppStore((state) => state.extensionRender);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const width = useElementColumns(containerRef);
  const [state, setState] = useState<{ key: string; frame: RenderedFrame } | null>(null);

  const key = `${input.target}:${input.type}:${input.toolCallId ?? ""}:${String(
    input.version ?? "",
  )}:${expanded ? 1 : 0}:${width}`;

  // The effect is keyed on the content signature, not on `input`'s identity: a
  // re-render caused by the response must not schedule another request. The
  // closure still sees this render's `input`, which is what the key describes.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void request(tabId, buildRequest(input, width, expanded)).then((frame) => {
        if (!cancelled && frame) setState({ key, frame });
      });
    }, RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the signature of `input`.
  }, [key, tabId, width, expanded, request]);

  const frame = state?.key === key ? state.frame : null;

  // The container stays mounted with nothing in it so the width measurement (and
  // therefore the render request) still works; only the contents are hidden.
  const body =
    frame && frame.rendered && frame.lines.length > 0 ? (
      <AnsiBlock frame={toTuiFrame(frame)} className="font-mono text-xs leading-tight" />
    ) : frame?.error ? (
      // A renderer existed and failed: Pi shows its own fallback here.
      fallback
    ) : hideWhenUnrendered ? null : (
      fallback
    );

  return (
    <div ref={containerRef} data-extension-render="" className={className}>
      {body}
    </div>
  );
}
