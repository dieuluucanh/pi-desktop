/**
 * The `ThemePort` over Pi's real settings and theme files (plan step 15).
 *
 * The catalogue is the union of three sources: the built-ins (`dark`,
 * `light` — swatches pinned in `src/shared/themes.ts`), the themes Pi's own
 * loader reports (name, file path and scope, so a project theme is labelled
 * honestly), and the conventional theme directories (`<agentDir>/themes`,
 * `<project>/.pi/themes`) for files the loader has not picked up. The active
 * theme is Pi's `theme` setting, read from the same manager the settings port
 * uses.
 *
 * Only root-exported SDK values are used (`SettingsManager`); deep imports are
 * blocked by the SDK's `exports` map.
 */

import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseThemeDocument } from "../../shared/themes";
import type { ModelsFileIo } from "../custom-providers";
import type { FileListingIo } from "../file-listing";
import type { LoadedTheme, ThemePort } from "../themes";

export interface SdkThemePortOptions {
  /** `~/.pi/agent`, resolved by the composition root. */
  agentDir: string;
  /** The project whose `.pi/themes` directory counts as project scope. */
  cwd: string;
  /** The session's manager when a session is open (active theme + extra paths). */
  manager?: {
    getTheme?: () => string | undefined;
    getThemePaths?: () => string[];
  } | null;
  /** `resourceLoader.getThemes()` result when a session is open. */
  loaderThemes?: unknown;
  /** Atomic theme-file writes (the same temp+rename rule as `models.json`). */
  io: ModelsFileIo;
  /** Directory scans for the conventional theme folders. */
  listing: FileListingIo;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stem(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return base.endsWith(".json") ? base.slice(0, -".json".length) : base;
}

function scopeFor(path: string, agentDir: string, cwd: string): LoadedTheme["scope"] {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const projectDir = `${cwd.replace(/\\/g, "/").toLowerCase()}/.pi/themes/`;
  if (normalized.startsWith(projectDir)) return "project";
  const profileDir = `${agentDir.replace(/\\/g, "/").toLowerCase()}/themes/`;
  if (normalized.startsWith(profileDir)) return "user";
  return "user";
}

async function nameOf(
  path: string,
  readFile: (path: string) => Promise<string | null>,
): Promise<string> {
  try {
    const text = await readFile(path);
    if (text) return parseThemeDocument(text).name;
  } catch {
    // Fall through to the filename stem: a theme Pi loads leniently still shows.
  }
  return stem(path);
}

export function createSdkThemePort(options: SdkThemePortOptions): ThemePort {
  const readFile = (path: string): Promise<string | null> => options.io.read(path);

  return {
    async listLoaded(): Promise<LoadedTheme[]> {
      const found = new Map<string, LoadedTheme>();
      // Pi's own loader first: name, path and scope straight from the source.
      const loaderThemes = asRecord(options.loaderThemes).themes;
      if (Array.isArray(loaderThemes)) {
        for (const entry of loaderThemes) {
          const record = asRecord(entry);
          const path = typeof record.sourcePath === "string" ? record.sourcePath : null;
          if (!path || !path.endsWith(".json")) continue;
          const name = typeof record.name === "string" && record.name ? record.name : stem(path);
          const scopeInfo = asRecord(record.sourceInfo);
          const scope =
            scopeInfo.scope === "project"
              ? "project"
              : scopeFor(path, options.agentDir, options.cwd);
          if (!found.has(name)) found.set(name, { name, path, scope });
        }
      }
      // Conventional directories, for files the loader has not picked up.
      const directories: Array<{ dir: string; scope: LoadedTheme["scope"] }> = [
        { dir: join(options.agentDir, "themes"), scope: "user" },
        { dir: join(options.cwd, ".pi", "themes"), scope: "project" },
      ];
      for (const { dir, scope } of directories) {
        let entries: Array<{ name: string; directory: boolean }>;
        try {
          entries = await options.listing.readDirectory(dir);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.directory || !entry.name.endsWith(".json")) continue;
          const path = join(dir, entry.name);
          const name = await nameOf(path, readFile);
          if (!found.has(name)) found.set(name, { name, path, scope });
        }
      }
      // Extra `themes` settings paths (files outside the conventional folders).
      for (const extra of options.manager?.getThemePaths?.() ?? []) {
        if (typeof extra !== "string" || !extra.endsWith(".json")) continue;
        const name = await nameOf(extra, readFile);
        if (!found.has(name)) {
          found.set(name, {
            name,
            path: extra,
            scope: scopeFor(extra, options.agentDir, options.cwd),
          });
        }
      }
      return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    getActive(): string | undefined {
      return options.manager?.getTheme?.() ?? undefined;
    },

    readFile,

    async importFile(filename: string, content: string): Promise<string> {
      const path = join(options.agentDir, "themes", filename);
      await options.io.write(path, content);
      return path;
    },
  };
}

/** A fresh manager for hosts without a session (the control host builds per cwd). */
export function createThemeSettingsManager(cwd: string, agentDir: string): SettingsManager {
  return SettingsManager.create(cwd, agentDir);
}
