/**
 * Settings → Terminal (2026-11-05 terminal follow-up plan, step 5).
 *
 * Two jobs in one card:
 * - the default shell profile and an optional custom executable, read from the
 *   same detected-profile snapshot main uses for spawning;
 * - the appearance prefs xterm already understands (font, cursor, scrollback,
 *   copy-on-selection, bell and macOS Option-as-Meta).
 *
 * Every write goes through `setTerminalPrefs`, which merges with the shared
 * sanitizer and resolves after main has applied the pref. That ordering matters
 * for the shell picker: a profile refresh must not re-detect against the previous
 * preference.
 */

import { useMemo, useState } from "react";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_SCROLLBACK,
  TERMINAL_CURSOR_STYLES,
  isAbsoluteTerminalPath,
  isTerminalFontFamily,
  type TerminalCursorStyle,
} from "../../../shared/terminal-prefs";
import { terminalFontFamilyFromDocument } from "../terminal/terminal-font";
import { useTerminalProfiles } from "../terminal/use-terminal-profiles";
import { useAppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
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

export function TerminalSettingsCard(): React.JSX.Element {
  const prefs = useAppStore((state) => state.prefs.terminal);
  const setTerminalPrefs = useAppStore((state) => state.setTerminalPrefs);
  const infoPlatform = useAppStore((state) => state.info?.platform);
  const { snapshot, loading, error, refresh } = useTerminalProfiles();

  const profiles = useMemo(
    () => (snapshot?.profiles ?? []).filter((profile) => profile.id !== "custom"),
    [snapshot],
  );
  const autoLabel = profiles[0]?.label ?? null;

  const committedChoice = prefs.shellPath
    ? "custom"
    : prefs.defaultProfile === "custom"
      ? "auto"
      : prefs.defaultProfile;
  const [choiceDraft, setChoiceDraft] = useState<Draft>({
    committed: committedChoice,
    text: committedChoice,
  });
  const choice = draftText(choiceDraft, committedChoice);

  const committedCustomPath = prefs.shellPath ?? "";
  const [customDraft, setCustomDraft] = useState<Draft>({
    committed: committedCustomPath,
    text: committedCustomPath,
  });
  const customPath = draftText(customDraft, committedCustomPath);
  const [customError, setCustomError] = useState<string | null>(null);

  const committedFontSize = String(prefs.fontSize);
  const [fontSizeDraft, setFontSizeDraft] = useState<Draft>({
    committed: committedFontSize,
    text: committedFontSize,
  });
  const fontSizeText = draftText(fontSizeDraft, committedFontSize);

  const committedFamily = prefs.fontFamily ?? "";
  const [familyDraft, setFamilyDraft] = useState<Draft>({
    committed: committedFamily,
    text: committedFamily,
  });
  const familyText = draftText(familyDraft, committedFamily);
  const [familyError, setFamilyError] = useState<string | null>(null);

  const committedScrollback = String(prefs.scrollback);
  const [scrollbackDraft, setScrollbackDraft] = useState<Draft>({
    committed: committedScrollback,
    text: committedScrollback,
  });
  const scrollbackText = draftText(scrollbackDraft, committedScrollback);

  const isMac =
    infoPlatform === "darwin" ||
    (infoPlatform === undefined &&
      typeof navigator !== "undefined" &&
      /Mac/i.test(navigator.platform));

  const setChoice = (text: string): void => setChoiceDraft({ committed: committedChoice, text });
  const setCustomPath = (text: string): void =>
    setCustomDraft({ committed: committedCustomPath, text });
  const setFontSizeText = (text: string): void =>
    setFontSizeDraft({ committed: committedFontSize, text });
  const setFamilyText = (text: string): void =>
    setFamilyDraft({ committed: committedFamily, text });
  const setScrollbackText = (text: string): void =>
    setScrollbackDraft({ committed: committedScrollback, text });

  const saveProfile = async (profileId: string): Promise<void> => {
    setChoice(profileId);
    setCustomError(null);
    await setTerminalPrefs({ defaultProfile: profileId, shellPath: null });
    await refresh(true);
  };

  const selectProfile = (value: string): void => {
    if (value === "custom") {
      setChoice(value);
      setCustomError(null);
      return;
    }
    void saveProfile(value);
  };

  const saveCustomPath = async (): Promise<void> => {
    const path = customPath.trim();
    if (!isAbsoluteTerminalPath(path)) {
      setCustomError("Enter an absolute path to a shell executable.");
      return;
    }
    setChoice("custom");
    const saved = await setTerminalPrefs({ defaultProfile: "custom", shellPath: path });
    if (saved.shellPath !== path) {
      setCustomError("That path was not accepted. Check it is absolute and not too long.");
      return;
    }
    setCustomError(null);
    await refresh(true);
  };

  const clearCustomPath = (): void => {
    setCustomPath("");
    setChoice("auto");
    setCustomError(null);
    void (async () => {
      await setTerminalPrefs({ defaultProfile: "auto", shellPath: null });
      await refresh(true);
    })();
  };

  const commitFontSize = (raw: string): void => {
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) {
      setFontSizeText(String(prefs.fontSize));
      return;
    }
    const next = clamp(value, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE);
    setFontSizeText(String(next));
    void setTerminalPrefs({ fontSize: next });
  };

  const stepFontSize = (delta: number): void => {
    commitFontSize(String(prefs.fontSize + delta));
  };

  const commitFamily = (): void => {
    const value = familyText.trim();
    if (value.length === 0) {
      setFamilyError(null);
      void setTerminalPrefs({ fontFamily: null });
      return;
    }
    if (!isTerminalFontFamily(value)) {
      setFamilyError("Use a single-line CSS font list without braces or semicolons.");
      return;
    }
    setFamilyError(null);
    void setTerminalPrefs({ fontFamily: value });
  };

  const commitScrollback = (raw: string): void => {
    const value = Number(raw.trim());
    if (!Number.isFinite(value)) {
      setScrollbackText(String(prefs.scrollback));
      return;
    }
    const next = clamp(value, MIN_TERMINAL_SCROLLBACK, MAX_TERMINAL_SCROLLBACK);
    setScrollbackText(String(next));
    void setTerminalPrefs({ scrollback: next });
  };

  const previewFamily = terminalFontFamilyFromDocument(prefs.fontFamily);
  const problems = snapshot?.problems ?? [];

  return (
    <section className="card flex flex-col gap-4" data-testid="settings-terminal">
      <div>
        <h2 className="text-sm font-semibold">Terminal</h2>
        <p className="text-xs text-ink-muted">
          App preferences for the integrated terminal. Its shell is separate from Pi&apos;s own
          <code className="mx-1 font-mono text-[11px]">shellPath</code>
          setting, which drives the agent&apos;s tools.
        </p>
      </div>

      <SettingsRow
        label="Default shell profile"
        hint="New terminal tabs use this shell. Existing tabs keep the shell they were opened with."
      >
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Default terminal profile"
            className={INPUT_CLASS}
            value={choice}
            onChange={(event) => selectProfile(event.target.value)}
          >
            <option value="auto">
              Auto{autoLabel ? ` — ${autoLabel}` : " (first detected shell)"}
            </option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
            {choice !== "auto" &&
            choice !== "custom" &&
            !profiles.some((profile) => profile.id === choice) ? (
              <option value={choice}>{choice} (not detected)</option>
            ) : null}
            <option value="custom">Custom shell path…</option>
          </select>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh(true)}>
            {loading ? "Detecting…" : "Refresh shells"}
          </Button>
        </div>
        {loading && !snapshot ? (
          <p className="text-xs text-ink-faint">Detecting installed shells…</p>
        ) : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}
        {problems.map((problem) => (
          <p key={problem} className="text-xs text-warn">
            {problem}
          </p>
        ))}
      </SettingsRow>

      {choice === "custom" ? (
        <SettingsRow
          label="Shell executable"
          hint="An absolute path to the executable. The Git Bash layouts get their login-shell arguments automatically."
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Custom shell executable"
              className={`${INPUT_CLASS} min-w-64 flex-1 font-mono`}
              value={customPath}
              placeholder="C:\Program Files\Git\bin\bash.exe"
              onChange={(event) => setCustomPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveCustomPath();
              }}
            />
            <Button size="sm" onClick={() => void saveCustomPath()}>
              Use this path
            </Button>
            <Button size="sm" variant="ghost" onClick={clearCustomPath}>
              Clear
            </Button>
          </div>
          {customError ? <p className="text-xs text-danger">{customError}</p> : null}
        </SettingsRow>
      ) : null}

      <SettingsRow
        label="Font size"
        hint="Ctrl/Cmd + = / - changes it from the terminal; Ctrl/Cmd + 0 resets it."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Decrease terminal font size"
            disabled={prefs.fontSize <= MIN_TERMINAL_FONT_SIZE}
            onClick={() => stepFontSize(-1)}
          >
            −
          </Button>
          <input
            type="number"
            aria-label="Terminal font size"
            className={`${INPUT_CLASS} w-20`}
            min={MIN_TERMINAL_FONT_SIZE}
            max={MAX_TERMINAL_FONT_SIZE}
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
            aria-label="Increase terminal font size"
            disabled={prefs.fontSize >= MAX_TERMINAL_FONT_SIZE}
            onClick={() => stepFontSize(1)}
          >
            +
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void setTerminalPrefs({ fontSize: DEFAULT_TERMINAL_FONT_SIZE })}
          >
            Reset to {DEFAULT_TERMINAL_FONT_SIZE}
          </Button>
          <span className="text-xs text-ink-faint">{prefs.fontSize}px</span>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Font family"
        hint="A CSS family list. Leave empty to use the app's monospace stack."
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Terminal font family"
            className={`${INPUT_CLASS} min-w-64 flex-1 font-mono`}
            value={familyText}
            placeholder={previewFamily}
            onChange={(event) => setFamilyText(event.target.value)}
            onBlur={commitFamily}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <Button size="sm" onClick={commitFamily}>
            Use this family
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFamilyText("");
              setFamilyError(null);
              void setTerminalPrefs({ fontFamily: null });
            }}
          >
            App default
          </Button>
        </div>
        {familyError ? <p className="text-xs text-danger">{familyError}</p> : null}
        <div
          data-testid="terminal-font-preview"
          className="rounded-sm border border-line bg-sunken px-3 py-2 text-ink"
          style={{ fontFamily: previewFamily, fontSize: `${prefs.fontSize}px`, lineHeight: 1.5 }}
        >
          <div>The quick brown fox jumps over the lazy dog.</div>
          <div>0123456789 → λ ✓</div>
        </div>
      </SettingsRow>

      <SettingsRow label="Cursor" hint="Applies to every open terminal immediately.">
        <div className="flex flex-wrap items-center gap-3">
          <select
            aria-label="Terminal cursor style"
            className={INPUT_CLASS}
            value={prefs.cursorStyle}
            onChange={(event) =>
              void setTerminalPrefs({
                cursorStyle: event.target.value as TerminalCursorStyle,
              })
            }
          >
            {TERMINAL_CURSOR_STYLES.map((style) => (
              <option key={style} value={style}>
                {style[0]?.toUpperCase()}
                {style.slice(1)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <Switch
              checked={prefs.cursorBlink}
              onCheckedChange={(cursorBlink) => void setTerminalPrefs({ cursorBlink })}
              aria-label="Blink the terminal cursor"
            />
            Blink
          </label>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Scrollback"
        hint="Lines kept for scrollback. Lower values save memory in a four-pane grid."
      >
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            aria-label="Terminal scrollback lines"
            className={`${INPUT_CLASS} w-28`}
            min={MIN_TERMINAL_SCROLLBACK}
            max={MAX_TERMINAL_SCROLLBACK}
            step={1000}
            value={scrollbackText}
            onChange={(event) => setScrollbackText(event.target.value)}
            onBlur={(event) => commitScrollback(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void setTerminalPrefs({ scrollback: DEFAULT_TERMINAL_SCROLLBACK })}
          >
            Reset
          </Button>
          <span className="text-xs text-ink-faint">{prefs.scrollback.toLocaleString()} lines</span>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Copy on selection"
        hint="Copy selected terminal text automatically once the selection settles."
      >
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.copyOnSelection}
            onCheckedChange={(copyOnSelection) => void setTerminalPrefs({ copyOnSelection })}
            aria-label="Copy terminal selection automatically"
          />
          <span className="text-xs text-ink-faint">{prefs.copyOnSelection ? "on" : "off"}</span>
        </div>
      </SettingsRow>

      <SettingsRow label="Visual bell" hint="Flash the terminal surface when a program sends BEL.">
        <div className="flex items-center gap-2">
          <Switch
            checked={prefs.enableBell}
            onCheckedChange={(enableBell) => void setTerminalPrefs({ enableBell })}
            aria-label="Flash the terminal on BEL"
          />
          <span className="text-xs text-ink-faint">{prefs.enableBell ? "flash" : "off"}</span>
        </div>
      </SettingsRow>

      {isMac ? (
        <SettingsRow
          label="Option as Meta"
          hint="Send Option as the Meta modifier so Alt+b/f reach the shell's readline."
        >
          <div className="flex items-center gap-2">
            <Switch
              checked={prefs.macOptionIsMeta}
              onCheckedChange={(macOptionIsMeta) => void setTerminalPrefs({ macOptionIsMeta })}
              aria-label="Treat Option as Meta"
            />
            <span className="text-xs text-ink-faint">{prefs.macOptionIsMeta ? "on" : "off"}</span>
          </div>
        </SettingsRow>
      ) : null}
    </section>
  );
}
