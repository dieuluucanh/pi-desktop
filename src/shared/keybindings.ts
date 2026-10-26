/**
 * Keybindings shared model (plan step 15).
 *
 * Pi documents every remappable action as a namespaced id (`tui.editor.*`,
 * `tui.input.*`, `tui.select.*`, `tui.altScreen.*`, `app.*`) with default keys
 * and a description. That table lives here — extracted from the SDK's own
 * `KEYBINDINGS` documentation — so the host can validate `keybindings.json`,
 * the renderer can render it grouped by namespace, and a test can pin the table
 * against the SDK (deep imports are blocked by the SDK's `exports` map, so the
 * table is a checked-in copy with a drift test, the same pattern as the Office
 * bridge pin).
 *
 * Everything here is pure: no SDK import, no DOM, no filesystem.
 */

export interface KeybindingDefinition {
  /** Namespaced id, e.g. `app.model.cycleForward`. */
  id: string;
  /** Default keys from Pi's documentation (empty when unbound by default). */
  defaults: string[];
  description: string;
}

/**
 * The documented keybinding table, extracted from
 * `@earendil-works/pi-coding-agent@1.4.0` `dist/core/keybindings.d.ts`
 * (`KEYBINDINGS`). `tests/shared/keybindings.test.ts` asserts the id set still
 * matches the SDK, so an upstream rename or addition turns into a failing test
 * instead of a silently unvalidated key.
 */
