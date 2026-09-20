/**
 * Packages: install, update and remove behind a port (plan step 14).
 *
 * The handlers are pure; `DefaultPackageManager` lives in `src/host/sdk/*`. The
 * rules this module enforces, independent of the SDK:
 *
 * - **A source is normalised before anything happens.** A bare name becomes
 *   `npm:name`, because the SDK treats a bare string as a local path; the
 *   normalised string is what is persisted and what the consent echoes.
 * - **Installing and updating require consent.** Extensions run with full system
 *   access, so the caller must echo the exact source it showed the user
 *   (`systemAccess: true`); a missing or stale echo is refused before npm runs.
 * - **Mutations are serialised.** One npm/git operation at a time, so progress
 *   frames cannot interleave and two operations cannot fight over the npm root.
 * - **A failure is actionable.** The thrown error carries the npm output tail
 *   (when the adapter captured one) plus a classified hint.
 */

import type { HostMethod } from "../shared/host-protocol";
import {
  PACKAGES_CHANGED_EVENT,
  PACKAGE_PROGRESS_EVENT,
  isPackageConsent,
  parsePackageSource,
  type PackageAction,
  type PackagePhase,
  type PackageProgressEvent,
  type PackageScope,
  type PackageSummary,
} from "../shared/packages";
import type { HostHandler } from "./service";

export type { PackageProgressEvent, PackageScope, PackageSummary };

/** What a port reports while an operation runs. */
export interface PackageOperationProgress {
  action: PackageAction;
  phase: PackagePhase;
  source: string;
  message?: string;
}

export type PackageProgressSink = (progress: PackageOperationProgress) => void;

/**
 * The package surface, implemented by `src/host/sdk/packages.ts` over Pi's
 * `DefaultPackageManager`. `source` is always normalised by the caller; `null`
 * for `update` means every configured package.
 *
 * `cwd` is the project the operation belongs to (required for project scope,
 * optional for user scope where the host's default cwd stands in).
 */
export interface PackageTarget {
  cwd: string | null;
  scope: PackageScope;
}

export interface PackagePort {
  list(cwd: string | null): Promise<PackageSummary[]>;
  install(source: string, target: PackageTarget, onProgress?: PackageProgressSink): Promise<void>;
  remove(source: string, target: PackageTarget, onProgress?: PackageProgressSink): Promise<void>;
  update(
    source: string | null,
    target: PackageTarget,
    onProgress?: PackageProgressSink,
  ): Promise<void>;
}

/** The control-host methods this module answers (plan step 14). */
export const PACKAGE_METHODS = [
  "packages.list",
  "packages.install",
  "packages.remove",
  "packages.update",
] as const satisfies readonly HostMethod[];

