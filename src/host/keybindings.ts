/**
 * Keybindings host surface (plan step 15).
 *
 * `keybindings.json` lives at the profile root (`<agentDir>/keybindings.json`,
 * the same path Pi's own migration writes). The host reads it, validates it
 * against the documented id table and reports conflicts; writes go through the
 * injected `KeybindingPort` atomically, so a crashed write can never truncate
 * the shared profile's bindings.
 *
 * Methods (`keybindings.get`, `keybindings.set`, `keybindings.reset`) have no
 * RPC equivalent, which `docs/architecture/host-protocol.md` records.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  KEYBINDING_DEFINITIONS,
  detectKeybindingConflicts,
  normalizeBindingValue,
  resolveKeybindings,
  validateKeybindings,
  type KeybindingConflict,
  type KeybindingDefinition,
} from "../shared/keybindings";
import type { HostHandler } from "./service";

export class KeybindingError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "KeybindingError";
    this.code = code;
  }
}

/** The methods this module answers. */
export const KEYBINDING_METHODS = [
  "keybindings.get",
  "keybindings.set",
  "keybindings.reset",
] as const satisfies readonly HostMethod[];

/** Raw document plus its origin, for the editor and the conflict list. */
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

export interface KeybindingPort {
  /** Absolute path of `keybindings.json`. */
  path(): string;
  /** Raw file text, or null when the file does not exist. */
  read(): Promise<string | null> | string | null;
  /** Atomic replace of the whole document. */
  write(content: string): Promise<void> | void;
  /** Removes the file (reset to Pi's defaults). */
  remove(): Promise<void> | void;
}

/** Parses raw file text into the user overrides (a missing file means `{}`). */
export function parseKeybindingsDocument(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KeybindingError("keybindings.json is not valid JSON; fix or reset it");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new KeybindingError("keybindings.json must be a JSON object of id to keys");
  }
  return parsed as Record<string, unknown>;
}

/** Builds the snapshot the renderer edits. */
export async function readKeybindings(port: KeybindingPort): Promise<KeybindingsSnapshot> {
  const text = await port.read();
  const document = parseKeybindingsDocument(text);
  const user: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(document)) {
    const keys = normalizeBindingValue(value);
    if (keys) user[id] = keys;
  }
  const validation = validateKeybindings(document);
  const effective = resolveKeybindings(user, KEYBINDING_DEFINITIONS);
  return {
    path: port.path(),
    user,
    exists: text !== null,
    effective,
    definitions: [...KEYBINDING_DEFINITIONS],
    unknownIds: validation.unknownIds,
    issues: validation.issues,
    conflicts: detectKeybindingConflicts(effective),
  };
}

/**
 * Validates a replacement document *before* anything is written: unknown ids
 * and malformed keys are refused with the same messages the viewer shows, so
 * the file on disk is always loadable.
 */
export function validatedKeybindingsContent(document: Record<string, unknown>): string {
  const validation = validateKeybindings(document);
  if (validation.issues.length > 0) {
    const first = validation.issues[0];
    throw new KeybindingError(first ? `${first.message}` : "invalid keybindings document");
  }
  if (validation.unknownIds.length > 0) {
    throw new KeybindingError(`unknown keybinding id(s): ${validation.unknownIds.join(", ")}`);
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function createKeybindingHandlers(options: { resolvePort(): KeybindingPort | null }): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  const resolve = (): KeybindingPort => {
    const port = options.resolvePort();
    if (!port) {
      throw new KeybindingError(
        "keybindings are not available in this host: no keybinding port is configured",
        "not_implemented",
      );
    }
    return port;
  };
  return {
    handlers: () => ({
      "keybindings.get": async () => readKeybindings(resolve()),
      "keybindings.set": async (params) => {
        const input =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const document = input.bindings;
        if (!document || typeof document !== "object" || Array.isArray(document)) {
          throw new KeybindingError("keybindings.set requires a bindings object");
        }
        const port = resolve();
        await port.write(validatedKeybindingsContent(document as Record<string, unknown>));
        return readKeybindings(port);
      },
      "keybindings.reset": async () => {
        const port = resolve();
        await port.remove();
        return readKeybindings(port);
      },
    }),
  };
}
