/**
 * Settings → Editor (2026-11-25 editor plan, step 12).
 *
 * The persisted defaults for the file editor: content font size, the wrap
 * vocabulary (`auto`/`always`/`never`), the width vocabulary
 * (`auto`/`full`/`compact`) and the compact column measure. Per-tab overrides
 * live in the editor toolbar and never write these preferences.
 *
 * Every write goes through `setEditorPrefs`, which merges with the shared
 * sanitizer, clamps the numeric fields and resolves after main has applied the
 * preference.
 */

import { useState } from "react";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  MAX_EDITOR_FONT_SIZE,
  MAX_EDITOR_WIDTH_COLUMNS,
  MIN_EDITOR_FONT_SIZE,
  MIN_EDITOR_WIDTH_COLUMNS,
  type EditorPrefs,
  type EditorWidth,
  type EditorWordWrap,
} from "../../../shared/editor-prefs";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { SettingsRow } from "./SettingsRow";

const INPUT_CLASS =
  "h-7 min-w-0 rounded-sm border border-line bg-canvas px-2 text-xs text-ink outline-none focus:border-accent";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** A draft keyed by the committed value, so a save elsewhere cannot clobber typing. */
interface Draft {
  committed: string;
  text: string;
}

function draftText(draft: Draft, committed: string): string {
  return draft.committed === committed ? draft.text : committed;
}

export function EditorSettingsCard(): React.JSX.Element {
  const prefs = useAppStore((state) => state.prefs.editor);
  const setEditorPrefs = useAppStore((state) => state.setEditorPrefs);

  const committedFontSize = String(prefs.fontSize);
  const [fontSizeDraft, setFontSizeDraft] = useState<Draft>({
    committed: committedFontSize,
    text: committedFontSize,
  });
  const fontSizeText = draftText(fontSizeDraft, committedFontSize);

  const committedColumns = String(prefs.widthColumns);
  const [columnsDraft, setColumnsDraft] = useState<Draft>({
    committed: committedColumns,
    text: committedColumns,
  });
  const columnsText = draftText(columnsDraft, committedColumns);

  const [error, setError] = useState<string | null>(null);

  const setFontSizeText = (text: string): void =>
    setFontSizeDraft({ committed: committedFontSize, text });
  const setColumnsText = (text: string): void =>
    setColumnsDraft({ committed: committedColumns, text });

  const save = (patch: Partial<EditorPrefs>): void => {
    setError(null);
    void setEditorPrefs(patch).catch(() => {
      setError("Could not save the editor preference. Try again.");
    });
  };

  const commitFontSize = (raw: string): void => {
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) {
      setFontSizeText(String(prefs.fontSize));
      return;
    }
    const next = clamp(value, MIN_EDITOR_FONT_SIZE, MAX_EDITOR_FONT_SIZE);
    setFontSizeText(String(next));
    save({ fontSize: next });
  };

  const commitColumns = (raw: string): void => {
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) {
      setColumnsText(String(prefs.widthColumns));
      return;
    }
    const next = clamp(value, MIN_EDITOR_WIDTH_COLUMNS, MAX_EDITOR_WIDTH_COLUMNS);
    setColumnsText(String(next));
    save({ widthColumns: next });
  };

  return (
    <section className="card flex flex-col gap-4" data-testid="settings-editor">
      <div>
        <h2 className="text-sm font-semibold">Editor</h2>
        <p className="text-xs text-ink-muted">
          Defaults for the file editor. A per-tab control in the editor toolbar can override wrap
          and width for the file you are reading.
        </p>
      </div>

      <SettingsRow label="Font size" hint="Content text size in the file editor.">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            aria-label="Editor font size"
            className={`${INPUT_CLASS} w-20`}
            min={MIN_EDITOR_FONT_SIZE}
            max={MAX_EDITOR_FONT_SIZE}
            value={fontSizeText}
            onChange={(event) => setFontSizeText(event.target.value)}
            onBlur={(event) => commitFontSize(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => save({ fontSize: DEFAULT_EDITOR_FONT_SIZE })}
          >
            Reset to {DEFAULT_EDITOR_FONT_SIZE}
          </Button>
          <span className="text-xs text-ink-faint">{prefs.fontSize}px</span>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Default wrap"
        hint="Auto wraps prose (Markdown, MDX and plain text) and leaves code unwrapped."
      >
        <select
          aria-label="Default word wrap"
          className={INPUT_CLASS}
          value={prefs.wordWrap}
          onChange={(event) => save({ wordWrap: event.target.value as EditorWordWrap })}
        >
          <option value="auto">Auto (prose)</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select>
      </SettingsRow>

      <SettingsRow
        label="Default width"
        hint="Auto uses the compact column for prose and the full pane for code."
      >
        <select
          aria-label="Default editor width"
          className={INPUT_CLASS}
          value={prefs.width}
          onChange={(event) => save({ width: event.target.value as EditorWidth })}
        >
          <option value="auto">Auto (prose)</option>
          <option value="full">Full</option>
          <option value="compact">Compact</option>
        </select>
      </SettingsRow>

      <SettingsRow label="Reading column" hint="The centred compact column, in characters.">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            aria-label="Reading column width"
            className={`${INPUT_CLASS} w-24`}
            min={MIN_EDITOR_WIDTH_COLUMNS}
            max={MAX_EDITOR_WIDTH_COLUMNS}
            value={columnsText}
            onChange={(event) => setColumnsText(event.target.value)}
            onBlur={(event) => commitColumns(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="text-xs text-ink-faint">{prefs.widthColumns} characters</span>
        </div>
        <p className="text-xs text-ink-faint">
          Compact wraps at the column, so it never shows a horizontal scrollbar. A per-tab toggle in
          the editor toolbar overrides both defaults.
        </p>
      </SettingsRow>

      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </section>
  );
}