/** Matches the shape the host service turns into an error frame. */
export class PackageError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(message: string, code = "bad_request", data?: unknown) {
    super(message);
    this.name = "PackageError";
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** The update-all target, echoed verbatim in the consent dialog. */
export const UPDATE_ALL_SOURCE = "*";

export interface PackageFailure {
  code: string;
  hint: string | null;
}

/**
 * Turns an npm/git failure into a code and a next step. The patterns are the
 * common npm failure strings; an unrecognised failure keeps its own message and
 * gets no invented hint.
 */
export function classifyPackageFailure(message: string): PackageFailure {
  if (/ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|offline/i.test(message)) {
    return {
      code: "offline",
      hint: "this machine looks offline. Check the connection (or set httpProxy in Settings) and retry.",
    };
  }
  if (/E404|404 Not Found|is not in this registry|No matching version found/i.test(message)) {
    return {
      code: "not_found",
      hint: "the registry has no such package or version. Check the exact name and version.",
    };
  }
  if (
    /E401|E403|401 Unauthorized|403 Forbidden|ENEEDAUTH|authentication|permission denied/i.test(
      message,
    )
  ) {
    return {
      code: "auth",
      hint: "the registry refused the request. Check your npm token and registry settings.",
    };
  }
  if (/ERESOLVE|peer dep|peerDependencies/i.test(message)) {
    return {
      code: "peer_dependency",
      hint: "npm could not resolve peer dependencies. The app installs with --legacy-peer-deps, so the package manifest is likely inconsistent.",
    };
  }
  if (/ENOENT|not recognized as an internal|spawn .* ENOENT/i.test(message)) {
    return {
      code: "runtime_missing",
      hint: "the bundled npm runtime could not be launched. Reinstall Pi Desktop or run the runtime check in Diagnostics.",
    };
  }
  if (/git.*(not found|ENOENT)|spawn git/i.test(message)) {
    return {
      code: "git_missing",
      hint: "installing a Git source needs Git on PATH. Install Git and retry, or use an npm source.",
    };
  }
  return { code: "package_failed", hint: null };
}

/** Wraps a raw port failure into a `PackageError`, adding a hint when known. */
export function toPackageError(error: unknown): PackageError {
  if (error instanceof PackageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const { code, hint } = classifyPackageFailure(message);
  return new PackageError(hint ? `${message}\n\nHint: ${hint}` : message, code);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function requireScope(value: unknown): PackageScope {
  if (value === "project") return "project";
  if (value === undefined || value === null || value === "user") return "user";
  throw new PackageError(`unknown package scope: ${String(value)}`, "bad_request");
}

/**
 * The project an operation belongs to. Project scope without a project is
 * refused here rather than left to npm's cwd (which would silently install into
 * the app's own folder).
 */
function requireCwd(value: unknown, scope: PackageScope): string | null {
  const cwd = typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  if (scope === "project" && cwd === null) {
    throw new PackageError("project scope requires a project folder", "bad_request");
  }
  return cwd;
}

/**
 * A destructive operation needs the caller to echo the source it displayed.
 * `expected` is the normalised source (`*` for update-all), so a stale dialog
 * that showed another package is refused.
 */
function requireConsent(value: unknown, expected: string): void {
  if (!isPackageConsent(value) || value.source !== expected) {
    throw new PackageError(
      "installing or updating a package changes the system and needs confirmation; the request did not carry matching consent.",
      "consent_required",
    );
  }
}

function percentOf(phase: PackagePhase): number | null {
  if (phase === "start") return 0;
  if (phase === "complete") return 100;
  return null;
}

export interface PackageHandlers {
  handlers(): Partial<Record<HostMethod, HostHandler>>;
}

export interface PackageHandlerOptions {
  /** Resolved lazily so a read-only host still lists without a package manager. */
  resolvePort(): PackagePort | null;
  /**
   * Re-reads the shared settings after a mutation, so the app's own settings
   * port (which caches a `SettingsManager`) sees the entry the package manager
   * just persisted. Best effort: an install that succeeded is not failed by it.
   */
  reloadSettings?(cwd: string | null): Promise<void>;
  now?: () => number;
  newId?: () => string;
}

export function createPackageHandlers(options: PackageHandlerOptions): PackageHandlers {
  const now = options.now ?? ((): number => Date.now());
  const newId = options.newId ?? ((): string => `pkg-${Math.random().toString(36).slice(2, 10)}`);

  let queue: Promise<unknown> = Promise.resolve();

  const port = (): PackagePort => {
    const current = options.resolvePort();
    if (!current) {
      throw new PackageError(
        "packages are not available in this host: no package manager is configured",
        "not_implemented",
      );
    }
    return current;
  };

  /** One npm/git operation at a time, in call order. */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const run = async (
    source: string,
    cwd: string | null,
    start: (sink: PackageProgressSink) => Promise<void>,
    emit: (event: string, payload?: unknown) => void,
  ): Promise<{ packages: PackageSummary[]; loadedAt: number }> => {
    const operationId = newId();
    const sink: PackageProgressSink = (progress) => {
      const frame: PackageProgressEvent = {
        operationId,
        action: progress.action,
        phase: progress.phase,
        source: progress.source,
        ...(progress.message ? { message: progress.message } : {}),
        percent: percentOf(progress.phase),
      };
      emit(PACKAGE_PROGRESS_EVENT, frame);
    };

    try {
      await start(sink);
    } catch (error) {
      throw toPackageError(error);
    }

    // The package manager wrote `settings.json` with its own manager; refresh the
    // app's cached one so the hub and the Settings view agree immediately.
    try {
      await options.reloadSettings?.(cwd);
    } catch {
      // A stale settings cache is recoverable; a reported failure here is not.
    }

    const packages = await port().list(cwd);
    const loadedAt = now();
    emit(PACKAGES_CHANGED_EVENT, { packages, loadedAt, source });
    return { packages, loadedAt };
  };

  return {
    handlers: () => ({
      "packages.list": async (params) => {
        const input = asRecord(params);
        // Listing covers both scopes for one project context; no scope is needed.
        const cwd =
          typeof input.cwd === "string" && input.cwd.trim().length > 0 ? input.cwd.trim() : null;
        const packages = await port().list(cwd);
        return { packages, loadedAt: now() };
      },

      "packages.install": async (params, context) => {
        const input = asRecord(params);
        const parsed = parsePackageSource(String(input.source ?? ""));
        requireConsent(input.consent, parsed.source);
        const scope = requireScope(input.scope);
        const cwd = requireCwd(input.cwd, scope);
        return enqueue(() =>
          run(
            parsed.source,
            cwd,
            (sink) => port().install(parsed.source, { cwd, scope }, sink),
            context.emit,
          ),
        );
      },

      "packages.remove": async (params, context) => {
        const input = asRecord(params);
        const parsed = parsePackageSource(String(input.source ?? ""));
        const scope = requireScope(input.scope);
        const cwd = requireCwd(input.cwd, scope);
        return enqueue(() =>
          run(
            parsed.source,
            cwd,
            (sink) => port().remove(parsed.source, { cwd, scope }, sink),
            context.emit,
          ),
        );
      },

      "packages.update": async (params, context) => {
        const input = asRecord(params);
        const raw =
          typeof input.source === "string" && input.source.trim().length > 0 ? input.source : null;
        const parsed = raw === null ? null : parsePackageSource(raw);
        requireConsent(input.consent, parsed ? parsed.source : UPDATE_ALL_SOURCE);
        const scope = requireScope(input.scope);
        const cwd = requireCwd(input.cwd, scope);
        const label = parsed ? parsed.source : UPDATE_ALL_SOURCE;
        return enqueue(() =>
          run(
            label,
            cwd,
            (sink) => port().update(parsed ? parsed.source : null, { cwd, scope }, sink),
            context.emit,
          ),
        );
      },
    }),
  };
}
