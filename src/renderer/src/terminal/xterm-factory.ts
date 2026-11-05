/**
 * The real xterm adapter (2026-11-05 native-terminal plan, step 9).
 *
 * `@xterm/xterm` is imported **here only**; the pool and the store stay behind
 * the small `PoolTerminal` surface, which is what lets their tests run in jsdom
 * without a canvas. The unused addons (`serialize`, `unicode11` when absent) are
 * loaded defensively so a missing optional capability degrades to the DOM
 * renderer instead of taking the tab down.
 */

import { Terminal, type ITheme } from "@xterm/xterm";
import { FALLBACK_TERMINAL_FONT_FAMILY } from "./terminal-font";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { PoolTerminal, TerminalFactory, TerminalPoolOptions } from "./terminal-pool";

export function createXtermFactory(): TerminalFactory {
  return {
    create(options: TerminalPoolOptions): PoolTerminal {
      const term = new Terminal({
        cols: options.cols,
        rows: options.rows,
        fontFamily: options.fontFamily ?? FALLBACK_TERMINAL_FONT_FAMILY,
        fontSize: options.fontSize,
        scrollback: options.scrollback,
        cursorStyle: options.cursorStyle,
        cursorBlink: options.cursorBlink,
        macOptionIsMeta: options.macOptionIsMeta,
        theme: options.theme as ITheme,
        allowProposedApi: true,
      });

      const container = document.createElement("div");
      container.className = "h-full w-full";
      term.open(container);

      const fit = new FitAddon();
      term.loadAddon(fit);
      const search = new SearchAddon();
      term.loadAddon(search);

      try {
        const unicode = new Unicode11Addon();
        term.loadAddon(unicode);
        term.unicode.activeVersion = "11";
      } catch {
        // A terminal that cannot activate the Unicode 11 width table still works.
      }
      try {
        term.loadAddon(
          new WebLinksAddon((_event, uri) => {
            // Only the schemes the app's openExternal accepts reach the OS.
            if (/^https?:\/\//i.test(uri)) void window.pi?.openExternal(uri);
          }),
        );
      } catch {
        // Links are optional.
      }
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL is unavailable (a VM or a software rasteriser): DOM renderer.
      }

      return {
        element: container,
        write: (bytes, callback) => term.write(bytes, callback),
        focus: () => term.focus(),
        dispose: () => term.dispose(),
        fit: () => {
          try {
            fit.fit();
          } catch {
            // A hidden/hostless terminal has no measurable size yet.
          }
          return { cols: term.cols, rows: term.rows };
        },
        getSelection: () => term.getSelection(),
        clearSelection: () => term.clearSelection(),
        selectAll: () => term.selectAll(),
        clear: () => term.clear(),
        findNext: (query, searchOptions) => search.findNext(query, searchOptions),
        findPrevious: (query, searchOptions) => search.findPrevious(query, searchOptions),
        setTheme: (theme) => {
          term.options.theme = theme as ITheme;
        },
        setOptions: (next) => {
          const fontChanged = next.fontFamily !== undefined || next.fontSize !== undefined;
          if (next.fontFamily !== undefined) term.options.fontFamily = next.fontFamily;
          if (next.fontSize !== undefined) term.options.fontSize = next.fontSize;
          if (next.scrollback !== undefined) term.options.scrollback = next.scrollback;
          if (next.cursorStyle !== undefined) term.options.cursorStyle = next.cursorStyle;
          if (next.cursorBlink !== undefined) term.options.cursorBlink = next.cursorBlink;
          if (next.macOptionIsMeta !== undefined) {
            term.options.macOptionIsMeta = next.macOptionIsMeta;
          }
          if (!fontChanged) return;
          try {
            fit.fit();
          } catch {
            // Ignore a hostless terminal.
          }
        },
        onData: (listener) => {
          const disposable = term.onData(listener);
          return () => disposable.dispose();
        },
        attachKeyHandler: (handler) => term.attachCustomKeyEventHandler(handler),
        paste: (text) => term.paste(text),
        onTitleChange: (listener) => {
          const disposable = term.onTitleChange(listener);
          return () => disposable.dispose();
        },
        onSelectionChange: (listener) => {
          const disposable = term.onSelectionChange(listener);
          return () => disposable.dispose();
        },
        onBell: (listener) => {
          const disposable = term.onBell(listener);
          return () => disposable.dispose();
        },
      };
    },
  };
}
