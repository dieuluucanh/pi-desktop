/**
 * The terminal surface (2026-11-05 native-terminal plan, step 9).
 *
 * One component owns an xterm instance from the shared pool, forwards keys to
 * the PTY (or to the curated app-action table), reports focus so main can
 * suppress menu accelerators, and renders the exit/trust/error notices. The
 * xterm instance survives unmounts (the pool moves its container), so switching
 * tabs or grid panes never wipes the shell's screen.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { SquareTerminal } from "lucide-react";
import { useStore } from "zustand";
import { Button } from "../ui/button";
import { copyText } from "../ui/clipboard";
import { cn } from "../ui/cn";
import { useAppStore } from "../state/app-store";
import { handleMenuCommand } from "../menu-actions";
import type { TabRecord } from "../../../shared/session-ipc";
import type { TrustAnswer } from "../../../shared/projects";
import { DEFAULT_TERMINAL_FONT_SIZE } from "../../../shared/terminal-prefs";
import {
  terminalKeyDecision,
  type TerminalAppAction,
  type TerminalKeyPlatform,
} from "../../../shared/terminal-keys";
import {
  clampFontSize,
  configureTerminalRuntime,
  ensureTerminalEventPump,
  refreshTerminalTheme,
  terminalPool,
  terminalRuntimeConfig,
  terminalStore,
} from "../terminal/terminal-runtime";
import type { PoolTerminal, TerminalPool } from "../terminal/terminal-pool";
import { terminalFontFamilyFromDocument } from "../terminal/terminal-font";
import type { TerminalStore } from "../state/terminal-store";

export interface TerminalViewProps {
  tab: Pick<TabRecord, "id" | "cwd" | "profileId">;
  /** Test seams; the app uses the renderer-wide singletons. */
  store?: TerminalStore;
  pool?: TerminalPool;
  requestTrust?: (cwd: string) => Promise<boolean>;
  platform?: TerminalKeyPlatform;
}

