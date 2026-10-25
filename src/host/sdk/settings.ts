/**
 * The `SettingsPort` over a real `SettingsManager` (plan step 12).
 *
 * Reads, errors and flushes come from Pi. A write takes the SDK path when one
 * exists — the named setters, which also generate derived values such as
 * `trackingId` — and otherwise edits the scope's JSON document atomically. The
 * document path is what makes generic, per-key and **project-scope** writes
 * possible at all: Pi only has project setters for its resource keys.
 *
 * Every document write is: parse (refuse a malformed file), back up once,
 * replace atomically, `reload()` the manager, and revert the previous bytes if
 * Pi cannot load the result. A typo therefore cannot leave a broken profile.
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import type {
  DefaultProjectTrust,
  FullscreenExitOutput,
  PackageSource,
  TuiMode,
} from "@earendil-works/pi-coding-agent";
import {
  deleteSettingsValue,
  getSettingsValue,
  setSettingsValue,
} from "../../shared/settings-schema";
import type { SettingsScope } from "../../shared/settings-schema";
import {
  SettingsError,
  toSettingsErrorInfo,
  type SettingsErrorInfo,
  type SettingsFileIo,
  type SettingsFileStatus,
  type SettingsPort,
  type SettingsScopes,
} from "../settings";

export interface SdkSettingsOptions {
  /** `~/.pi/agent`, resolved by the composition root. */
  agentDir: string;
  /** The cwd used when a caller does not pass one (control host: home). */
  cwd: string;
  io: SettingsFileIo;
  /** Where “backup before the first write” copies go (plan step 12). */
  backupDir?: string;
  now?: () => number;
  /**
   * The manager to use for the default cwd. The session host passes its own so a
   * write is visible to that session without a second manager; a control host
   * lets the adapter create one per project cwd.
   */
  manager?: SettingsManager;
  /**
   * Whether a project has been trusted, so the manager it creates loads (and may
   * write) that project's `.pi/settings.json`. Pi refuses project writes when the
   * manager was built untrusted, and this is what keeps the app honest.
   */
  isProjectTrusted?: (cwd: string) => boolean;
  /** The bundled npm, applied as a runtime-only override to every manager. */
  npmCommand?: readonly string[] | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/** Applies one validated value to a manager through an SDK named setter. */
type NamedSetter = (manager: SettingsManager, value: unknown) => void;

/**
 * Global-scope named setters. A key absent here (or a manager missing the
 * method) falls through to the document editor, so an SDK change degrades to a
 * correct write instead of a crash.
 */
