/**
 * The `PackagePort` implementation over Pi's `DefaultPackageManager`
 * (plan step 14).
 *
 * This is the only module that constructs a package manager. The rules it keeps:
 *
 * - **Pi owns `settings.json`.** `installAndPersist`/`removeAndPersist` are the
 *   write paths, so the entry shape, the npm root and the lockfile are exactly
 *   terminal Pi's.
 * - **The bundled npm is a runtime override.** `SettingsManager.applyOverrides`
 *   points npm at the runtime's Node + npm CLI without writing `npmCommand` to
 *   the shared profile (the plan's flush test pins that).
 * - **npm output never enters the JSONL stream.** Pi's package manager spawns
 *   npm with inherited stdio; the override therefore runs a tiny shim that pipes
 *   npm, forwards its output to the host's stderr and tees it to a log file. A
 *   failed operation can then carry the npm output tail.
 * - **A failure is a `PackageError`.** The adapter classifies it and appends the
 *   captured output, so the UI can show something actionable.
 *
 * One manager (and one `SettingsManager`) is cached per project folder, so a
 * project's `.pi/settings.json` is the one Pi reads and writes.
 */

import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  classifyPackageFailure,
  PackageError,
  type PackageOperationProgress,
  type PackagePort,
  type PackageProgressSink,
  type PackageTarget,
} from "../packages";
import {
  tryParsePackageSource,
  type PackageSourceKind,
  type PackageSummary,
} from "../../shared/packages";

/** The npm CLI the capture shim should run (absolute path to `npm-cli.js`). */
export const NPM_CAPTURE_CLI_ENV = "PI_DESKTOP_NPM_CLI";
/** The file the capture shim appends npm output to. */
export const NPM_CAPTURE_LOG_ENV = "PI_DESKTOP_NPM_LOG";

/**
 * The npm capture shim, run as `node -e <shim> <npm args…>`.
 *
 * Read-only queries (`root -g`, `view …`) keep npm's stdout on the shim's
 * stdout, because Pi captures those answers through pipes. Installs/uninstalls
 * send everything to the shim's stderr, so a package's output can never be
 * mistaken for a protocol frame.
 */
export const NPM_CAPTURE_SHIM = [
  'const cp=require("node:child_process");const fs=require("node:fs");',
  "const args=process.argv.slice(1);",
  `const cli=process.env.${NPM_CAPTURE_CLI_ENV};const log=process.env.${NPM_CAPTURE_LOG_ENV};`,
  'if(!cli){process.stderr.write("pi-desktop: the bundled npm CLI is not configured");process.exit(1);}',
  'const query=args[0]==="root"||args[0]==="view"||args[0]==="list";',
  'const r=cp.spawnSync(process.execPath,[cli].concat(args),{stdio:["ignore","pipe","pipe"],env:process.env,windowsHide:true});',
  'const out=r.stdout?r.stdout.toString():"";const err=r.stderr?r.stderr.toString():"";const all=out+err;',
  "if(log){try{fs.appendFileSync(log,all);}catch(e){}}",
  "if(query){if(out)process.stdout.write(out);if(err)process.stderr.write(err);}",
  "else if(all){process.stderr.write(all);}",
  "if(r.error){process.stderr.write(String(r.error.message||r.error));}",
  'process.exit(typeof r.status==="number"?r.status:1);',
].join("");

/** The `npmCommand` override that routes npm through the capture shim. */
export function npmOverrideCommand(npmCommand: readonly string[] | null): string[] | null {
  if (!npmCommand || npmCommand.length < 2) return null;
  const [nodePath] = npmCommand;
  if (!nodePath) return null;
  return [nodePath, "-e", NPM_CAPTURE_SHIM];
}

/** The SDK progress callback shape (structural, so a fake manager is trivial). */
export interface PackageManagerProgress {
  type: "start" | "progress" | "complete" | "error";
  action: "install" | "remove" | "update" | "clone" | "pull";
  source: string;
  message?: string;
}

