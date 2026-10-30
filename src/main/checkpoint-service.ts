/**
 * The rail's checkpoint backend (git-checkpoint plan step 20).
 *
 * `src/checkpoints/store.ts` answers "snapshot this folder"; this module decides
 * *when* and *how often*, and it is the one place the three capture triggers
 * (D15) meet:
 *
 *  1. **Manual** — the rail's *Snapshot now*.
 *  2. **Pre-op** — the git engine asks for a safety snapshot before a
 *     destructive action (D11), through {@link CheckpointService.snapshotBefore}.
 *  3. **Idle scan** — while an Office pane is attached, a cheap fingerprint of
 *     **the Office host session's folder** is compared every `scanIntervalMs`.
 *     Tool hooks cannot see a Word/Excel save, so this is the only trigger that
 *     covers a document edited outside the app. The bridge publishes a document
 *     *name* and a `url_sha256:` id, never a path, so the host session's cwd is
 *     the only defensible target — and the folder is scanned only when the rail
 *     has actually asked about it (`interested`).
 *
 * Two invariants the rest of the app relies on:
 *
 *  - **Restore is never destructive** (D10): `restore()` always takes a
 *    `pre-restore` checkpoint first and returns its ref, which is what the rail's
 *    one-click Undo restores.
 *  - **One project is never worked on twice at once**: a per-project mutex
 *    serialises snapshot/restore/prune, so a scan cannot interleave with a
 *    restore and take a snapshot of a half-restored tree.
 *
 * Electron-free (AGENTS rule 1), so it joins `CORE_FILES` beside
 * `session-service.ts`: the attached panes, the config and the clock all arrive
 * as injected ports.
 */

import {
  DEFAULT_CHECKPOINT_CONFIG,
  checkpointLabel,
  emptyCheckpointState,
  type CheckpointAction,
  type CheckpointActionResult,
  type CheckpointConfig,
  type CheckpointKind,
  type CheckpointPreviewState,
  type CheckpointState,
  type CheckpointUnavailableReason,
} from "../shared/checkpoints";
import type { OfficeDocumentPane } from "../shared/office-documents";
import type { CheckpointStore } from "../checkpoints/store";

/** How often the idle-scan ticker fires. The per-project interval is the floor. */
export const DEFAULT_SCAN_TICK_MS = 60_000;

/** Below this a scan is pure churn; the config sanitizer enforces the same floor. */
export const MIN_SCAN_INTERVAL_MS = 60_000;

/** The tab statuses that mean "a session is busy in this folder". */
const BUSY_STATUSES = new Set(["starting", "running"]);

export interface CheckpointServiceDeps {
  store: CheckpointStore;
  /**
   * The current config. Re-read on every capture so a Settings change (which
   * rewrites the projected file) applies without restarting main.
   */
  config(): Promise<CheckpointConfig>;
  /** The live Office pane registry (its `panes`, wired from `officeDocuments`). */
  attachedPanes(): readonly OfficeDocumentPane[];
  /** Open session tabs, for the "is this project busy?" question. */
  tabs(): readonly { cwd: string; status: string }[];
  /**
   * The folder the session that owns the Office bridge (port 38617) is working
   * in, or null when no session holds it.
   *
   * The idle scan is restricted to it: a `/health` pane carries no file path, so
   * scanning *every* folder the rail ever asked about meant that opening one
   * workbook started snapshotting unrelated projects. Manual, pre-op and run
   * snapshots are unaffected (they are scoped by the caller).
   */
  officeHostProjectPath?: () => string | null;
  /** Whether run snapshots can arrive at all (safe mode off, host capability). */
  runSnapshots?: () => boolean;
  /** Push a changed state to the renderer. */
  onChange?(state: CheckpointState): void;
  now?: () => number;
  scanTickMs?: number;
  /** The bounded stat walk used by the idle scan. */
  fingerprint?(projectPath: string): Promise<string>;
  /** Safe mode: manual/pre-op snapshots still work, run snapshots do not. */
  safeMode?: () => boolean;
}