export const KEYBINDING_DEFINITIONS: readonly KeybindingDefinition[] = [
  { id: "tui.editor.cursorUp", defaults: ["up"], description: "Move cursor up" },
  { id: "tui.editor.cursorDown", defaults: ["down"], description: "Move cursor down" },
  {
    id: "tui.editor.historyPrevious",
    defaults: [],
    description: "Select previous prompt history entry",
  },
  { id: "tui.editor.historyNext", defaults: [], description: "Select next prompt history entry" },
  { id: "tui.editor.cursorLeft", defaults: ["left", "ctrl+b"], description: "Move cursor left" },
  { id: "tui.editor.cursorRight", defaults: ["right", "ctrl+f"], description: "Move cursor right" },
  {
    id: "tui.editor.cursorWordLeft",
    defaults: ["alt+left", "ctrl+left", "alt+b"],
    description: "Move cursor word left",
  },
  {
    id: "tui.editor.cursorWordRight",
    defaults: ["alt+right", "ctrl+right", "alt+f"],
    description: "Move cursor word right",
  },
  {
    id: "tui.editor.cursorLineStart",
    defaults: ["home", "ctrl+home", "ctrl+a"],
    description: "Move to line start",
  },
  {
    id: "tui.editor.cursorLineEnd",
    defaults: ["end", "ctrl+end", "ctrl+e"],
    description: "Move to line end",
  },
  { id: "tui.editor.jumpForward", defaults: ["ctrl+]"], description: "Jump forward to character" },
  {
    id: "tui.editor.jumpBackward",
    defaults: ["ctrl+alt+]"],
    description: "Jump backward to character",
  },
  { id: "tui.editor.pageUp", defaults: ["pageUp", "ctrl+pageUp"], description: "Page up" },
  { id: "tui.editor.pageDown", defaults: ["pageDown", "ctrl+pageDown"], description: "Page down" },
  {
    id: "tui.editor.deleteCharBackward",
    defaults: ["backspace"],
    description: "Delete character backward",
  },
  {
    id: "tui.editor.deleteCharForward",
    defaults: ["delete", "ctrl+d"],
    description: "Delete character forward",
  },
  {
    id: "tui.editor.deleteWordBackward",
    defaults: ["ctrl+w", "alt+backspace"],
    description: "Delete word backward",
  },
  {
    id: "tui.editor.deleteWordForward",
    defaults: ["alt+d", "alt+delete"],
    description: "Delete word forward",
  },
  { id: "tui.editor.deleteToLineStart", defaults: ["ctrl+u"], description: "Delete to line start" },
  { id: "tui.editor.deleteToLineEnd", defaults: ["ctrl+k"], description: "Delete to line end" },
  { id: "tui.editor.yank", defaults: ["ctrl+y"], description: "Yank" },
  { id: "tui.editor.yankPop", defaults: ["alt+y"], description: "Yank pop" },
  { id: "tui.input.newLine", defaults: ["shift+enter", "ctrl+j"], description: "Insert newline" },
  { id: "tui.input.submit", defaults: ["enter"], description: "Submit input" },
  { id: "tui.input.tab", defaults: ["tab"], description: "Tab / autocomplete" },
  { id: "tui.input.copy", defaults: ["ctrl+c"], description: "Copy selection" },
  { id: "tui.select.up", defaults: ["up"], description: "Move selection up" },
  { id: "tui.select.down", defaults: ["down"], description: "Move selection down" },
  { id: "tui.select.pageUp", defaults: ["pageUp"], description: "Selection page up" },
  { id: "tui.select.pageDown", defaults: ["pageDown"], description: "Selection page down" },
  { id: "tui.select.confirm", defaults: ["enter"], description: "Confirm selection" },
  { id: "tui.select.cancel", defaults: ["escape", "ctrl+c"], description: "Cancel selection" },
  { id: "tui.altScreen.pageUp", defaults: ["pageUp"], description: "Scroll viewport up one page" },
  {
    id: "tui.altScreen.pageDown",
    defaults: ["pageDown"],
    description: "Scroll viewport down one page",
  },
  { id: "tui.altScreen.halfPageUp", defaults: [], description: "Scroll viewport up half a page" },
  {
    id: "tui.altScreen.halfPageDown",
    defaults: [],
    description: "Scroll viewport down half a page",
  },
  { id: "tui.altScreen.lineUp", defaults: [], description: "Scroll viewport up one line" },
  { id: "tui.altScreen.lineDown", defaults: [], description: "Scroll viewport down one line" },
  {
    id: "tui.altScreen.searchNext",
    defaults: ["enter", "ctrl+g"],
    description: "Select the next search match",
  },
  {
    id: "tui.altScreen.searchPrevious",
    defaults: ["shift+enter", "ctrl+shift+g"],
    description: "Select the previous search match",
  },
  { id: "tui.altScreen.searchClose", defaults: ["escape"], description: "Close transcript search" },
  { id: "tui.altScreen.top", defaults: ["home"], description: "Scroll viewport to top" },
  { id: "tui.altScreen.bottom", defaults: ["end"], description: "Scroll viewport to bottom" },
  { id: "app.interrupt", defaults: ["escape"], description: "Cancel or abort" },
  { id: "app.clear", defaults: ["ctrl+c"], description: "Clear editor" },
  { id: "app.exit", defaults: ["ctrl+d"], description: "Exit when editor is empty" },
  { id: "app.suspend", defaults: ["ctrl+z"], description: "Suspend to background" },
  { id: "app.thinking.cycle", defaults: ["shift+tab"], description: "Cycle thinking level" },
  { id: "app.thinking.save", defaults: ["ctrl+s"], description: "Save thinking level" },
  { id: "app.model.cycleForward", defaults: ["ctrl+p"], description: "Cycle to next model" },
  {
    id: "app.model.cycleBackward",
    defaults: ["alt+p", "shift+ctrl+p"],
    description: "Cycle to previous model",
  },
  { id: "app.model.select", defaults: ["ctrl+l"], description: "Open model selector" },
  { id: "app.tools.expand", defaults: ["ctrl+o"], description: "Toggle tool output" },
  { id: "app.thinking.toggle", defaults: ["ctrl+t"], description: "Toggle thinking blocks" },
  {
    id: "app.session.toggleNamedFilter",
    defaults: ["ctrl+n"],
    description: "Toggle named session filter",
  },
  { id: "app.editor.external", defaults: ["ctrl+g"], description: "Open external editor" },
  { id: "app.message.copy", defaults: ["ctrl+x"], description: "Copy message to clipboard" },
  {
    id: "app.message.followUp",
    defaults: ["alt+enter", "ctrl+q"],
    description: "Queue follow-up message",
  },
  {
    id: "app.message.dequeue",
    defaults: ["alt+q", "alt+up"],
    description: "Restore queued messages",
  },
  {
    id: "app.clipboard.pasteImage",
    defaults: ["alt+v", "ctrl+v"],
    description: "Paste image from clipboard (text fallback)",
  },
  { id: "app.session.new", defaults: [], description: "Start a new session" },
  { id: "app.session.tree", defaults: [], description: "Open session tree" },
  { id: "app.session.fork", defaults: [], description: "Fork current session" },
  { id: "app.session.resume", defaults: [], description: "Resume a session" },
  {
    id: "app.tree.foldOrUp",
    defaults: ["alt+left", "ctrl+left"],
    description: "Fold tree branch or move up",
  },
  {
    id: "app.tree.unfoldOrDown",
    defaults: ["alt+right", "ctrl+right"],
    description: "Unfold tree branch or move down",
  },
  { id: "app.tree.editLabel", defaults: ["shift+l"], description: "Edit tree label" },
  {
    id: "app.tree.toggleLabelTimestamp",
    defaults: ["shift+t"],
    description: "Toggle tree label timestamps",
  },
  {
    id: "app.session.togglePath",
    defaults: ["ctrl+p"],
    description: "Toggle session path display",
  },
  { id: "app.session.toggleSort", defaults: ["ctrl+s"], description: "Toggle session sort mode" },
  { id: "app.session.rename", defaults: ["ctrl+r"], description: "Rename session" },
  { id: "app.session.delete", defaults: ["ctrl+d"], description: "Delete session" },
  {
    id: "app.session.deleteNoninvasive",
    defaults: ["ctrl+backspace"],
    description: "Delete session when query is empty",
  },
  { id: "app.models.save", defaults: ["ctrl+s"], description: "Save model selection" },
  { id: "app.models.enableAll", defaults: ["ctrl+a"], description: "Enable all models" },
  { id: "app.models.clearAll", defaults: ["ctrl+x"], description: "Clear all models" },
  {
    id: "app.models.toggleProvider",
    defaults: ["ctrl+p"],
    description: "Toggle all models for provider",
  },
  { id: "app.models.reorderUp", defaults: ["alt+up"], description: "Move model up in order" },
  { id: "app.models.reorderDown", defaults: ["alt+down"], description: "Move model down in order" },
  { id: "app.tree.filter.default", defaults: ["ctrl+d"], description: "Tree filter: default view" },
  {
    id: "app.tree.filter.noTools",
    defaults: ["ctrl+t"],
    description: "Tree filter: hide tool results",
  },
  {
    id: "app.tree.filter.userOnly",
    defaults: ["ctrl+u"],
    description: "Tree filter: user messages only",
  },
  {
    id: "app.tree.filter.labeledOnly",
    defaults: ["ctrl+l"],
    description: "Tree filter: labeled entries only",
  },
  { id: "app.tree.filter.all", defaults: ["ctrl+a"], description: "Tree filter: show all entries" },
  {
    id: "app.tree.filter.cycleForward",
    defaults: ["ctrl+o"],
    description: "Tree filter: cycle forward",
  },
  {
    id: "app.tree.filter.cycleBackward",
    defaults: ["shift+ctrl+o"],
    description: "Tree filter: cycle backward",
  },
];

