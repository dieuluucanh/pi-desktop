/**
 * Pi's `settings.json`, edited through one port (plan step 12).
 *
 * Pi's `SettingsManager` exposes **named setters**, not `set(key, value)`, and
 * only its resource keys have project-scope writers. The desktop needs generic,
 * per-key, per-scope edits, so the port below is the app's own settings layer:
 * reads and errors still come from the SDK manager, while a write is either a
 * named setter (when one exists) or an atomic, schema-validated edit of the
 * scope's JSON document — never a hand-rolled JSONL or an overwrite of a
 * malformed file (repo rule 3 and risk R8).
 *
 * The module is pure: `src/host/sdk/settings.ts` supplies the `SettingsPort`.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  findSettingsField,
  getSettingsValue,
  parseSettingsJson,
  validateSettingsValue,
  type SettingsScope,
  type SettingsValue,
} from "../shared/settings-schema";
import type {
  SettingsErrorInfo,
  SettingsFileStatus,
  SettingsScopes,
  SettingsSnapshot,
} from "../shared/settings";
import type { HostHandler } from "./service";

// Re-exported so host modules and tests import the wire shapes from one place.
export type {
  SettingsErrorInfo,
  SettingsFileStatus,
  SettingsScopes,
  SettingsSnapshot,
} from "../shared/settings";

/** The methods this module answers. All four already exist in `HOST_METHODS`. */
export const SETTINGS_METHODS = [
  "settings.get",
  "settings.set",
  "settings.raw",
  "settings.flush",
] as const satisfies readonly HostMethod[];

/** Matches the shape the host service turns into an error frame. */
export class SettingsError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "SettingsError";
    this.code = code;
  }
}

/**
 * Atomic access to the two settings files, injected so tests need no real disk.
 * `stat` is what lets the renderer notice a change made by terminal Pi.
 */
export interface SettingsFileIo {
  read(path: string): Promise<string | null>;
  /** Replaces the file atomically (temp file + rename); creates it if absent. */
  write(path: string, text: string): Promise<void>;
  /** Removes the file (used to revert a first-ever write). */
  delete(path: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number; size: number } | null>;
}

/** The settings surface a host needs; implemented by `src/host/sdk/settings.ts`. */
export interface SettingsPort {
  read(cwd: string | null): Promise<SettingsScopes>;
  files(cwd: string | null): Promise<{ global: SettingsFileStatus; project: SettingsFileStatus }>;
  isProjectTrusted(cwd: string | null): boolean;
  /** Sets or deletes one key in one scope. Throws `SettingsError` on invalid input. */
  write(cwd: string | null, key: string, value: unknown, scope: SettingsScope): Promise<void>;
  /** Replaces a whole scope document (the raw JSON editor). */
  writeScope(
    cwd: string | null,
    scope: SettingsScope,
    document: Record<string, unknown>,
  ): Promise<void>;
  flush(cwd: string | null): Promise<void>;
  drainErrors(cwd: string | null): SettingsErrorInfo[];
  /** Re-reads both files after a write (or an external edit). */
  reload(cwd: string | null): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalCwd(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireScope(value: unknown): SettingsScope {
  if (value === "project") return "project";
  if (value === "global" || value === undefined || value === null) return "global";
  throw new SettingsError(`unknown settings scope ${String(value)}`);
}

/** Normalises the SDK's `SettingsError[]` into a JSON-safe shape. */
export function toSettingsErrorInfo(value: unknown): SettingsErrorInfo {
  const record = asRecord(value);
  const scope = record.scope === "project" ? "project" : "global";
  const error = record.error;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const path = typeof record.path === "string" ? record.path : undefined;
  return { scope, ...(path ? { path } : {}), message };
}

/**
 * Validates a whole scope document before it is written. Known keys must pass
 * their field's rules; unknown keys are preserved verbatim so a Pi upgrade that
 * adds a key does not lose it. Returns a copy with `undefined` values removed.
 */
export function validateSettingsDocument(document: unknown): Record<string, unknown> {
  if (document === null || document === undefined) return {};
  if (typeof document !== "object" || Array.isArray(document)) {
    throw new SettingsError("a settings scope must be a JSON object");
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    if (value === undefined) continue;
    result[key] = value;
  }
  const flat: Array<[string, unknown]> = [];
  const walk = (value: unknown, prefix: string): void => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        walk(child, prefix.length > 0 ? `${prefix}.${key}` : key);
      }
      return;
    }
    flat.push([prefix, value]);
  };
  walk(result, "");
  for (const [key, value] of flat) {
    const field = findSettingsField(key);
    if (!field) continue;
    const validated = validateSettingsValue(field, value);
    if (!validated.ok) throw new SettingsError(validated.error);
  }
  return result;
}

export interface SettingsHandlerOptions {
  /** Resolves the port, or null when the host cannot edit settings. */
  resolvePort(): SettingsPort | null;
}

/** The `settings.*` handlers. Input is validated before the port is touched. */
export function createSettingsHandlers(options: SettingsHandlerOptions): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  const port = (): SettingsPort => {
    const current = options.resolvePort();
    if (!current) {
      throw new SettingsError("settings are not available in this host", "not_implemented");
    }
    return current;
  };

  const snapshot = async (cwd: string | null): Promise<SettingsSnapshot> => {
    const current = port();
    const [settings, files] = await Promise.all([current.read(cwd), current.files(cwd)]);
    return {
      settings,
      errors: current.drainErrors(cwd),
      files,
      projectTrusted: current.isProjectTrusted(cwd),
    };
  };

  return {
    handlers: () => ({
      "settings.get": async (params) => snapshot(optionalCwd(asRecord(params).cwd)),

      "settings.flush": async (params) => {
        const cwd = optionalCwd(asRecord(params).cwd);
        const current = port();
        await current.flush(cwd);
        return { flushed: true, errors: current.drainErrors(cwd) };
      },

      "settings.set": async (params) => {
        const input = asRecord(params);
        const cwd = optionalCwd(input.cwd);
        const scope = requireScope(input.scope);
        const key = typeof input.key === "string" ? input.key.trim() : "";
        if (key.length === 0) throw new SettingsError("settings.set requires a key");
        const field = findSettingsField(key);
        if (!field) throw new SettingsError(`unknown setting "${key}"`);
        if (scope === "project" && field.scope === "global") {
          throw new SettingsError(`${key} is a global-only setting`);
        }
        const validated = validateSettingsValue(field, input.value);
        if (!validated.ok) throw new SettingsError(validated.error);
        await port().write(cwd, key, validated.value, scope);
        return snapshot(cwd);
      },

      "settings.raw": async (params) => {
        const input = asRecord(params);
        const cwd = optionalCwd(input.cwd);
        // No `document` means read (the existing behaviour); a document writes.
        if (!("document" in input)) return snapshot(cwd);
        const scope = requireScope(input.scope);
        let document: unknown = input.document;
        if (typeof document === "string") {
          const parsed = parseSettingsJson(document);
          if (!parsed.ok) throw new SettingsError(parsed.error);
          document = parsed.value;
        }
        await port().writeScope(cwd, scope, validateSettingsDocument(document));
        return snapshot(cwd);
      },
    }),
  };
}

/** The effective value of a key across scopes (project wins), for tests and UI. */
export function effectiveSettingsValue(
  scopes: SettingsScopes,
  key: string,
): SettingsValue | undefined {
  const project = getSettingsValue(scopes.project, key);
  return project === undefined ? getSettingsValue(scopes.global, key) : project;
}