export interface CheckpointService {
  /** Hydrates the rail; never throws. */
  get(projectPath: string): Promise<CheckpointState>;
  /** Re-reads the timeline and pushes when something changed. */
  refresh(projectPath: string): Promise<CheckpointState>;
  /** Runs one validated action. */
  action(projectPath: string, action: CheckpointAction): Promise<CheckpointActionResult>;
  /** The `preOpSnapshot` port the git engine calls (D11). */
  snapshotBefore(projectPath: string, note: string): Promise<void>;
  /** One idle-scan pass (public so tests do not need a timer). */
  tick(): Promise<void>;
  /** Starts the scan ticker (idempotent). */
  start(): void;
  /** Stops the scan ticker (idempotent). */
  stop(): void;
  dispose(): void;
}

/** Signature of everything in a state that means something to the rail. */
function signatureOf(state: CheckpointState): string {
  return JSON.stringify({
    available: state.available,
    reason: state.reason ?? null,
    message: state.message ?? null,
    enabled: state.enabled,
    runSnapshots: state.runSnapshots,
    usage: state.usage,
    checkpoints: state.checkpoints.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      createdAt: entry.createdAt,
      files: entry.files,
      entryId: entry.entryId,
    })),
  });
}

/** Why the shadow repo cannot be used, as a rail state. Null means "fine". */
function unavailableReason(reason: string | undefined): CheckpointUnavailableReason | null {
  switch (reason) {
    case "git_missing":
      return "git_missing";
    case "work_tree_mismatch":
      return "work_tree_mismatch";
    case "not_initialised":
    case "git_failed":
      return "unavailable";
    default:
      return null;
  }
}

/** The sentence the rail shows for each reason (D3: never a silent no-op). */
export function describeUnavailable(reason: CheckpointUnavailableReason): string {
  switch (reason) {
    case "git_missing":
      return "Folder checkpoints need git. Install git and make sure it is on your PATH.";
    case "disabled":
      return "Checkpoints are turned off in Settings.";
    case "safe_mode":
      return "Automatic snapshots are off in safe mode. Manual snapshots still work.";
    case "work_tree_mismatch":
      return "These checkpoints were taken in a different folder; refusing to touch this one.";
    case "unavailable":
      return "The checkpoint store could not be read. See Diagnostics for details.";
  }
}