const GLOBAL_SETTERS: Record<string, NamedSetter> = {
  theme: (manager, value) => manager.setTheme(asString(value)),
  defaultProvider: (manager, value) => manager.setDefaultProvider(asString(value)),
  defaultModel: (manager, value) => manager.setDefaultModel(asString(value)),
  defaultThinkingLevel: (manager, value) =>
    manager.setDefaultThinkingLevel(asString(value) as never),
  transport: (manager, value) => manager.setTransport(asString(value) as never),
  steeringMode: (manager, value) =>
    manager.setSteeringMode(value === "all" ? "all" : "one-at-a-time"),
  followUpMode: (manager, value) =>
    manager.setFollowUpMode(value === "all" ? "all" : "one-at-a-time"),
  "compaction.enabled": (manager, value) => manager.setCompactionEnabled(asBoolean(value)),
  "retry.enabled": (manager, value) => manager.setRetryEnabled(asBoolean(value)),
  hideThinkingBlock: (manager, value) => manager.setHideThinkingBlock(asBoolean(value)),
  showCacheMissNotices: (manager, value) => manager.setShowCacheMissNotices(asBoolean(value)),
  shellPath: (manager, value) =>
    manager.setShellPath(value === undefined ? undefined : asString(value)),
  quietStartup: (manager, value) => manager.setQuietStartup(asBoolean(value)),
  defaultProjectTrust: (manager, value) =>
    manager.setDefaultProjectTrust(asString(value) as DefaultProjectTrust),
  shellCommandPrefix: (manager, value) =>
    manager.setShellCommandPrefix(value === undefined ? undefined : asString(value)),
  npmCommand: (manager, value) =>
    manager.setNpmCommand(value === undefined ? undefined : asStringArray(value)),
  collapseChangelog: (manager, value) => manager.setCollapseChangelog(asBoolean(value)),
  enableInstallTelemetry: (manager, value) => manager.setEnableInstallTelemetry(asBoolean(value)),
  // The SDK generates `trackingId` on opt-in, which a raw file write would skip.
  enableAnalytics: (manager, value) => manager.setEnableAnalytics(asBoolean(value)),
  packages: (manager, value) => manager.setPackages(value as PackageSource[]),
  extensions: (manager, value) => manager.setExtensionPaths(asStringArray(value)),
  skills: (manager, value) => manager.setSkillPaths(asStringArray(value)),
  prompts: (manager, value) => manager.setPromptTemplatePaths(asStringArray(value)),
  themes: (manager, value) => manager.setThemePaths(asStringArray(value)),
  enableSkillCommands: (manager, value) => manager.setEnableSkillCommands(asBoolean(value)),
  "terminal.showImages": (manager, value) => manager.setShowImages(asBoolean(value)),
  "terminal.imageWidthCells": (manager, value) => manager.setImageWidthCells(asNumber(value)),
  "terminal.clearOnShrink": (manager, value) => manager.setClearOnShrink(asBoolean(value)),
  "images.autoResize": (manager, value) => manager.setImageAutoResize(asBoolean(value)),
  "images.blockImages": (manager, value) => manager.setBlockImages(asBoolean(value)),
  enabledModels: (manager, value) =>
    manager.setEnabledModels(value === undefined ? undefined : asStringArray(value)),
  doubleEscapeAction: (manager, value) => manager.setDoubleEscapeAction(asString(value) as never),
  treeFilterMode: (manager, value) => manager.setTreeFilterMode(asString(value) as never),
  editorPaddingX: (manager, value) => manager.setEditorPaddingX(asNumber(value)),
  outputPad: (manager, value) => manager.setOutputPad(asNumber(value) === 1 ? 1 : 0),
  autocompleteMaxVisible: (manager, value) => manager.setAutocompleteMaxVisible(asNumber(value)),
  showHardwareCursor: (manager, value) => manager.setShowHardwareCursor(asBoolean(value)),
  "markdown.mermaid": (manager, value) => manager.setMermaidRenderingMode(asString(value) as never),
  "warnings.anthropicExtraUsage": (manager, value) =>
    manager.setWarnings({ ...manager.getWarnings(), anthropicExtraUsage: asBoolean(value) }),
  httpIdleTimeoutMs: (manager, value) => manager.setHttpIdleTimeoutMs(asNumber(value)),
  tuiMode: (manager, value) => manager.setTuiMode(asString(value) as TuiMode),
  fullscreenExitOutput: (manager, value) =>
    manager.setFullscreenExitOutput(asString(value) as FullscreenExitOutput),
  fullscreenScrollbar: (manager, value) => manager.setFullscreenScrollbar(asString(value) as never),
  fullscreenCopyOnSelect: (manager, value) => manager.setFullscreenCopyOnSelect(asBoolean(value)),
};

/** Project-scope setters Pi actually has (resource keys only). */
const PROJECT_SETTERS: Record<string, NamedSetter> = {
  packages: (manager, value) => manager.setProjectPackages(value as PackageSource[]),
  extensions: (manager, value) => manager.setProjectExtensionPaths(asStringArray(value)),
  skills: (manager, value) => manager.setProjectSkillPaths(asStringArray(value)),
  prompts: (manager, value) => manager.setProjectPromptTemplatePaths(asStringArray(value)),
  themes: (manager, value) => manager.setProjectThemePaths(asStringArray(value)),
};

/** Parses a settings file; a malformed file is surfaced, never overwritten. */
export function parseSettingsFile(text: string | null, path: string): Record<string, unknown> {
  if (text === null || text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SettingsError(`${path} is not valid JSON; fix it by hand first`, "parse_failed");
  }
  if (!isRecord(parsed)) {
    throw new SettingsError(`${path} must contain a JSON object`, "parse_failed");
  }
  return parsed;
}

export function serializeSettingsFile(document: Record<string, unknown>): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function hasMethod(manager: SettingsManager, name: keyof SettingsManager): boolean {
  return typeof manager[name] === "function";
}

