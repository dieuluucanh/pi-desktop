/**
 * Themes host surface (plan step 15).
 *
 * Pi themes are JSON documents on disk; the host catalogues them, resolves
 * preview swatches and validates/imports new ones. Like every other host
 * module this one is pure: Pi contact and the filesystem hide behind the
 * injected `ThemePort`, so tests drive the handlers with fakes and the SDK
 * stays inside `src/host/sdk/*`.
 *
 * Methods (`themes.list`, `themes.import`) have no RPC equivalent — Pi's RPC
 * mode never lists themes — which `docs/architecture/host-protocol.md` records.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  BUILTIN_THEME_SWATCHES,
  parseThemeDocument,
  resolveThemeSwatches,
  ThemeDocumentError,
  themeVariantFromText,
  type ThemeScope,
  type ThemeSummary,
  type ThemeColorResolver,
} from "../shared/themes";
import type { HostHandler } from "./service";

export class ThemeError extends Error {
  readonly code: string;

  constructor(message: string, code = "bad_request") {
    super(message);
    this.name = "ThemeError";
    this.code = code;
  }
}

/** The methods this module answers. */
export const THEME_METHODS = [
  "themes.list",
  "themes.import",
] as const satisfies readonly HostMethod[];

/** One file-based theme the port discovered. */
export interface LoadedTheme {
  name: string;
  path: string;
  scope: Extract<ThemeScope, "user" | "project">;
}

export interface ThemePort {
  /** File-based themes from the profile and the project. */
  listLoaded(): Promise<LoadedTheme[]> | LoadedTheme[];
  /** The active theme name (the `theme` settings key). */
  getActive(): Promise<string | undefined> | string | undefined;
  /** Raw text of a theme file, or null when it cannot be read. */
  readFile(path: string): Promise<string | null> | string | null;
  /** Resolves a theme colour (Pi 1.4 uses `okhsl`/`oklch` values). */
  resolveColor?: ThemeColorResolver;
  /**
   * Imports a validated document: writes `<themesDir>/<filename>` and returns
   * the written path. The handler validates first, so the port writes blind.
   */
  importFile(filename: string, content: string): Promise<string> | string;
}

function builtinSummary(name: string, active: string): ThemeSummary {
  const swatches = BUILTIN_THEME_SWATCHES[name] ?? {};
  return {
    name,
    scope: "builtin",
    active: active === name,
    variant: name === "light" ? "light" : "dark",
    swatches: { ...swatches },
  };
}

function fileSummary(
  loaded: LoadedTheme,
  active: string,
  readFile: ThemePort["readFile"],
  resolveColor?: ThemeColorResolver,
): Promise<ThemeSummary> | ThemeSummary {
  const resolve = (text: string | null): ThemeSummary => {
    if (!text) {
      return {
        name: loaded.name,
        scope: loaded.scope,
        path: loaded.path,
        active: active === loaded.name,
        variant: "dark",
        swatches: {},
      };
    }
    try {
      const parsed = parseThemeDocument(text);
      const swatches = resolveThemeSwatches(parsed, resolveColor);
      const textHex = swatches.text ?? null;
      return {
        name: parsed.name,
        scope: loaded.scope,
        path: loaded.path,
        active: active === parsed.name || active === loaded.name,
        variant: themeVariantFromText(textHex),
        swatches,
      };
    } catch {
      // A theme Pi loads leniently but the strict parser rejects still shows —
      // without swatches — instead of vanishing from the catalogue.
      return {
        name: loaded.name,
        scope: loaded.scope,
        path: loaded.path,
        active: active === loaded.name,
        variant: "dark",
        swatches: {},
      };
    }
  };
  const result = readFile(loaded.path);
  return result instanceof Promise ? result.then(resolve) : resolve(result);
}

/** `themes.list` payload: the catalogue with the active theme marked. */
export async function listThemes(
  port: ThemePort,
): Promise<{ active: string; themes: ThemeSummary[] }> {
  const [loaded, activeRaw] = await Promise.all([port.listLoaded(), port.getActive()]);
  const active = typeof activeRaw === "string" && activeRaw.length > 0 ? activeRaw : "dark";
  const themes: ThemeSummary[] = [builtinSummary("dark", active), builtinSummary("light", active)];
  const seen = new Set(["dark", "light"]);
  for (const entry of loaded) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    themes.push(await fileSummary(entry, active, port.readFile, port.resolveColor));
  }
  return { active, themes };
}

const FILENAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/;

/**
 * Validates an import *before* anything is written: the filename must be a
 * plain `<name>.json` (no directories, no traversal) and the content must be a
 * complete theme document whose `name` matches the filename.
 */
export function validateThemeImport(filename: string, content: string): { name: string } {
  if (!FILENAME_PATTERN.test(filename)) {
    throw new ThemeError(`"${filename}" is not a plain <name>.json filename`);
  }
  let parsed: { name: string };
  try {
    parsed = parseThemeDocument(content);
  } catch (error) {
    if (error instanceof ThemeDocumentError) throw new ThemeError(error.message);
    throw error;
  }
  const expected = filename.slice(0, -".json".length).toLowerCase();
  if (parsed.name.toLowerCase() !== expected) {
    throw new ThemeError(`theme name "${parsed.name}" does not match the filename "${filename}"`);
  }
  return { name: parsed.name };
}

export function createThemeHandlers(options: {
  /**
   * The port for the requested project (control hosts), or the session's own
   * port (session hosts, which ignore the argument). Null answers
   * `not_implemented` instead of an empty catalogue.
   */
  resolvePort(cwd: string | null): ThemePort | null;
}): {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
} {
  return {
    handlers: () => ({
      "themes.list": async (params) => {
        const input =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const requested =
          typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd.trim() : null;
        const port = options.resolvePort(requested);
        if (!port) {
          throw new ThemeError(
            "themes are not available in this host: no theme port is configured",
            "not_implemented",
          );
        }
        return listThemes(port);
      },
      "themes.import": async (params) => {
        const input =
          params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        const port = options.resolvePort(null);
        if (!port) {
          throw new ThemeError(
            "themes are not available in this host: no theme port is configured",
            "not_implemented",
          );
        }
        const filename = typeof input.filename === "string" ? input.filename : "";
        const content = typeof input.content === "string" ? input.content : "";
        if (content.length === 0) throw new ThemeError("themes.import requires file content");
        const { name } = validateThemeImport(filename, content);
        const path = await port.importFile(filename, content);
        return { name, path };
      },
    }),
  };
}