/** Case/separator-insensitive comparison, as `sameWorkTree` does for the store. */
function normalisePath(value: string): string {
  return value
    .replace(/[\\/]+$/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

export function createCheckpointService(deps: CheckpointServiceDeps): CheckpointService {
  const now = deps.now ?? ((): number => Date.now());
  const scanTickMs = Math.max(MIN_SCAN_INTERVAL_MS, deps.scanTickMs ?? DEFAULT_SCAN_TICK_MS);
  const runSnapshots = (): boolean =>
    !(deps.safeMode?.() ?? false) && (deps.runSnapshots?.() ?? false);

  /** Last pushed state per project, so an unchanged read emits nothing. */
  const signatures = new Map<string, string>();
  /** Projects the rail asked about (nothing else is scanned). */
  const interested = new Set<string>();
  /** Tail of the per-project mutex. */
  const locks = new Map<string, Promise<void>>();
  /** Last idle-scan fingerprint and time, per project. */
  const scans = new Map<string, { fingerprint: string; at: number }>();
  /** Coalesced reads, so a poll and a click share one store pass. */
  const inFlight = new Map<string, Promise<CheckpointState>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  /** Serialises all mutation for one project path. */
  const withLock = async <T>(projectPath: string, work: () => Promise<T>): Promise<T> => {
    const previous = locks.get(projectPath) ?? Promise.resolve();
    // A failed predecessor must not break the chain.
    const tail = previous.then(
      () => undefined,
      () => undefined,
    );
    const run = tail.then(work);
    locks.set(
      projectPath,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    try {
      return await run;
    } finally {
      // Drop the entry when this call is the last one in the chain.
      const current = locks.get(projectPath);
      if (current) {
        void current.then(() => {
          if (locks.get(projectPath) === current) locks.delete(projectPath);
        });
      }
    }
  };

  /**
   * Reads one project's surface.
   *
   * `ensure` is the cheap "could this folder be checkpointed at all?" probe: it
   * is idempotent, and it is what distinguishes a folder with no checkpoints
   * yet (a normal first run) from one where git is missing or the shadow repo was
   * built for a different tree — both of which must be *stated*, never shown as
   * an empty timeline (D3). A disabled config skips the probe entirely: there is
   * nothing to be unavailable for.
   */
  const readState = async (projectPath: string): Promise<CheckpointState> => {
    const config = await deps.config().catch(() => DEFAULT_CHECKPOINT_CONFIG);
    if (config.enabled) {
      const ensured = await deps.store.ensure(projectPath);
      const reason = ensured.ok ? null : unavailableReason(ensured.reason);
      if (reason) return degraded(projectPath, reason);
    }
    const usage = await deps.store.usage(projectPath);
    const checkpoints = await deps.store.list(projectPath, { limit: 200 });
    return {
      ...emptyCheckpointState(projectPath, now()),
      enabled: config.enabled,
      checkpoints,
      usage: { ...usage, maxBytes: config.maxBytesPerProject },
      runSnapshots: runSnapshots(),
    };
  };

  const emit = (state: CheckpointState): void => {
    const next = signatureOf(state);
    if (signatures.get(state.projectPath) === next) return;
    signatures.set(state.projectPath, next);
    deps.onChange?.(state);
  };

  const refresh = async (projectPath: string): Promise<CheckpointState> => {
    const state = await readState(projectPath);
    emit(state);
    return state;
  };

  /** Reads once, coalescing a poll and a click into one store pass. */
  const readCoalesced = (projectPath: string): Promise<CheckpointState> => {
    const pending = inFlight.get(projectPath);
    if (pending) return pending;
    const promise = refresh(projectPath).finally(() => inFlight.delete(projectPath));
    inFlight.set(projectPath, promise);
    return promise;
  };

  /** The rail's disabled state for a reason the store reported. */
  const degraded = (projectPath: string, reason: CheckpointUnavailableReason): CheckpointState => ({
    ...emptyCheckpointState(projectPath, now()),
    available: false,
    reason,
    message: describeUnavailable(reason),
  });

  const create = async (
    projectPath: string,
    request: { kind: CheckpointKind; label: string; entryId?: string | null },
  ): Promise<CheckpointActionResult> => {
    const config = await deps.config().catch(() => DEFAULT_CHECKPOINT_CONFIG);
    if (!config.enabled) return { ok: false, error: describeUnavailable("disabled") };
    const result = await deps.store.snapshot(projectPath, {
      kind: request.kind,
      label: request.label,
      entryId: request.entryId ?? null,
      maxFileBytes: config.maxFileBytes,
      exclude: config.exclude,
    });
    if (result.ok) {
      return {
        ok: true,
        message: `Snapshot taken: ${request.label}`,
        ...(result.checkpoint ? { checkpoint: result.checkpoint } : {}),
      };
    }
    if (result.reason === "same_tree") {
      // Not a failure: the folder has not changed since the last checkpoint.
      return {
        ok: true,
        skipped: "same_tree",
        message: "Nothing changed since the last snapshot.",
      };
    }
    const reason = unavailableReason(result.reason);
    if (reason) {
      // Keep git's own detail: "the store could not be read" alone sends the user
      // to Diagnostics for something git already named (a locked index, a full
      // disk, a missing work tree).
      return {
        ok: false,
        error: result.detail
          ? `${describeUnavailable(reason)} (${result.detail})`
          : describeUnavailable(reason),
      };
    }
    return { ok: false, error: result.detail ?? "The snapshot could not be taken." };
  };

  /** Lower-cased names of the files any attached Office pane has open. */
  const openInOffice = (): Set<string> => {
    const names = new Set<string>();
    for (const pane of deps.attachedPanes()) {
      const name = pane.documentName?.trim();
      if (name) names.add(name.toLowerCase());
    }
    return names;
  };

  const previewFor = async (projectPath: string, ref: string): Promise<CheckpointPreviewState> => {
    const preview = await deps.store.preview(projectPath, ref);
    const open = openInOffice();
    const touched = [...preview.restore, ...preview.remove];
    return {
      restore: preview.restore,
      remove: preview.remove,
      // Matched on the file's own name: a pane reports `Report.docx`, never a
      // path, so a folder-relative comparison would never match.
      openInOffice: touched.filter((path) => open.has(path.split("/").pop()?.toLowerCase() ?? "")),
    };
  };

  /** The newest commit in the shadow repo, for the "undo of the undo" ref. */
  const currentRef = async (projectPath: string): Promise<string | undefined> => {
    const checkpoints = await deps.store.list(projectPath, { limit: 1 });
    return checkpoints[0]?.ref;
  };

  const restore = (projectPath: string, ref: string, removeAdded: boolean) =>
    withLock(projectPath, async (): Promise<CheckpointActionResult> => {
      const config = await deps.config().catch(() => DEFAULT_CHECKPOINT_CONFIG);
      if (!config.enabled) return { ok: false, error: describeUnavailable("disabled") };
      // D10: snapshot strictly before any checkout. A pre-restore snapshot that
      // cannot be taken aborts the restore — an undoable restore is the whole
      // point, and a restore that silently lost its undo would be the Zed
      // #28676 failure mode.
      const safety = await deps.store.snapshot(projectPath, {
        kind: "pre-restore",
        label: "Before a restore",
      });
      const undoRef =
        safety.ok && safety.checkpoint ? safety.checkpoint.ref : await currentRef(projectPath);
      if (!safety.ok && safety.reason !== "same_tree") {
        return {
          ok: false,
          error: `A safety snapshot is required before restoring, and it failed: ${
            safety.detail ?? safety.reason ?? "unknown error"
          }`,
        };
      }
      const restored = await deps.store.restore(projectPath, ref, {
        ...(removeAdded ? { removeAdded: true } : {}),
      });
      await refresh(projectPath).catch(() => undefined);
      if (!restored.ok) {
        return {
          ok: false,
          error: restored.detail ?? "The restore could not be applied.",
          ...(undoRef ? { undoRef } : {}),
        };
      }
      const failedNote =
        restored.failed.length > 0
          ? `${restored.failed.length} file(s) could not be written: ${restored.failed
              .slice(0, 3)
              .join(", ")}`
          : undefined;
      return {
        ok: true,
        message:
          restored.removed > 0
            ? `Restored ${ref.slice(0, 8)} and moved ${restored.removed} file(s) to the trash.`
            : `Restored ${ref.slice(0, 8)}.`,
        ...(undoRef ? { undoRef } : {}),
        ...(failedNote ? { error: failedNote } : {}),
      };
    });

  const action = async (
    projectPath: string,
    request: CheckpointAction,
  ): Promise<CheckpointActionResult> => {
    switch (request.kind) {
      case "create": {
        const result = await withLock(projectPath, () =>
          create(projectPath, { kind: "manual", label: request.label ?? "Manual snapshot" }),
        );
        await refresh(projectPath).catch(() => undefined);
        return result;
      }
      case "preview":
        return { ok: true, preview: await previewFor(projectPath, request.ref) };
      case "restore":
        return restore(projectPath, request.ref, request.removeAdded === true);
      case "prune": {
        return withLock(projectPath, async () => {
          const config = await deps.config().catch(() => DEFAULT_CHECKPOINT_CONFIG);
          const result = await deps.store.prune(projectPath, config);
          const state = await refresh(projectPath).catch(() => null);
          return {
            ok: true,
            message:
              result.dropped === 0
                ? "Nothing to prune."
                : `Pruned ${result.dropped} checkpoint(s).`,
            ...(state ? { usage: state.usage } : {}),
          };
        });
      }
      case "usage": {
        const state = await refresh(projectPath);
        return { ok: true, usage: state.usage };
      }
    }
  };

  /** True when a session in this folder is starting or running. */
  const projectBusy = (projectPath: string): boolean => {
    const target = normalisePath(projectPath);
    return deps
      .tabs()
      .some((tab) => normalisePath(tab.cwd) === target && BUSY_STATUSES.has(tab.status));
  };

  return {
    async get(projectPath) {
      interested.add(projectPath);
      return readCoalesced(projectPath);
    },

    refresh,

    action,

    async snapshotBefore(projectPath, note) {
      // A throw aborts the destructive action in the git engine on purpose: a
      // safety snapshot that cannot be taken must not be skipped silently.
      const result = await withLock(projectPath, () =>
        create(projectPath, { kind: "pre-op", label: note }),
      );
      if (result.ok || result.skipped === "same_tree") return;
      throw new Error(result.error ?? "The safety snapshot failed.");
    },

    async tick() {
      if (disposed) return;
      // D15: only folders with an attached Office pane are scanned — the idle
      // scan exists to cover a save the app cannot observe, and a project with
      // no Office document open has no such save.
      if (deps.attachedPanes().length === 0) return;
      const config = await deps.config().catch(() => DEFAULT_CHECKPOINT_CONFIG);
      if (!config.enabled) return;
      // The bridge cannot say which file a pane has open, so the host session's
      // folder is the only target that cannot be wrong. Without a host there is
      // nothing to attribute a save to, and guessing would snapshot a folder
      // nobody is editing.
      const hostPath = deps.officeHostProjectPath?.() ?? null;
      if (!hostPath) return;
      const hostTarget = normalisePath(hostPath);
      for (const projectPath of [...interested]) {
        // A prior `get()` for another folder must not collect "Office documents
        // changed" checkpoints just because a workbook is open somewhere else.
        if (normalisePath(projectPath) !== hostTarget) continue;
        if (projectBusy(projectPath)) continue;
        const previous = scans.get(projectPath);
        if (previous && now() - previous.at < config.scanIntervalMs) continue;
        if (!deps.fingerprint) continue;
        let fingerprint: string;
        try {
          fingerprint = await deps.fingerprint(projectPath);
        } catch {
          continue;
        }
        // The first observation only establishes the baseline: snapshotting on
        // every app start would cost a full tree walk to discover that nothing
        // changed. A change *after* the baseline is what the scan exists to
        // catch, and that is what it reports.
        if (!previous) {
          scans.set(projectPath, { fingerprint, at: now() });
          continue;
        }
        // An unchanged folder only refreshes the clock: the next tick checks
        // again rather than re-walking every minute for nothing.
        if (previous.fingerprint === fingerprint) {
          scans.set(projectPath, { fingerprint, at: now() });
          continue;
        }
        const result = await withLock(projectPath, () =>
          create(projectPath, { kind: "manual", label: "Office documents changed" }),
        );
        scans.set(projectPath, { fingerprint, at: now() });
        if (result.ok && !result.skipped) await refresh(projectPath).catch(() => undefined);
      }
    },

    start() {
      if (timer || disposed) return;
      timer = setInterval(() => {
        void this.tick().catch(() => undefined);
      }, scanTickMs);
      // A background tick must never hold the app open.
      if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
    },

    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },

    dispose() {
      disposed = true;
      this.stop();
      interested.clear();
      signatures.clear();
      scans.clear();
      inFlight.clear();
      locks.clear();
    },
  };
}

/** Re-exported so the rail can label a row without importing the engine. */
export { checkpointLabel };
