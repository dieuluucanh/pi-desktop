/**
 * DOM keyboard events → Pi key chords (plan step 15).
 *
 * Extension shortcuts are stored as Pi `KeyId` strings (`ctrl+g`, `shift+tab`,
 * `escape`). This module normalizes a `KeyboardEvent` into the same spelling so
 * the dispatcher can compare canonically (modifier order and base case do not
 * matter). Meta/Cmd combinations are never dispatched — they belong to the
 * Electron menu and the OS.
 */

import { canonicalKey } from "../../../shared/keybindings";

export interface DomKeyInput {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const NAMED_KEYS: Record<string, string> = {
  " ": "space",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  escape: "escape",
  enter: "enter",
  tab: "tab",
  backspace: "backspace",
  delete: "delete",
  home: "home",
  end: "end",
  pageup: "pageUp",
  pagedown: "pageDown",
};

/** Normalizes one key event to a Pi chord, or null when it must not dispatch. */
export function domKeyId(event: DomKeyInput): string | null {
  if (event.metaKey) return null;
  if (event.key === "Shift" || event.key === "Control" || event.key === "Alt") return null;
  const lowered = event.key.toLowerCase();
  const named = NAMED_KEYS[lowered] ?? NAMED_KEYS[event.key];
  let base: string;
  if (named) {
    base = named;
  } else if (event.key.length === 1) {
    base = event.key.toLowerCase();
  } else {
    return null;
  }
  const modifiers: string[] = [];
  if (event.altKey) modifiers.push("alt");
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.shiftKey && base.length > 1) modifiers.push("shift");
  // A shifted printable (e.g. "G") already carries shift in its case; naming it
  // again would double-count the modifier.
  if (event.shiftKey && base.length === 1 && event.key !== base) modifiers.push("shift");
  return [...modifiers.sort(), base].join("+");
}

/** True when the event is already claimed by text editing. */
export function isEditableTarget(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

/**
 * Finds the extension shortcut an event fires, comparing canonically so
 * `ctrl+shift+o` matches a registered `shift+ctrl+o`.
 */
export function matchShortcut(
  event: DomKeyInput,
  shortcuts: readonly { key: string }[],
): string | null {
  const pressed = domKeyId(event);
  if (!pressed) return null;
  const canonical = canonicalKey(pressed);
  for (const shortcut of shortcuts) {
    if (canonicalKey(shortcut.key) === canonical) return shortcut.key;
  }
  return null;
}