export function keybindingDefinitionOf(id: string): KeybindingDefinition | undefined {
  return KEYBINDING_DEFINITIONS.find((definition) => definition.id === id);
}

/** The namespace prefix (`tui.editor`, `app.session`, …) used for grouping. */
export function keybindingNamespace(id: string): string {
  const dot = id.lastIndexOf(".");
  return dot > 0 ? id.slice(0, dot) : id;
}

export interface KeybindingNamespaceGroup {
  namespace: string;
  definitions: KeybindingDefinition[];
}

/** Definitions grouped by namespace, namespaces sorted alphabetically. */
export function groupKeybindingDefinitions(
  definitions: readonly KeybindingDefinition[] = KEYBINDING_DEFINITIONS,
): KeybindingNamespaceGroup[] {
  const byNamespace = new Map<string, KeybindingDefinition[]>();
  for (const definition of definitions) {
    const namespace = keybindingNamespace(definition.id);
    const group = byNamespace.get(namespace);
    if (group) group.push(definition);
    else byNamespace.set(namespace, [definition]);
  }
  return [...byNamespace.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([namespace, group]) => ({ namespace, definitions: group }));
}

// ---------------------------------------------------------------------------
// Resolution, validation and conflict detection.
// ---------------------------------------------------------------------------

const MODIFIERS = new Set(["ctrl", "alt", "shift"]);

