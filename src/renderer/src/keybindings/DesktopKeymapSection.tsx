import { useMemo, useState } from "react";
import {
  DESKTOP_ACTIONS,
  chordToAccelerator,
  desktopActionOf,
  detectDesktopConflicts,
  resolveDesktopKeymap,
  sanitizeDesktopKeybindings,
  type DesktopActionId,
} from "../../../shared/desktop-keymap";
import { canonicalKey } from "../../../shared/keybindings";
import { domKeyId } from "../shortcuts/dom-keys";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";

/**
 * Desktop keymap editor (2026-10-26 session-parity plan steps 22–24).
 *
 * Pi's own actions stay in `keybindings.json` (the section above); this edits
 * **only** the app's actions (tabs, palette, sessions, settings, updates, find)
 * in `UiPrefs.desktopKeybindings`. One click starts capturing a chord, Backspace
 * removes the last one, Escape cancels, and a collision against another desktop
 * action, a Pi action or a live extension shortcut is called out per runtime
 * scope (Pi's own cross-modal defaults are informational, not warnings).
 */
export function DesktopKeymapSection() {
  const prefs = useAppStore((state) => state.prefs);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const keybindings = useAppStore((state) => state.keybindings);
  const shortcuts = useAppStore((state) => state.shortcuts);
  const [capturing, setCapturing] = useState<DesktopActionId | null>(null);
  const [query, setQuery] = useState("");

  const keymap = useMemo(
    () => resolveDesktopKeymap(prefs.desktopKeybindings),
    [prefs.desktopKeybindings],
  );

  const conflicts = useMemo(
    () =>
      detectDesktopConflicts({
        desktop: keymap,
        pi: keybindings?.effective ?? {},
        extensions: shortcuts.shortcuts,
      }),
    [keymap, keybindings?.effective, shortcuts.shortcuts],
  );

  const conflictIds = useMemo(() => {
    const ids = new Set<DesktopActionId>();
    for (const conflict of conflicts) {
      if (conflict.severity !== "warning") continue;
      const left = desktopActionOf(conflict.left);
      const right = desktopActionOf(conflict.right);
      if (left) ids.add(left.id);
      if (right) ids.add(right.id);
    }
    return ids;
  }, [conflicts]);

  const actions = DESKTOP_ACTIONS.filter((action) => {
    const needle = query.trim().toLowerCase();
    return needle.length === 0 || `${action.id} ${action.label}`.toLowerCase().includes(needle);
  });

  /** Persists only rows that differ from the defaults (overrides only). */
  const writeAction = (id: DesktopActionId, chords: readonly string[]): void => {
    const defaults = desktopActionOf(id)?.defaults ?? [];
    const next = sanitizeDesktopKeybindings({ ...prefs.desktopKeybindings, [id]: chords });
    const same =
      chords.length === defaults.length &&
      chords.every((chord, index) => chord === defaults[index]);
    if (same) delete next[id];
    setPrefs({ desktopKeybindings: next });
  };

  const capture = (id: DesktopActionId, event: React.KeyboardEvent<HTMLButtonElement>): void => {
    event.preventDefault();
    if (event.key === "Escape") {
      setCapturing(null);
      return;
    }
    if (event.key === "Backspace") {
      const current = keymap[id] ?? [];
      writeAction(id, current.slice(0, -1));
      return;
    }
    const chord = domKeyId({
      key: event.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
    // `meta` belongs to the OS/menu grammar; the desktop keymap uses Pi chords.
    if (!chord) return;
    const current = keymap[id] ?? [];
    const normalized = canonicalKey(chord);
    if (current.includes(normalized)) return;
    writeAction(id, [...current, normalized]);
    setCapturing(null);
  };

  return (
    <section className="card flex flex-col gap-2" data-testid="desktop-keymap">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Desktop shortcuts</h2>
          <p className="text-xs text-ink-muted">
            Actions the app owns (tabs, palette, sessions, updates). Pi's own keys stay in{" "}
            <code className="font-mono">keybindings.json</code> above.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPrefs({ desktopKeybindings: {} })}
          disabled={Object.keys(prefs.desktopKeybindings).length === 0}
        >
          Reset to defaults
        </Button>
      </div>

      <label className="flex items-center gap-2 rounded-sm border border-line px-2 py-1">
        <input
          aria-label="Search desktop shortcuts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a desktop action…"
          className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
      </label>

      <ul className="flex flex-col divide-y divide-line">
        {actions.map((action) => {
          const chords = keymap[action.id] ?? [];
          const menuAccelerator = action.menu ? chordToAccelerator(chords[0] ?? "") : null;
          const collides = conflictIds.has(action.id);
          return (
            <li
              key={action.id}
              className="flex flex-wrap items-center gap-2 py-1.5 text-xs"
              data-testid="desktop-keymap-row"
            >
              <span className="min-w-40 flex-1">
                {action.label}
                <span className="ml-2 text-[10px] text-ink-faint">{action.scope}</span>
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {chords.length === 0 ? (
                  <span className="text-[11px] text-ink-faint">unbound</span>
                ) : (
                  chords.map((chord) => (
                    <button
                      key={chord}
                      type="button"
                      title="Remove this chord"
                      onClick={() =>
                        writeAction(
                          action.id,
                          chords.filter((entry) => entry !== chord),
                        )
                      }
                    >
                      <Kbd>{chord}</Kbd>
                    </button>
                  ))
                )}
              </span>
              {menuAccelerator ? (
                <Badge tone="neutral" title="Electron menu accelerator">
                  menu: {menuAccelerator}
                </Badge>
              ) : null}
              {collides ? <Badge tone="warn">conflict</Badge> : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setCapturing(capturing === action.id ? null : action.id)}
              >
                {capturing === action.id ? "Press a key…" : "Change"}
              </Button>
              {capturing === action.id ? (
                <button
                  type="button"
                  autoFocus
                  aria-label={`Capture a shortcut for ${action.label}`}
                  className="rounded-sm border border-accent px-2 py-0.5 text-[11px] text-accent"
                  onKeyDown={(event) => capture(action.id, event)}
                  onBlur={() => setCapturing(null)}
                >
                  press a chord
                </button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => writeAction(action.id, action.defaults)}
                disabled={chords.join(",") === action.defaults.join(",")}
              >
                Reset
              </Button>
            </li>
          );
        })}
      </ul>

      {conflicts.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[11px]">
          {conflicts.map((conflict) => (
            <li
              key={`${conflict.left}:${conflict.right}:${conflict.chord}`}
              className={conflict.severity === "warning" ? "text-warn" : "text-ink-faint"}
            >
              {conflict.chord}: {conflict.left} ↔ {conflict.right}
              {conflict.severity === "info" ? " (Pi's own cross-mode default)" : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
