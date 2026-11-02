/**
 * The desktop keymap (2026-10-26 session-parity plan steps 22–24).
 *
 * Two registries, one rule each (D14):
 *
 *  - **Pi actions** (`app.message.copy`, `app.editor.external`, `app.tools.expand`,
 *    `app.message.followUp`, …) live in `keybindings.json` only. The dispatcher
 *    resolves them from `keybindings.effective`, so a Pi remap takes effect here
 *    without a second copy.
 *  - **Desktop actions** (tabs, palette, sessions, settings, updates) are app
 *    preferences: `UiPrefs.desktopKeybindings`. They have their own scope so a
 *    composer chord and a global chord never fight.
 *
 * Menu accelerators are Electron strings (`CmdOrCtrl+N`) with a different
 * grammar; they are restricted to `global`/`menu` actions because an accelerator
 * fires before the renderer and would swallow a composer key (D14).
 *
 * The conflict model mirrors `detectKeybindingConflicts`/`userKeybindingConflicts`:
 * chords are compared inside scopes that can be active at once, and Pi's own
 * cross-modal duplicates are informational, not warnings.
 */

import { canonicalKey } from "./keybindings";
import type { MenuCommand } from "./ipc";

export type DesktopScope = "global" | "menu" | "session" | "composer";

export type DesktopActionId =
  | "session.new"
  | "session.close"
  | "session.nextTab"
  | "session.previousTab"
  | "palette.open"
  | "sessions.open"
  | "settings.open"
  | "updates.check"
  | "sidebar.toggle"
  | "transcript.find";

export interface DesktopActionDefinition {
  id: DesktopActionId;
  label: string;
  /** The context the chord is honoured in (see the module comment). */
  scope: DesktopScope;
  /** Pi-spelled chords (`ctrl+shift+tab`). Empty means "unbound". */
  defaults: readonly string[];
  /**
   * Whether the action is also an Electron menu item. Only `global`/`menu`
   * actions may be, because a menu accelerator fires before the renderer.
   */
  menu: boolean;
}

export const DESKTOP_ACTIONS: readonly DesktopActionDefinition[] = [
  {
    id: "session.new",
    label: "New session",
    scope: "menu",
    defaults: ["ctrl+n"],
    menu: true,
  },
  {
    id: "session.close",
    label: "Close session",
    scope: "menu",
    defaults: ["ctrl+w"],
    menu: true,
  },
  {
    id: "session.nextTab",
    label: "Next tab",
    scope: "menu",
    defaults: ["ctrl+tab"],
    menu: true,
  },
  {
    id: "session.previousTab",
    label: "Previous tab",
    scope: "menu",
    defaults: ["ctrl+shift+tab"],
    menu: true,
  },
  {
    id: "palette.open",
    label: "Command palette",
    scope: "menu",
    defaults: ["ctrl+k"],
    menu: true,
  },
  {
    id: "sessions.open",
    label: "Session browser",
    scope: "menu",
    defaults: ["ctrl+alt+o"],
    menu: true,
  },
  {
    id: "settings.open",
    label: "Settings",
    scope: "menu",
    defaults: ["ctrl+,"],
    menu: true,
  },
  {
    id: "updates.check",
    label: "Check for updates",
    scope: "menu",
    defaults: [],
    menu: true,
  },
  {
    id: "sidebar.toggle",
    label: "Toggle sidebar",
    scope: "menu",
    defaults: ["ctrl+b"],
    menu: true,
  },
  {
    id: "transcript.find",
    label: "Find in transcript",
    scope: "session",
    defaults: ["ctrl+f"],
    menu: false,
  },
];

export type DesktopKeybindings = Partial<Record<DesktopActionId, readonly string[]>>;

export const MAX_DESKTOP_CHORDS = 3;
const MAX_CHORD_LENGTH = 40;