export function createSdkSettingsPort(options: SdkSettingsOptions): SettingsPort {
  const now = options.now ?? ((): number => Date.now());
  const managers = new Map<string, SettingsManager>();
  const backedUp = new Set<string>();

  const globalPath = join(options.agentDir, "settings.json");
  const projectPath = (cwd: string): string => join(cwd, CONFIG_DIR_NAME, "settings.json");

  const managerFor = (cwd: string | null): SettingsManager => {
    const resolved = cwd ?? options.cwd;
    const cached = managers.get(resolved);
    if (cached) return cached;
    let created: SettingsManager;
    if (options.manager && resolved === options.cwd) {
      created = options.manager;
    } else {
      created = SettingsManager.create(resolved, options.agentDir, {
        projectTrusted: options.isProjectTrusted?.(resolved) ?? false,
      });
      if (options.npmCommand && options.npmCommand.length > 0) {
        // Runtime-only override: never written to the shared settings.json.
        created.applyOverrides({ npmCommand: [...options.npmCommand] });
      }
    }
    managers.set(resolved, created);
    return created;
  };

  const pathFor = (cwd: string | null, scope: SettingsScope): string =>
    scope === "global" ? globalPath : projectPath(cwd ?? options.cwd);

  /**
   * Re-reads a manager from disk and re-applies the runtime-only npm override.
   * `SettingsManager.reload()` drops `applyOverrides`, so every reload path must
   * use this helper or package operations lose the bundled runtime.
   */
  const reloadManager = async (manager: SettingsManager): Promise<void> => {
    await manager.reload();
    if (options.npmCommand && options.npmCommand.length > 0) {
      manager.applyOverrides({ npmCommand: [...options.npmCommand] });
    }
  };

  /**
   * Reads the target file back and checks the keys that a caller promised to
   * persist. A named setter that silently no-ops (sticky load error, read-only
   * volume) therefore becomes a visible `write_failed` instead of a star that
   * only exists in memory. Normalising setters are not compared unless the key
   * is the scope-critical `enabledModels`.
   */
  const verifyWritten = async (
    manager: SettingsManager,
    path: string,
    values: Record<string, unknown>,
  ): Promise<void> => {
    const document = parseSettingsFile(await options.io.read(path), path);
    for (const [key, value] of Object.entries(values)) {
      if (isDeepStrictEqual(getSettingsValue(document, key), value)) continue;
      await reloadManager(manager).catch(() => undefined);
      throw new SettingsError(`the settings write did not persist (${key})`, "write_failed");
    }
  };

  const backupOnce = async (path: string): Promise<void> => {
    if (!options.backupDir || backedUp.has(path)) return;
    backedUp.add(path);
    const current = await options.io.read(path);
    if (current === null) return;
    await mkdir(options.backupDir, { recursive: true });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    await options.io.write(join(options.backupDir, `${basename(path)}.${stamp}.bak`), current);
  };

  /**
   * Rewrites one scope document atomically and re-reads it with Pi. On any
   * failure the previous bytes are restored, so the profile is never left in a
   * state Pi cannot load.
   */
  const editDocument = async (
    cwd: string | null,
    scope: SettingsScope,
    mutate: (document: Record<string, unknown>) => Record<string, unknown>,
    expectation?: { key: string; expected: unknown },
  ): Promise<void> => {
    const manager = managerFor(cwd);
    if (scope === "project" && !manager.isProjectTrusted()) {
      throw new SettingsError(
        "the project is not trusted; refusing to write project settings",
        "untrusted",
      );
    }
    const path = pathFor(cwd, scope);
    const previous = await options.io.read(path);
    const document = parseSettingsFile(previous, path);
    if (
      expectation &&
      !isDeepStrictEqual(getSettingsValue(document, expectation.key), expectation.expected)
    ) {
      throw new SettingsError("settings changed on disk; reload and retry", "conflict");
    }
    const next = mutate(document);
    // Clear stale diagnostics so the check below only sees this write's outcome.
    manager.drainErrors();
    await backupOnce(path);
    await options.io.write(path, serializeSettingsFile(next));
    try {
      await reloadManager(manager);
      const failures = manager
        .drainErrors()
        .map(toSettingsErrorInfo)
        .filter((info) => info.scope === scope);
      if (failures.length > 0) {
        throw new SettingsError(
          failures.map((info) => info.message).join("; "),
          "validation_failed",
        );
      }
    } catch (error) {
      if (previous === null) await options.io.delete(path);
      else await options.io.write(path, previous);
      await reloadManager(manager).catch(() => undefined);
      throw error;
    }
  };

  const statusOf = async (path: string): Promise<SettingsFileStatus> => {
    const info = await options.io.stat(path);
    return { path, exists: info !== null, mtimeMs: info?.mtimeMs ?? null };
  };

  return {
    async read(cwd: string | null): Promise<SettingsScopes> {
      const manager = managerFor(cwd);
      return {
        global: { ...manager.getGlobalSettings() },
        project: { ...manager.getProjectSettings() },
      };
    },

    async files(cwd) {
      return {
        global: await statusOf(globalPath),
        project: await statusOf(projectPath(cwd ?? options.cwd)),
      };
    },

    isProjectTrusted(cwd) {
      return managerFor(cwd).isProjectTrusted();
    },

    async write(cwd, key, value, scope): Promise<void> {
      const manager = managerFor(cwd);
      const path = pathFor(cwd, scope);
      await reloadManager(manager);
      // A malformed file is surfaced, never overwritten — including by a named
      // setter, which would otherwise have the SDK rewrite it clean.
      parseSettingsFile(await options.io.read(path), path);
      const named = scope === "global" ? GLOBAL_SETTERS[key] : PROJECT_SETTERS[key];
      if (named && hasMethod(manager, "flush")) {
        // A named setter writes the same file the document editor does, so the
        // backup-before-first-write guarantee applies to it too.
        if (scope === "project" && !manager.isProjectTrusted()) {
          throw new SettingsError(
            "the project is not trusted; refusing to write project settings",
            "untrusted",
          );
        }
        await backupOnce(path);
        named(manager, value);
        await manager.flush();
        if (key === "enabledModels") {
          await verifyWritten(manager, path, { [key]: value });
        }
        return;
      }
      await editDocument(cwd, scope, (document) =>
        value === undefined
          ? deleteSettingsValue(document, key)
          : setSettingsValue(document, key, value),
      );
      await verifyWritten(manager, path, { [key]: value });
    },

    async compareAndWrite(cwd, key, expected, value, scope): Promise<void> {
      const manager = managerFor(cwd);
      const path = pathFor(cwd, scope);
      await reloadManager(manager);
      const current = parseSettingsFile(await options.io.read(path), path);
      if (!isDeepStrictEqual(getSettingsValue(current, key), expected)) {
        throw new SettingsError("settings changed on disk; reload and retry", "conflict");
      }
      const named = scope === "global" ? GLOBAL_SETTERS[key] : PROJECT_SETTERS[key];
      if (named && hasMethod(manager, "flush")) {
        if (scope === "project" && !manager.isProjectTrusted()) {
          throw new SettingsError(
            "the project is not trusted; refusing to write project settings",
            "untrusted",
          );
        }
        await backupOnce(path);
        named(manager, value);
        await manager.flush();
        await verifyWritten(manager, path, { [key]: value });
        return;
      }
      await editDocument(
        cwd,
        scope,
        (document) =>
          value === undefined
            ? deleteSettingsValue(document, key)
            : setSettingsValue(document, key, value),
        { key, expected },
      );
      await verifyWritten(manager, path, { [key]: value });
    },

    async writeMany(cwd, scope, values): Promise<void> {
      if (Object.keys(values).length === 0) return;
      const manager = managerFor(cwd);
      const path = pathFor(cwd, scope);
      await reloadManager(manager);
      // One document edit is atomic and preserves every unrelated key. The
      // defaults written here do not need SDK-derived fields, and a single edit
      // cannot leave a half-updated provider/model pair.
      await editDocument(cwd, scope, (document) => {
        let next = document;
        for (const [key, value] of Object.entries(values)) {
          next =
            value === undefined
              ? deleteSettingsValue(next, key)
              : setSettingsValue(next, key, value);
        }
        return next;
      });
      await verifyWritten(manager, path, values);
    },

    async writeScope(cwd, scope, document): Promise<void> {
      await editDocument(cwd, scope, () => document);
    },

    async flush(cwd): Promise<void> {
      await managerFor(cwd).flush();
    },

    drainErrors(cwd): SettingsErrorInfo[] {
      return managerFor(cwd).drainErrors().map(toSettingsErrorInfo);
    },

    async reload(cwd): Promise<void> {
      await reloadManager(managerFor(cwd));
    },
  };
}
