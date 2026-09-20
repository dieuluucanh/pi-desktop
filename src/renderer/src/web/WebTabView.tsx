import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Minus,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";
import type { TabRecord } from "../../../shared/session-ipc";
import { sanitizeWebUrl, WEB_TAB_MAX_ZOOM, WEB_TAB_MIN_ZOOM } from "../../../shared/web-tabs";
import { copyToClipboard } from "./clipboard";
import { webTabBoundsFromRect, overlayOpenIn, observeOverlays } from "./overlay-detect";

/**
 * The chrome around one web tab (plan step 21).
 *
 * The page itself is a native `WebContentsView` owned by main — this component
 * draws only the toolbar and reserves an empty rectangle into which main places
 * the view (reporting the rectangle over `web:set-bounds`). Because a native view
 * always paints above React, the component also reports `visible: false`
 * whenever one of the app's dialogs or menus is open, so an overlay is never
 * hidden behind a review page.
 */
export function WebTabView({ tab }: { tab: TabRecord }) {
  const state = useAppStore((store) => store.webTabStates[tab.id]);
  const webCommand = useAppStore((store) => store.webCommand);
  const setWebTabBounds = useAppStore((store) => store.setWebTabBounds);
  const setHint = useAppStore((store) => store.setHint);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [address, setAddress] = useState(state?.url ?? tab.url ?? "");
  const [lastUrl, setLastUrl] = useState(state?.url ?? tab.url ?? "");

  const url = state?.url ?? tab.url ?? "";
  const zoom = state?.zoom ?? 1;

  // Keep the address bar in step with the page (a redirect changes the URL).
  // Adjusting during render, not in an effect, is React's own recipe for
  // mirroring a prop into editable state without a cascading render.
  if (url !== lastUrl) {
    setLastUrl(url);
    setAddress(url);
  }

  // Report the rectangle main must place the native view at, and re-report it
  // when the layout, the overlays or the window change.
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    let frame = 0;
    const report = (): void => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      setWebTabBounds(tab.id, webTabBoundsFromRect(rect, !overlayOpenIn(document)));
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(report);
    };

    report();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => schedule());
    observer?.observe(element);
    const stopOverlays = observeOverlays(document, () => schedule());
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      stopOverlays();
      window.removeEventListener("resize", schedule);
      // Leaving the tab (or the view) hides the native view; the manager would
      // otherwise keep painting it over whatever replaced this component.
      const rect = element.getBoundingClientRect();
      setWebTabBounds(tab.id, webTabBoundsFromRect(rect, false));
    };
  }, [tab.id, setWebTabBounds]);

  const stopped = state?.status === "failed";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-line bg-sunken px-2 py-1">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back"
          disabled={!state?.canGoBack}
          onClick={() => webCommand(tab.id, { command: "back" })}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Forward"
          disabled={!state?.canGoForward}
          onClick={() => webCommand(tab.id, { command: "forward" })}
        >
          <ArrowRight className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={state?.status === "loading" ? "Stop" : "Reload"}
          onClick={() =>
            webCommand(tab.id, { command: state?.status === "loading" ? "stop" : "reload" })
          }
        >
          {state?.status === "loading" ? (
            <X className="size-3.5" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
        </Button>

        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const target = sanitizeWebUrl(address);
            if (!target) {
              setHint("That is not an http(s) URL.");
              return;
            }
            webCommand(tab.id, { command: "navigate", url: target });
          }}
        >
          {state?.favicon ? (
            <img src={state.favicon} alt="" className="size-3.5 shrink-0" />
          ) : (
            <Globe className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
          )}
          <input
            aria-label="Web address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            spellCheck={false}
            className="min-w-0 flex-1 rounded-sm border border-line bg-raised px-2 py-0.5 font-mono text-[11px] text-ink outline-none"
          />
          <span className="shrink-0 truncate text-[11px] text-ink-faint" title={state?.title ?? ""}>
            {state?.title ?? ""}
          </span>
        </form>

        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Copy URL"
          onClick={() => {
            if (copyToClipboard(url)) setHint("URL copied.");
            else setHint("Could not reach the clipboard.");
          }}
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Open in browser"
          onClick={() => void window.pi?.openExternal(url)}
        >
          <Globe className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Zoom out"
          disabled={zoom <= WEB_TAB_MIN_ZOOM}
          onClick={() =>
            webCommand(tab.id, { command: "zoom", factor: Math.max(WEB_TAB_MIN_ZOOM, zoom - 0.1) })
          }
        >
          <Minus className="size-3.5" aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Zoom in"
          disabled={zoom >= WEB_TAB_MAX_ZOOM}
          onClick={() =>
            webCommand(tab.id, { command: "zoom", factor: Math.min(WEB_TAB_MAX_ZOOM, zoom + 0.1) })
          }
        >
          <Plus className="size-3.5" aria-hidden />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        {/* The native view is placed exactly over this element. */}
        <div ref={hostRef} className="h-full w-full bg-canvas" data-testid="web-tab-host" />
        {stopped ? (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas">
            <div className="flex max-w-md flex-col items-center gap-3 text-center">
              <Globe className="size-6 text-ink-faint" aria-hidden />
              <div className="text-sm font-medium">This page could not be reached.</div>
              <p className="text-xs text-ink-muted">{state?.error ?? "The URL did not load."}</p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => webCommand(tab.id, { command: "reload" })}
              >
                Retry
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