export interface ConfiguredPackageLike {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

/** The slice of `DefaultPackageManager` this adapter uses. */
export interface PackageManagerLike {
  installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
  removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
  update(source?: string): Promise<void>;
  listConfiguredPackages(): ConfiguredPackageLike[];
  getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
  setProgressCallback(callback: ((event: PackageManagerProgress) => void) | undefined): void;
}

export interface SdkPackageOptions {
  /** `~/.pi/agent`, resolved by the composition root. */
  agentDir: string;
  /** cwd used when a request carries none (the control host's own cwd). */
  defaultCwd: string;
  /** `[nodePath, npmCliJs]` from the runtime resolver; a runtime-only override. */
  npmCommand?: readonly string[] | null;
  /** Whether a project is trusted, so its manager may read/write `.pi/settings.json`. */
  isProjectTrusted?: (cwd: string) => boolean;
  /** Where the capture shim's log lives (default: the OS temp dir). */
  logDir?: string;
  /** Injected for tests: builds the manager for one project. */
  createManager?: (options: {
    cwd: string;
    agentDir: string;
    settingsManager: SettingsManager;
  }) => PackageManagerLike;
  /** Injected for tests: builds the settings manager for one project. */
  createSettingsManager?: (cwd: string) => SettingsManager;
  /** Injected for tests: reads a package's installed version. */
  readVersion?: (installedPath: string) => Promise<string | null>;
  now?: () => number;
}

/** How much of the captured npm output a failure carries. */
export const MAX_NPM_OUTPUT_CHARS = 4_000;

/** Applies the bundled-npm runtime override to a manager; never persisted. */
export function applyNpmOverride(
  manager: SettingsManager,
  npmCommand: readonly string[] | null,
): void {
  if (!npmCommand || npmCommand.length === 0) return;
  manager.applyOverrides({ npmCommand: [...npmCommand] });
}

export function tailNpmOutput(text: string, maxChars = MAX_NPM_OUTPUT_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…(truncated)\n${trimmed.slice(trimmed.length - maxChars)}`;
}

/** A failed npm run with its captured output appended to the message. */
export function packageFailure(
  error: unknown,
  output: string | null,
  classify: (message: string) => { code: string; hint: string | null },
): PackageError {
  // An already-classified failure (e.g. a trust refusal) keeps its own code.
  if (error instanceof PackageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const { code, hint } = classify(message);
  const parts = [message];
  if (hint) parts.push(`Hint: ${hint}`);
  if (output) parts.push(`npm output:\n${tailNpmOutput(output)}`);
  return new PackageError(
    parts.join("\n\n"),
    code,
    output ? { output: tailNpmOutput(output) } : undefined,
  );
}

export function createSdkPackagePort(options: SdkPackageOptions): PackagePort {
  const createSettingsManager =
    options.createSettingsManager ??
    ((cwd: string): SettingsManager =>
      SettingsManager.create(cwd, options.agentDir, {
        projectTrusted: options.isProjectTrusted?.(cwd) ?? false,
      }));
  const createManager =
    options.createManager ??
    (({ cwd, agentDir, settingsManager }): PackageManagerLike =>
      new DefaultPackageManager({ cwd, agentDir, settingsManager }));
  const readVersion =
    options.readVersion ??
    (async (installedPath: string): Promise<string | null> => {
      try {
        const raw = await readFile(join(installedPath, "package.json"), "utf8");
        const parsed: unknown = JSON.parse(raw);
        const version = (parsed as { version?: unknown } | null)?.version;
        return typeof version === "string" && version.length > 0 ? version : null;
      } catch {
        return null;
      }
    });

  const override = npmOverrideCommand(options.npmCommand ?? null);
  if (override && options.npmCommand?.[1]) {
    // The shim reads these from the host's environment at spawn time.
    process.env[NPM_CAPTURE_CLI_ENV] = options.npmCommand[1];
  }
  const logPath = join(options.logDir ?? tmpdir(), `pi-desktop-npm-${process.pid}.log`);

  const contexts = new Map<
    string,
    { manager: PackageManagerLike; settingsManager: SettingsManager }
  >();

  const contextFor = (
    cwd: string | null,
  ): { manager: PackageManagerLike; settingsManager: SettingsManager } => {
    const resolved = cwd ?? options.defaultCwd;
    const cached = contexts.get(resolved);
    if (cached) return cached;
    const settingsManager = createSettingsManager(resolved);
    if (override) applyNpmOverride(settingsManager, override);
    const manager = createManager({ cwd: resolved, agentDir: options.agentDir, settingsManager });
    const created = { manager, settingsManager };
    contexts.set(resolved, created);
    return created;
  };

  const safeInstalledPath = (
    manager: PackageManagerLike,
    source: string,
    scope: "user" | "project",
  ): string | null => {
    try {
      return manager.getInstalledPath(source, scope) ?? null;
    } catch {
      // An untrusted project cannot be inspected; the entry is simply not installed.
      return null;
    }
  };

  const summarize = async (
    manager: PackageManagerLike,
    entry: ConfiguredPackageLike,
  ): Promise<PackageSummary | null> => {
    const parsed = tryParsePackageSource(entry.source);
    if (!parsed) return null;
    const installedPath =
      entry.installedPath ?? safeInstalledPath(manager, entry.source, entry.scope);
    return {
      source: entry.source,
      name: parsed.name,
      kind: parsed.kind as PackageSourceKind,
      scope: entry.scope,
      filtered: entry.filtered,
      version: installedPath ? await readVersion(installedPath) : null,
      pinned: parsed.pinned,
      installedPath,
      installed: installedPath !== null,
    };
  };

  const runWithManager = async <T>(
    manager: PackageManagerLike,
    onProgress: PackageProgressSink | undefined,
    operation: (manager: PackageManagerLike) => Promise<T>,
  ): Promise<T> => {
    const sink = (event: PackageManagerProgress): void => {
      const progress: PackageOperationProgress = {
        action: event.action,
        phase: event.type,
        source: event.source,
        ...(event.message ? { message: event.message } : {}),
      };
      onProgress?.(progress);
    };
    manager.setProgressCallback(sink);
    if (override) {
      process.env[NPM_CAPTURE_LOG_ENV] = logPath;
      // One operation at a time (the handler serialises), so a fresh log makes
      // the failure tail the failing run's output and nothing older.
      await writeFile(logPath, "").catch(() => undefined);
    }
    try {
      return await operation(manager);
    } catch (error) {
      throw packageFailure(
        error,
        override ? await readCaptured(logPath) : null,
        classifyPackageFailure,
      );
    } finally {
      manager.setProgressCallback(undefined);
    }
  };

  return {
    async list(cwd: string | null): Promise<PackageSummary[]> {
      const { manager } = contextFor(cwd);
      let configured: ConfiguredPackageLike[];
      try {
        configured = manager.listConfiguredPackages();
      } catch (error) {
        throw packageFailure(error, null, classifyPackageFailure);
      }
      const summaries: PackageSummary[] = [];
      for (const entry of configured) {
        const summary = await summarize(manager, entry);
        if (summary) summaries.push(summary);
      }
      return summaries;
    },
    async install(source, target: PackageTarget, onProgress): Promise<void> {
      const { manager } = contextFor(target.cwd);
      await runWithManager(manager, onProgress, (current) =>
        current.installAndPersist(source, { local: target.scope === "project" }),
      );
    },

    async remove(source, target: PackageTarget, onProgress): Promise<void> {
      const { manager } = contextFor(target.cwd);
      await runWithManager(manager, onProgress, (current) =>
        current
          .removeAndPersist(source, { local: target.scope === "project" })
          .then(() => undefined),
      );
    },

    async update(source, target: PackageTarget, onProgress): Promise<void> {
      const { manager } = contextFor(target.cwd);
      await runWithManager(manager, onProgress, (current) =>
        source === null ? current.update() : current.update(source),
      );
    },
  };
}

/** Reads the capture log; a missing file is simply no output. */
async function readCaptured(path: string): Promise<string | null> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim().length > 0 ? text : null;
  } catch {
    return null;
  }
}