/** Valid desktop chords: a Pi chord that does not use `meta`/`cmd`. */
export function validDesktopChord(chord: string): boolean {
  if (typeof chord !== "string" || chord.length === 0 || chord.length > MAX_CHORD_LENGTH) {
    return false;
  }
  if (/\b(meta|cmd|command|super)\b/i.test(chord)) return false;
  return /^[a-z0-9+,\-./;[\]'`=*]+$/i.test(chord);
}

/** Keeps only known actions and valid, bounded chords; duplicates are dropped. */
export function sanitizeDesktopKeybindings(input: unknown): Record<string, readonly string[]> {
  if (!input || typeof input !== "object") return {};
  const known = new Set(DESKTOP_ACTIONS.map((action) => action.id));
  const out: Record<string, readonly string[]> = {};
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (!known.has(id as DesktopActionId)) continue;
    if (!Array.isArray(value)) continue;
    const chords: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") continue;
      const chord = canonicalKey(entry.trim());
      if (!validDesktopChord(chord)) continue;
      if (chords.includes(chord)) continue;
      chords.push(chord);
      if (chords.length >= MAX_DESKTOP_CHORDS) break;
    }
    out[id] = chords;
  }
  return out;
}

/**
 * The effective chords per action: a user override wins, including an explicit
 * empty list (unbound).
 */
export function resolveDesktopKeymap(
  overrides: DesktopKeybindings | undefined,
): Record<DesktopActionId, readonly string[]> {
  const out = {} as Record<DesktopActionId, readonly string[]>;
  for (const action of DESKTOP_ACTIONS) {
    const override = overrides?.[action.id];
    out[action.id] = override ? [...override] : [...action.defaults];
  }
  return out;
}

/** True when the action may appear in the Electron menu. */
export function isMenuAcceleratorAction(id: DesktopActionId): boolean {
  const action = desktopActionOf(id);
  return (
    action !== undefined && action.menu && (action.scope === "menu" || action.scope === "global")
  );
}

export function desktopActionOf(id: string): DesktopActionDefinition | undefined {
  return DESKTOP_ACTIONS.find((action) => action.id === id);
}

// ---------------------------------------------------------------------------
// Menu accelerator grammar
// ---------------------------------------------------------------------------

export interface MenuAccelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/**
 * Parses Electron's accelerator grammar (`CmdOrCtrl+Shift+O`). Returns null for
 * anything it cannot round-trip, so a hand-edited pref cannot produce a menu
 * item whose accelerator silently differs from the label.
 */
export function parseMenuAccelerator(value: string): MenuAccelerator | null {
  const parts = value.split("+").map((part) => part.trim());
  const key = parts.pop();
  if (!key || key.length === 0) return null;
  const accelerator: MenuAccelerator = { ctrl: false, alt: false, shift: false, key };
  for (const part of parts) {
    const lowered = part.toLowerCase();
    if (lowered === "cmdorctrl" || lowered === "ctrl" || lowered === "control")
      accelerator.ctrl = true;
    else if (lowered === "alt" || lowered === "option") accelerator.alt = true;
    else if (lowered === "shift") accelerator.shift = true;
    else if (lowered === "cmd" || lowered === "command" || lowered === "meta")
      accelerator.ctrl = true;
    else return null;
  }
  return accelerator;
}

/** The Pi chord an accelerator is equivalent to (`ctrl+shift+o`). */
export function acceleratorToChord(value: string): string | null {
  const accelerator = parseMenuAccelerator(value);
  if (!accelerator) return null;
  const modifiers: string[] = [];
  if (accelerator.alt) modifiers.push("alt");
  if (accelerator.ctrl) modifiers.push("ctrl");
  const base = accelerator.key.toLowerCase();
  if (accelerator.shift) modifiers.push("shift");
  return canonicalKey([...modifiers, base].join("+"));
}