/**
 * Canonical form of one key: modifiers sorted alphabetically, base lowercased
 * for named keys. `shift+ctrl+o` and `ctrl+shift+o` are the same physical chord,
 * and conflict detection must treat them as one.
 */
export function canonicalKey(key: string): string {
  const parts = key.split("+").map((part) => part.trim());
  if (parts.length === 1) return key.trim().toLowerCase();
  const base = parts[parts.length - 1] ?? "";
  const modifiers = parts
    .slice(0, -1)
    .map((modifier) => modifier.toLowerCase())
    .sort();
  return [...modifiers, base.toLowerCase()].join("+");
}

/**
 * True when a key id is syntactically plausible: leading `ctrl`/`alt`/`shift`
 * modifiers and a non-empty base. Catches the classic `control+x` / `cmd+x`
 * typos with a message that names the allowed modifiers.
 */
export function invalidKeyReason(key: string): string | null {
  if (typeof key !== "string" || key.trim().length === 0) return "key must be a non-empty string";
  const parts = key.split("+");
  if (parts.some((part) => part.trim().length === 0)) return `"${key}" has an empty segment`;
  const leading = parts.slice(0, -1).map((part) => part.trim().toLowerCase());
  for (const modifier of leading) {
    if (!MODIFIERS.has(modifier)) {
      return `"${key}": unknown modifier "${modifier}" (use ctrl, alt or shift)`;
    }
  }
  if (parts.length > 4) return `"${key}": too many chords`;
  return null;
}

/** A raw `keybindings.json` value: one key or a list of keys. */
export function normalizeBindingValue(value: unknown): string[] | null {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return [...(value as string[])];
  }
  return null;
}

export interface KeybindingValidationIssue {
  id: string;
  message: string;
}

export interface KeybindingValidation {
  /** Ids Pi does not document (kept, but flagged so a typo is visible). */
  unknownIds: string[];
  /** Entries with a malformed value or an implausible key. */
  issues: KeybindingValidationIssue[];
}

/** Validates a parsed `keybindings.json` document without rejecting it. */
export function validateKeybindings(
  document: Record<string, unknown>,
  knownIds: ReadonlySet<string> = new Set(KEYBINDING_DEFINITIONS.map((entry) => entry.id)),
): KeybindingValidation {
  const unknownIds: string[] = [];
  const issues: KeybindingValidationIssue[] = [];
  for (const [id, value] of Object.entries(document)) {
    if (!knownIds.has(id)) unknownIds.push(id);
    const keys = normalizeBindingValue(value);
    if (!keys) {
      issues.push({ id, message: `"${id}" must be a key string or an array of key strings` });
      continue;
    }
    for (const key of keys) {
      const reason = invalidKeyReason(key);
      if (reason) issues.push({ id, message: reason });
    }
  }
  return { unknownIds, issues };
}

/**
 * Effective bindings: Pi's defaults with the user's overrides applied. A user
 * entry replaces the default entirely (it does not merge), and an empty array
 * unbinds the action.
 */
export function resolveKeybindings(
  user: Record<string, unknown>,
  definitions: readonly KeybindingDefinition[] = KEYBINDING_DEFINITIONS,
): Record<string, string[]> {
  const resolved: Record<string, string[]> = {};
  for (const definition of definitions) resolved[definition.id] = [...definition.defaults];
  for (const [id, value] of Object.entries(user)) {
    const keys = normalizeBindingValue(value);
    if (keys) resolved[id] = keys;
  }
  return resolved;
}

export interface KeybindingConflict {
  /** Canonical key shared by more than one action. */
  key: string;
  /** The actions claiming it, in first-seen order. */
  ids: string[];
}

