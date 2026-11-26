import { useEffect } from "react";
import { Maximize2, Minimize2, Save, Wand2, WrapText } from "lucide-react";

import { effectiveEditorWidth, shouldWrap } from "../../../shared/editor-prefs";
import { isEditorTab, type TabRecord } from "../../../shared/session-ipc";
import { getBuffer } from "../editor/buffer-registry";
import { CodeMirrorEditor } from "../editor/CodeMirrorEditor";
import { useEditorStore } from "../editor/editor-store";
import { editorShortcut } from "../editor/shortcuts";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";

// The editor surface is deliberately free of app-store selectors beyond prefs.

/**
 * One file in the main area.
 *
 * The tab strip owns the tab; this view owns the document surface. It is
 * lazy-loaded by `TabSurface`, so CodeMirror is not in the startup bundle.
 */
export function EditorTabView({ tab }: { tab: TabRecord }): React.JSX.Element {
  const meta = useEditorStore((state) => state.meta[tab.id]);
  const save = useEditorStore((state) => state.save);
  const format = useEditorStore((state) => state.format);
  const checkExternal = useEditorStore((state) => state.checkExternalChange);
  // One selector for the whole block: the derived wrap/measure rules need the
  // enum, the width and the column together.
  const editorPrefs = useAppStore((state) => state.prefs.editor);
  const fontSize = editorPrefs.fontSize;
  const languageId = meta?.languageId ?? "plaintext";
  // Compact always wraps (see `shouldWrap`), so the measure and the wrap flag
  // are resolved from the same language + prefs pair. A per-tab override is
  // session-scoped (never written to prefs) and wins over that resolution.
  const wrapOverride = useEditorStore((state) => state.wrapOverride[tab.id]);
  const compactOverride = useEditorStore((state) => state.compactOverride[tab.id]);
  const setWrapOverride = useEditorStore((state) => state.setWrapOverride);
  const setCompactOverride = useEditorStore((state) => state.setCompactOverride);
  const effectiveWrap = wrapOverride ?? shouldWrap(languageId, editorPrefs);
  const compact = compactOverride ?? effectiveEditorWidth(languageId, editorPrefs) === "compact";
  // A grid can mount several editors; only the focused pane takes the caret.
  const activeTabId = useAppStore((state) => state.activeTabId);
  const buffer = getBuffer(tab.id);

  // Read the id once: the effect must key on the tab, never on the record's
  // object identity (main sends fresh copies on every tab-table publish).
  const tabId = tab.id;
  useEffect(() => {
    // A tab with metadata was loaded before: remounting it (switching away and
    // back) only needs the cheap stat, never another read of the file. A tab
    // created by main but never opened has no metadata and does need the read.
    const state = useEditorStore.getState();
    if (!state.meta[tabId]) void state.load(tabId);
    else void state.checkExternalChange(tabId);
  }, [tabId]);

  useEffect(() => {
    const timer = setInterval(() => void checkExternal(tab.id), 4_000);
    return () => clearInterval(timer);
  }, [tab.id, checkExternal]);

  if (!isEditorTab(tab)) return <p className="p-4 text-xs text-ink-muted">Not a file tab.</p>;

  const error = meta?.error ?? null;
  const canEdit = meta !== undefined && !meta.readOnly && !meta.binary;

  // CodeMirror's own keymap handles Ctrl/Cmd+S while the code surface has
  // focus and marks the event prevented. This container fallback covers the
  // toolbar buttons (and any non-CodeMirror part of the view) without becoming
  // a global accelerator, so Pi's selector/TUI Ctrl+S stays untouched.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const shortcut = editorShortcut(event);
    if (!shortcut) return;
    event.preventDefault();
    if (shortcut === "save") void save(tab.id);
    else if (shortcut === "format") void format(tab.id);
    else setWrapOverride(tab.id, !effectiveWrap);
  };

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="editor-tab-view"
      onKeyDown={onKeyDown}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted"
          title={tab.filePath}
        >
          {tab.filePath}
        </span>
        {meta?.loading && buffer ? (
          <span className="text-[10px] text-ink-faint" data-testid="editor-refreshing">
            Reloading…
          </span>
        ) : null}
        {meta?.dirty ? <span className="text-[11px] text-warn">Unsaved</span> : null}
        <span className="text-[10px] text-ink-faint">
          {meta?.languageId ?? ""}
          {meta ? ` · Ln ${meta.line}, Col ${meta.column}` : ""}
          {meta ? ` · ${meta.eol === "crlf" ? "CRLF" : "LF"}` : ""}
        </span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Wrap lines"
          aria-pressed={effectiveWrap}
          title="Wrap lines (Alt+Z)"
          onClick={() => setWrapOverride(tab.id, !effectiveWrap)}
          data-testid="editor-wrap"
        >
          <WrapText className="size-3" aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={compact ? "Use full width" : "Use compact width"}
          aria-pressed={compact}
          title={compact ? "Use full width" : "Use compact width"}
          onClick={() => setCompactOverride(tab.id, !compact)}
          data-testid="editor-width"
        >
          {compact ? (
            <Maximize2 className="size-3" aria-hidden />
          ) : (
            <Minimize2 className="size-3" aria-hidden />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2"
          disabled={!canEdit}
          title="Format Document (Shift+Alt+F)"
          onClick={() => void format(tab.id)}
          data-testid="editor-format"
        >
          <Wand2 className="size-3" aria-hidden /> Format
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2"
          disabled={!canEdit}
          title="Save (Ctrl+S)"
          onClick={() => void save(tab.id)}
          data-testid="editor-save"
        >
          <Save className="size-3" aria-hidden /> Save
        </Button>
      </div>

      {error ? (
        <p className="border-b border-line bg-warn/10 px-3 py-1 text-[11px] text-warn" role="alert">
          {error}
        </p>
      ) : null}
      {meta?.externalChange ? (
        <div className="flex items-center gap-2 border-b border-line bg-warn/10 px-3 py-1 text-[11px] text-warn">
          <span className="min-w-0 flex-1">File changed on disk.</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void useEditorStore.getState().reload(tab.id)}
          >
            Reload
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void save(tab.id, { force: true })}>
            Overwrite
          </Button>
        </div>
      ) : null}

      {meta?.loading && !buffer ? (
        <p className="p-4 text-xs text-ink-muted">Loading file…</p>
      ) : buffer ? (
        <div className="min-h-0 flex-1 bg-canvas">
          <CodeMirrorEditor
            tabId={tab.id}
            doc={buffer.text}
            languageId={languageId}
            readOnly={!canEdit}
            fontSize={fontSize}
            wordWrap={effectiveWrap}
            measure={compact ? "compact" : "full"}
            widthColumns={editorPrefs.widthColumns}
            tabSize={2}
            autoFocus={tab.id === activeTabId}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-xs text-ink-muted">
          {meta?.binary
            ? "Binary file. Reveal it in the file manager instead."
            : (meta?.error ?? "This file cannot be shown.")}
        </div>
      )}
    </div>
  );
}

// end of EditorTabView
