import { vi } from "vitest";
import { deleteSettingsValue, setSettingsValue } from "../../src/shared/settings-schema";
import type { SettingsErrorInfo, SettingsPort, SettingsScopes } from "../../src/host/settings";

/**
 * An in-memory `SettingsPort` for tests (plan step 12).
 *
 * Mirrors the SDK adapter's contract — two scopes, atomic whole-scope writes,
 * trust refusal — without touching a real `settings.json`, so host tests stay
 * fast and deterministic. Every method is a spy so a test can assert that a host
 * only reads settings when it is asked to.
 */
export interface FakeSettingsOptions {
  global?: Record<string, unknown>;
  project?: Record<string, unknown>;
  trusted?: boolean;
  errors?: SettingsErrorInfo[];
  mtimeMs?: number;
}

export interface FakeSettings extends SettingsPort {
  scopes: SettingsScopes;
  /** The fake file paths, for assertions about external-edit reporting. */
  paths: { global: string; project: string };
}

export function createFakeSettings(options: FakeSettingsOptions = {}): FakeSettings {
  const scopes: SettingsScopes = {
    global: { theme: "dark", model: "test-model", ...(options.global ?? {}) },
    project: { defaultTools: ["read"], ...(options.project ?? {}) },
  };
  const trusted = options.trusted ?? true;
  const errors = options.errors ?? [];
  const mtimeMs = options.mtimeMs ?? 1_700_000_000_000;
  const paths = {
    global: "/profile/agent/settings.json",
    project: "/project/.pi/settings.json",
  };

  const refuseUntrusted = (scope: "global" | "project"): void => {
    if (scope === "project" && !trusted) {
      const error = new Error("the project is not trusted");
      (error as { code?: string }).code = "untrusted";
      throw error;
    }
  };

  return {
    scopes,
    paths,

    read: vi.fn(async () => ({ global: { ...scopes.global }, project: { ...scopes.project } })),

    files: vi.fn(async () => ({
      global: { path: paths.global, exists: true, mtimeMs },
      project: { path: paths.project, exists: true, mtimeMs },
    })),

    isProjectTrusted: vi.fn(() => trusted),

    write: vi.fn(
      async (_cwd: string | null, key: string, value: unknown, scope: "global" | "project") => {
        refuseUntrusted(scope);
        scopes[scope] =
          value === undefined
            ? deleteSettingsValue(scopes[scope], key)
            : setSettingsValue(scopes[scope], key, value);
      },
    ),

    writeScope: vi.fn(
      async (
        _cwd: string | null,
        scope: "global" | "project",
        document: Record<string, unknown>,
      ) => {
        refuseUntrusted(scope);
        scopes[scope] = { ...document };
      },
    ),

    flush: vi.fn(async () => undefined),
    drainErrors: vi.fn(() => [...errors]),
    reload: vi.fn(async () => undefined),
  };
}