/** Every physical chord claimed by more than one action. */
export function detectKeybindingConflicts(
  resolved: Record<string, readonly string[]>,
): KeybindingConflict[] {
  const claimants = new Map<string, string[]>();
  const display = new Map<string, string>();
  for (const [id, keys] of Object.entries(resolved)) {
    for (const key of keys) {
      const canonical = canonicalKey(key);
      const list = claimants.get(canonical);
      if (list) {
        if (!list.includes(id)) list.push(id);
      } else {
        claimants.set(canonical, [id]);
        display.set(canonical, key);
      }
    }
  }
  const conflicts: KeybindingConflict[] = [];
  for (const [canonical, ids] of claimants) {
    if (ids.length > 1) conflicts.push({ key: display.get(canonical) ?? canonical, ids });
  }
  conflicts.sort((a, b) => a.key.localeCompare(b.key));
  return conflicts;
}

/**
 * The actionable subset of `conflicts`: entries where at least one claimant is
 * one of the user's own overrides. Pi's documented defaults overlap across
 * modal contexts (editor, selectors, tree filters) by design, so the UI shows
 * those as informational and only these as warnings.
 */
export function userKeybindingConflicts(
  conflicts: readonly KeybindingConflict[],
  user: Record<string, unknown>,
): KeybindingConflict[] {
  return conflicts.filter((conflict) => conflict.ids.some((id) => Object.hasOwn(user, id)));
}

/** `keybindings.get` payload as the renderer consumes it. */
export interface KeybindingsSnapshot {
  /** Absolute path of `keybindings.json`. */
  path: string;
  /** The user's overrides (empty when the file does not exist yet). */
  user: Record<string, string[]>;
  /** True when the file exists on disk. */
  exists: boolean;
  /** Effective bindings: documented defaults with the user's overrides applied. */
  effective: Record<string, string[]>;
  /** Documented table, so the renderer never ships its own copy. */
  definitions: KeybindingDefinition[];
  /** Ids Pi does not document (kept, but flagged). */
  unknownIds: string[];
  /** Malformed entries (kept in the file, flagged in the UI). */
  issues: Array<{ id: string; message: string }>;
  /** Physical chords claimed by more than one action. */
  conflicts: KeybindingConflict[];
}

function asSnapshotRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Sanitizes a raw `keybindings.get` payload before the renderer uses it. */
export function sanitizeKeybindingsSnapshot(value: unknown): KeybindingsSnapshot | null {
  const record = asSnapshotRecord(value);
  const path = typeof record.path === "string" ? record.path : "";
  const userRaw = asSnapshotRecord(record.user);
  const user: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(userRaw)) {
    const keys = normalizeBindingValue(entry);
    if (typeof id === "string" && id.length > 0 && keys) user[id] = keys;
  }
  const effectiveRaw = asSnapshotRecord(record.effective);
  const effective: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(effectiveRaw)) {
    const keys = normalizeBindingValue(entry);
    if (keys) effective[id] = keys;
  }
  const definitions = Array.isArray(record.definitions)
    ? record.definitions.flatMap((entry): KeybindingDefinition[] => {
        const item = asSnapshotRecord(entry);
        const id = typeof item.id === "string" ? item.id : "";
        const defaults = normalizeBindingValue(item.defaults);
        const description = typeof item.description === "string" ? item.description : "";
        return id && defaults && description ? [{ id, defaults, description }] : [];
      })
    : [...KEYBINDING_DEFINITIONS];
  const unknownIds = Array.isArray(record.unknownIds)
    ? record.unknownIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const issues = Array.isArray(record.issues)
    ? record.issues.flatMap((entry): Array<{ id: string; message: string }> => {
        const item = asSnapshotRecord(entry);
        return typeof item.id === "string" && typeof item.message === "string"
          ? [{ id: item.id, message: item.message }]
          : [];
      })
    : [];
  const conflicts = Array.isArray(record.conflicts)
    ? record.conflicts.flatMap((entry): KeybindingConflict[] => {
        const item = asSnapshotRecord(entry);
        const key = typeof item.key === "string" ? item.key : "";
        const ids = Array.isArray(item.ids)
          ? item.ids.filter((id): id is string => typeof id === "string")
          : [];
        return key && ids.length > 1 ? [{ key, ids }] : [];
      })
    : [];
  if (!path) return null;
  return {
    path,
    user,
    exists: record.exists === true,
    effective,
    definitions,
    unknownIds,
    issues,
    conflicts,
  };
}
