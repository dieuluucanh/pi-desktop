/**
 * The keyboard contract of an extension dialog (2026-11-18 dialog parity).
 *
 * Terminal Pi's `ExtensionSelectorComponent` owns input while it is shown:
 * `↑`/`↓` and `j`/`k` move the selection (clamped at the ends), Enter selects,
 * Escape/Ctrl+C cancel, and `Ctrl+O` still expands tools. Its text input/editor
 * dialogs only take Escape; everything else stays with the editor.
 *
 * The desktop attached those handlers to whichever DOM element had focus, so a
 * prompt whose focus stayed on the page ignored the keyboard. This module is the
 * single pure policy used by the dock and the select list, so the same keys work
 * whether focus is on an option, the dialog root or `document.body`.
 *
 * No React and no store access: `DialogKeyIntent` is a plain decision.
 */

import { resolveKeybindings } from "../../../shared/keybindings";
import { matchesBinding, type DomKeyInput } from "../shortcuts/dom-keys";

/** The `tui.select.*` bindings the dialog needs, already resolved to key lists. */
export interface SelectKeys {
  up: readonly string[];
  down: readonly string[];
  confirm: readonly string[];
  cancel: readonly string[];
}

const DEFAULTS = resolveKeybindings({});

function keysFor(id: keyof SelectKeys): readonly string[] {
  const defaults = DEFAULTS[`tui.select.${id}`];
  return defaults ? [...defaults] : [];
}

/** Pi's documented defaults, used until the renderer has loaded keybindings.json. */
export const DEFAULT_SELECT_KEYS: SelectKeys = {
  up: keysFor("up"),
  down: keysFor("down"),
  confirm: keysFor("confirm"),
  cancel: keysFor("cancel"),
};

function fromEffective(
  effective: Record<string, readonly string[]> | null | undefined,
  id: keyof SelectKeys,
): readonly string[] {
  const keys = effective?.[`tui.select.${id}`];
  return keys && keys.length > 0 ? keys : DEFAULT_SELECT_KEYS[id];
}

/** Resolves the effective `tui.select.*` snapshot, keeping defaults per missing id. */
export function selectKeysFrom(
  effective: Record<string, readonly string[]> | null | undefined,
): SelectKeys {
  return {
    up: fromEffective(effective, "up"),
    down: fromEffective(effective, "down"),
    confirm: fromEffective(effective, "confirm"),
    cancel: fromEffective(effective, "cancel"),
  };
}

export type DialogKeyIntent = "up" | "down" | "confirm" | "cancel" | null;

export interface DialogKeyContext {
  method: "select" | "confirm" | "input" | "editor";
  keys: SelectKeys;
  /** A non-collapsed document selection makes Ctrl+C a copy, not a cancel. */
  hasSelection?: boolean;
}

export interface DialogKeyEvent extends DomKeyInput {
  key: string;
  isComposing?: boolean;
}

function plainKey(event: DialogKeyEvent, key: string): boolean {
  return event.key === key && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

/**
 * Maps one key to the dialog action it should perform.
 *
 * Order mirrors terminal Pi: j/k and the configured up/down bindings win over a
 * remapped cancel binding, then select-confirm, then cancel. Escape always
 * cancels; Ctrl+C (or a remapped cancel key) cancels only when no text is
 * selected, so copying from a prompt still works.
 */
export function dialogKeyIntent(event: DialogKeyEvent, context: DialogKeyContext): DialogKeyIntent {
  if (event.isComposing) return null;

  if (context.method === "input" || context.method === "editor") {
    return event.key === "Escape" ? "cancel" : null;
  }

  if (event.key === "Escape") return "cancel";

  if (matchesBinding(event, context.keys.up) || plainKey(event, "k")) return "up";
  if (matchesBinding(event, context.keys.down) || plainKey(event, "j")) return "down";

  if (context.method === "select" && matchesBinding(event, context.keys.confirm)) {
    return "confirm";
  }

  if (matchesBinding(event, context.keys.cancel)) {
    return context.hasSelection === true ? null : "cancel";
  }

  return null;
}

/** Moves a selection by one row, clamped (terminal Pi does not wrap). */
export function moveSelection(index: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return 0;
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  return Math.min(length - 1, Math.max(0, safe + delta));
}

const OVERLAY_SELECTOR = '[role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"]';

function inside(own: Element | null, node: Element): boolean {
  return own !== null && own.contains(node);
}

/**
 * True when a key event belongs to another overlay (a Radix menu, the
 * notification panel, a modal), not to this dialog. The check covers both the
 * event target and the focused element, because a global listener sees keys
 * whose target is `document.body` while a popover still owns the focus.
 */
export function isForeignOverlayTarget(node: EventTarget | null, own: Element | null): boolean {
  const candidates: Element[] = [];
  if (node instanceof Element) candidates.push(node);
  if (typeof document !== "undefined" && document.activeElement instanceof Element) {
    candidates.push(document.activeElement);
  }
  for (const candidate of candidates) {
    if (inside(own, candidate)) continue;
    const overlay = candidate.closest(OVERLAY_SELECTOR);
    if (overlay && !inside(own, overlay)) return true;
  }
  return false;
}

/**
 * The one guard chain every dialog listener runs before interpreting a key.
 *
 * `own` is the dock root, so the dialog's own listbox/buttons are never
 * "foreign". A palette/help surface and an already-handled event win, and an
 * IME composition never becomes a command.
 */
export function dialogKeyAllowed(
  event: KeyboardEvent,
  own: Element | null,
  state: { paletteOpen: boolean; shortcutsHelpOpen: boolean },
): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (state.paletteOpen || state.shortcutsHelpOpen) return false;
  return !isForeignOverlayTarget(event.target, own);
}