export function TerminalView({
  tab,
  store = terminalStore,
  pool = terminalPool,
  requestTrust: requestTrustProp,
  platform,
}: TerminalViewProps): React.JSX.Element {
  const prefs = useAppStore((state) => state.prefs.terminal);
  const sessionTrust = useAppStore((state) => state.sessionTrust);
  const state = useStore(store, (snapshot) => snapshot.tabs[tab.id]);
  const [title, setTitle] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [bell, setBell] = useState(false);
  const [detailsCopied, setDetailsCopied] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | null>(null);
  const bellTimer = useRef<number | null>(null);

  const defaultTrust = useCallback(async (cwd: string): Promise<boolean> => {
    // Opening the prompt is all this does; the notice's button decides when to
    // retry with the grant the user gave.
    await useAppStore.getState().openTrustPrompt(cwd);
    return false;
  }, []);
  const requestTrust = requestTrustProp ?? defaultTrust;

  // The event pump is created on the first mounted view, never at import time:
  // a test renderer has no preload bridge.
  useEffect(() => {
    if (store === terminalStore && window.pi?.terminal) ensureTerminalEventPump();
  }, [store]);

  // Keep the runtime's prefs in step with the app; a terminal created after this
  // effect uses them, and an existing one only needs the font/theme applied.
  useEffect(() => {
    configureTerminalRuntime({
      fontSize: prefs.fontSize,
      fontFamily: prefs.fontFamily,
      scrollback: prefs.scrollback,
      cursorStyle: prefs.cursorStyle,
      cursorBlink: prefs.cursorBlink,
      macOptionIsMeta: prefs.macOptionIsMeta,
      copyOnSelection: prefs.copyOnSelection,
      enableBell: prefs.enableBell,
      ...(platform ? { platform } : {}),
      requestTrust,
    });
    refreshTerminalTheme();
    pool.setOptions({
      fontFamily: terminalFontFamilyFromDocument(prefs.fontFamily),
      fontSize: clampFontSize(prefs.fontSize),
      scrollback: prefs.scrollback,
      cursorStyle: prefs.cursorStyle,
      cursorBlink: prefs.cursorBlink,
      macOptionIsMeta: prefs.macOptionIsMeta,
    });
  }, [prefs, platform, requestTrust, pool]);

  // A theme or theme-colour change rewrites the CSS variables on the root; the
  // terminal re-resolves them without losing scrollback or the shell.
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => refreshTerminalTheme());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    return () => observer.disconnect();
  }, []);

  // Lazy start: the shell spawns when the surface first mounts, which is the
  // active tab or a visible grid pane — never every restored tab at launch.
  useEffect(() => {
    if (state?.terminalId) return;
    const grant: TrustAnswer | undefined = sessionTrust.includes(tab.cwd) ? "session" : undefined;
    void store.getState().create(tab.id, tab.cwd, 80, 24, grant, tab.profileId);
  }, [store, tab.id, tab.cwd, tab.profileId, state?.terminalId, sessionTrust]);

  const runAction = useCallback(
    async (action: TerminalAppAction, terminalId: string) => {
      const term = pool.get(terminalId)?.term;
      if (!term) return;
      switch (action) {
        case "copy": {
          const selection = term.getSelection();
          if (selection) await navigator.clipboard.writeText(selection);
          return;
        }
        case "paste": {
          const text = await navigator.clipboard.readText();
          if (text) term.paste(text);
          return;
        }
        case "select-all":
          term.selectAll();
          return;
        case "find":
          setSearchOpen(true);
          return;
        case "clear":
          term.clear();
          return;
        case "new-terminal":
          handleMenuCommand("new-terminal");
          return;
        case "close-terminal":
          handleMenuCommand("close-session");
          return;
        case "toggle-terminal":
          handleMenuCommand("toggle-terminal");
          return;
        case "next-tab":
          handleMenuCommand("next-tab");
          return;
        case "previous-tab":
          handleMenuCommand("previous-tab");
          return;
        case "command-palette":
          handleMenuCommand("command-palette");
          return;
        case "zoom-in":
        case "zoom-out": {
          const delta = action === "zoom-in" ? 1 : -1;
          const next = clampFontSize(terminalRuntimeConfig().fontSize + delta);
          configureTerminalRuntime({ fontSize: next });
          pool.setOptions({ fontSize: next });
          void useAppStore.getState().setTerminalPrefs({ fontSize: next });
          return;
        }
        case "zoom-reset": {
          configureTerminalRuntime({ fontSize: DEFAULT_TERMINAL_FONT_SIZE });
          pool.setOptions({ fontSize: DEFAULT_TERMINAL_FONT_SIZE });
          void useAppStore.getState().setTerminalPrefs({
            fontSize: DEFAULT_TERMINAL_FONT_SIZE,
          });
          return;
        }
      }
    },
    [pool],
  );

  // Attach the pooled xterm to this host and wire input/focus/resize. The pool
  // keeps the instance when the view unmounts, so this is a move, not a create.
  useEffect(() => {
    const terminalId = state?.terminalId;
    const host = hostRef.current;
    if (!terminalId || !host || !pool.has(terminalId)) return;
    pool.mount(terminalId, host);

    // A hidden pane or a minimized window has no layout box; FitAddon would
    // propose its 2x1 floor and resize the PTY to that. Wait for a real box.
    const fitHost = (): void => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
      const next = pool.fit(terminalId);
      if (next) store.getState().resize(tab.id, next.cols, next.rows);
    };
    fitHost();

    const term: PoolTerminal | undefined = pool.get(terminalId)?.term;
    if (!term) return;
    const unsubscribeData = term.onData((data) => store.getState().write(tab.id, data));
    const unsubscribeTitle = term.onTitleChange((next) => setTitle(next));
    const unsubscribeSelection = term.onSelectionChange(() => {
      if (!terminalRuntimeConfig().copyOnSelection) return;
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      // Copy after the selection settles; a drag fires this event repeatedly.
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null;
        const selection = term.getSelection();
        if (selection && navigator.clipboard) {
          void navigator.clipboard.writeText(selection).catch(() => undefined);
        }
      }, 100);
    });
    const unsubscribeBell = term.onBell(() => {
      if (!terminalRuntimeConfig().enableBell) return;
      setBell(true);
      if (bellTimer.current !== null) window.clearTimeout(bellTimer.current);
      bellTimer.current = window.setTimeout(() => {
        bellTimer.current = null;
        setBell(false);
      }, 150);
    });
    term.attachKeyHandler((event) => {
      const decision = terminalKeyDecision(event, {
        platform: terminalRuntimeConfig().platform,
        hasSelection: term.getSelection().length > 0,
        copyOnSelection: terminalRuntimeConfig().copyOnSelection,
      });
      if (decision.kind === "pty") return true;
      if (decision.kind === "app") void runAction(decision.action, terminalId);
      return false;
    });

    const onFocus = (): void => window.pi?.terminal.setFocus(true);
    const onBlur = (): void => window.pi?.terminal.setFocus(false);
    host.addEventListener("focusin", onFocus);
    host.addEventListener("focusout", onBlur);

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitHost);
    observer?.observe(host);
    term.focus();

    return () => {
      unsubscribeData();
      unsubscribeTitle();
      unsubscribeSelection();
      unsubscribeBell();
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      if (bellTimer.current !== null) window.clearTimeout(bellTimer.current);
      observer?.disconnect();
      host.removeEventListener("focusin", onFocus);
      host.removeEventListener("focusout", onBlur);
      pool.detach(terminalId);
      window.pi?.terminal.setFocus(false);
    };
  }, [state?.terminalId, tab.id, pool, store, runAction]);

  const retry = async (): Promise<void> => {
    await useAppStore.getState().openTrustPrompt(tab.cwd);
    const grant: TrustAnswer | undefined = useAppStore.getState().sessionTrust.includes(tab.cwd)
      ? "session"
      : undefined;
    await store
      .getState()
      .create(tab.id, tab.cwd, state?.cols ?? 80, state?.rows ?? 24, grant, tab.profileId);
  };

  const restart = async (): Promise<void> => {
    store.getState().removeTab(tab.id);
    const grant: TrustAnswer | undefined = useAppStore.getState().sessionTrust.includes(tab.cwd)
      ? "session"
      : undefined;
    await store
      .getState()
      .create(tab.id, tab.cwd, state?.cols ?? 80, state?.rows ?? 24, grant, tab.profileId);
  };

  const copyDetails = async (): Promise<void> => {
    const details = state?.errorDetails;
    if (!details) return;
    const copied = await copyText(`${state?.error ?? "The terminal could not start."}\n${details}`);
    if (!copied) return;
    setDetailsCopied(true);
    window.setTimeout(() => setDetailsCopied(false), 1500);
  };

  const search = (direction: "next" | "previous"): void => {
    const terminalId = state?.terminalId;
    if (!terminalId || query.length === 0) return;
    const term = pool.get(terminalId)?.term;
    if (!term) return;
    if (direction === "next") term.findNext(query);
    else term.findPrevious(query);
  };

  const status = state?.status ?? "idle";
  const terminalId = state?.terminalId ?? null;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-sunken",
        bell && "ring-1 ring-inset ring-accent",
      )}
      data-bell={bell ? "true" : undefined}
      data-testid="terminal-view"
    >
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[11px] text-ink-muted">
        <SquareTerminal className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <span className="max-w-48 truncate font-medium text-ink">{title || "Terminal"}</span>
        <span className="min-w-0 truncate">{tab.cwd}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const term = terminalId ? pool.get(terminalId)?.term : undefined;
              term?.clear();
            }}
          >
            Clear
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runAction("copy", terminalId ?? "")}
          >
            Copy
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runAction("paste", terminalId ?? "")}
          >
            Paste
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSearchOpen((open) => !open)}>
            Find
          </Button>
        </div>
      </div>

      {searchOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-3 py-1">
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value) search("next");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") search(event.shiftKey ? "previous" : "next");
              if (event.key === "Escape") setSearchOpen(false);
            }}
            placeholder="Find in terminal"
            className="h-6 min-w-0 flex-1 rounded-xs border border-line bg-canvas px-2 text-xs text-ink outline-none"
            aria-label="Find in terminal"
          />
          <Button size="sm" variant="ghost" onClick={() => search("previous")}>
            Previous
          </Button>
          <Button size="sm" variant="ghost" onClick={() => search("next")}>
            Next
          </Button>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={hostRef}
          data-testid="terminal-host"
          className="h-full min-h-0 w-full overflow-hidden"
        />
        {status === "needs-trust" ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-line bg-surface px-3 py-2 text-xs text-ink-muted">
            <span>This project is not trusted, so a shell was not started.</span>
            <Button size="sm" onClick={() => void retry()}>
              Trust project…
            </Button>
          </div>
        ) : null}
        {status === "exited" ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 border-t border-line bg-surface px-3 py-2 text-xs text-ink-muted">
            <span>
              Terminal exited
              {typeof state?.exitCode === "number" ? ` (code ${state.exitCode})` : ""}.
            </span>
            <Button size="sm" onClick={() => void restart()}>
              Restart
            </Button>
          </div>
        ) : null}
        {status === "failed" ? (
          <div className="absolute inset-x-0 bottom-0 border-t border-danger/40 bg-surface px-3 py-2 text-xs text-danger">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate" title={state?.error ?? undefined}>
                {state?.error ?? "The terminal could not start."}
              </span>
              <Button size="sm" onClick={() => void restart()}>
                Retry
              </Button>
            </div>
            {state?.errorDetails ? (
              <details className="mt-1 text-ink-muted">
                <summary className="cursor-pointer select-none">Details</summary>
                {/* The full native-loader report (per-candidate paths) lives here,
                    not in the one-line banner: a GLIBC dlopen error is long. */}
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xs bg-canvas p-2 text-xs text-ink-muted">
                  {state.errorDetails}
                </pre>
                <div className="mt-1 flex justify-end">
                  <Button size="sm" variant="ghost" onClick={() => void copyDetails()}>
                    {detailsCopied ? "Copied" : "Copy details"}
                  </Button>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