/** `ctrl+shift+o` → `CmdOrCtrl+Shift+O` (menu grammar), or null. */
export function chordToAccelerator(chord: string): string | null {
  const parsed = canonicalKey(chord).split("+");
  const key = parsed.pop();
  if (!key) return null;
  const parts: string[] = [];
  if (parsed.includes("ctrl")) parts.push("CmdOrCtrl");
  if (parsed.includes("alt")) parts.push("Alt");
  if (parsed.includes("shift")) parts.push("Shift");
  parts.push(key.length === 1 ? key.toUpperCase() : key[0]?.toUpperCase() + key.slice(1));
  return parts.join("+");
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

export interface DesktopConflict {
  chord: string;
  /** Which two owners collide. */
  left: string;
  right: string;
  /** `warning` for a real collision, `info` for Pi's own cross-modal overlap. */
  severity: "warning" | "info";
}

interface ChordOwner {
  id: string;
  scope: DesktopScope | "pi" | "extension";
  chords: readonly string[];
}

/**
 * Two chords collide when they are equal and their scopes can be active at the
 * same time. `global`/`menu` overlap with everything (a menu accelerator fires
 * first); `composer` and `session` are mutually exclusive with each other.
 */
function scopesCollide(left: ChordOwner["scope"], right: ChordOwner["scope"]): boolean {
  if (left === right) return true;
  // A menu accelerator fires before the renderer, so it overlaps everything.
  const menus = new Set<ChordOwner["scope"]>(["global", "menu"]);
  if (menus.has(left) || menus.has(right)) return true;
  // An extension shortcut is registered in the editor, so it shares the
  // composer/session keyboard with those actions.
  const editor = new Set<ChordOwner["scope"]>(["composer", "session", "extension"]);
  return editor.has(left) && editor.has(right);
}

/**
 * Compares the desktop keymap with Pi's effective bindings (and live extension
 * shortcuts). A collision between two Pi defaults is informational: Pi's table
 * intentionally overlaps across modal contexts.
 */
export function detectDesktopConflicts(input: {
  desktop: Record<DesktopActionId, readonly string[]>;
  pi?: Record<string, readonly string[]>;
  extensions?: ReadonlyArray<{ key: string; description?: string }>;
}): DesktopConflict[] {
  const owners: ChordOwner[] = [];
  for (const action of DESKTOP_ACTIONS) {
    const chords = input.desktop[action.id] ?? [];
    if (chords.length > 0) owners.push({ id: action.id, scope: action.scope, chords });
  }
  for (const [id, chords] of Object.entries(input.pi ?? {})) {
    if (chords.length > 0) owners.push({ id, scope: "pi", chords });
  }
  for (const shortcut of input.extensions ?? []) {
    owners.push({
      id: `extension:${shortcut.description ?? shortcut.key}`,
      scope: "extension",
      chords: [shortcut.key],
    });
  }

  const conflicts: DesktopConflict[] = [];
  const seen = new Set<string>();
  for (const left of owners) {
    for (const right of owners) {
      if (left === right) continue;
      if (!scopesCollide(left.scope, right.scope)) continue;
      for (const chord of left.chords) {
        if (!right.chords.some((other) => canonicalKey(other) === canonicalKey(chord))) continue;
        const [a, b] = left.id < right.id ? [left, right] : [right, left];
        const key = `${a.id}|${b.id}|${canonicalKey(chord)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const piPair = a.scope === "pi" && b.scope === "pi";
        conflicts.push({
          chord: canonicalKey(chord),
          left: a.id,
          right: b.id,
          severity: piPair ? "info" : "warning",
        });
      }
    }
  }
  return conflicts;
}

/** The accelerator for a menu action, or null when it is unbound/invalid. */
export function menuAcceleratorFor(
  id: DesktopActionId,
  desktop: Record<DesktopActionId, readonly string[]>,
): string | null {
  if (!isMenuAcceleratorAction(id)) return null;
  const chord = desktop[id]?.[0];
  return chord ? chordToAccelerator(chord) : null;
}

/**
 * The mapping from desktop actions to the Electron menu items they own. Keeping
 * it here means the registry is the single source for the menu accelerators
 * (plan step 23) — `menu.ts` only falls back to its literal for an unowned item.
 */
export const MENU_COMMAND_ACTIONS: Partial<Record<MenuCommand, DesktopActionId>> = {
  "new-session": "session.new",
  "close-session": "session.close",
  "view-sessions": "sessions.open",
  "view-settings": "settings.open",
  "command-palette": "palette.open",
  "toggle-sidebar": "sidebar.toggle",
  "next-tab": "session.nextTab",
  "previous-tab": "session.previousTab",
  "check-updates": "updates.check",
};

/** Accelerators for every mapped menu command (null = deliberately unbound). */
export function menuAcceleratorsFor(
  desktop: Record<DesktopActionId, readonly string[]>,
): Partial<Record<MenuCommand, string | null>> {
  const out: Partial<Record<MenuCommand, string | null>> = {};
  for (const [command, actionId] of Object.entries(MENU_COMMAND_ACTIONS)) {
    if (!actionId) continue;
    const chord = desktop[actionId]?.[0];
    out[command as MenuCommand] = chord ? chordToAccelerator(chord) : null;
  }
  return out;
}
