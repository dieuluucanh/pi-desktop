/**
 * The settings wire shapes (plan step 12).
 *
 * Shared by the host handlers, the preload/IPC layer and the renderer, so all
 * three agree on what `settings.get` returns without the renderer importing a
 * host module. `SettingsScope` itself lives in the schema (it is a property of
 * every field); the key list and defaults live there too.
 */

import type { SettingsScope } from "./settings-schema";

export type { SettingsScope } from "./settings-schema";

/** One settings file's on-disk identity, for external-edit detection. */
export interface SettingsFileStatus {
  path: string;
  exists: boolean;
  mtimeMs: number | null;
}

/** A settings error as it crosses the wire (the SDK's `Error` is not JSON-safe). */
export interface SettingsErrorInfo {
  scope: SettingsScope;
  path?: string;
  message: string;
}

/** Both scopes, never a merged object (the renderer shows which one wins). */
export interface SettingsScopes {
  global: Record<string, unknown>;
  project: Record<string, unknown>;
}

/** The result of every `settings.*` call that changes or reads state. */
export interface SettingsSnapshot {
  settings: SettingsScopes;
  errors: SettingsErrorInfo[];
  files: { global: SettingsFileStatus; project: SettingsFileStatus };
  /** Whether Pi considers the project trusted (project writes are refused otherwise). */
  projectTrusted: boolean;
}

/** Validates an untrusted scope value at the IPC/renderer boundary. */
export function isSettingsScope(value: unknown): value is SettingsScope {
  return value === "global" || value === "project";
}

/** A JSON value read out of a settings document. */
export type { SettingsValue } from "./settings-schema";
