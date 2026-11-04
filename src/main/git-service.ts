/**
 * The source-control push service (git-checkpoint plan step 8).
 *
 * `src/git/service.ts` answers questions; this module decides *when* to ask and
 * *when to tell the renderer*. It owns the three behaviours the rail relies on:
 *
 *  1. **Polling only what is watched.** The rail calls `watch(path, true)` while
 *     its Git section is visible and `watch(path, false)` when it closes, so a
 *     hidden panel costs nothing.
 *  2. **Pushing only on change.** A snapshot's `fetchedAt` changes on every read;
 *     the signature deliberately ignores it, so an unchanged repository emits
 *     nothing and the renderer's store does not churn.
 *  3. **Refreshing after an action.** A stage/commit/discard pushes the new
 *     snapshot immediately instead of waiting up to a poll interval.
 *
 * Electron-free (AGENTS rule 1): the window-focus check and the broadcast are
 * injected, exactly as `office/documents-service.ts` injects its probe.
 */

import type { GitService } from "../git/service";
import type {
  GitAction,
  GitActionResult,
  GitCommitEntry,
  GitDiff,
  GitDiffRequest,
  GitLogRequest,
  GitSnapshot,
} from "../shared/git";

/** How often a watched folder is re-read while the window has focus. */
export const DEFAULT_GIT_POLL_MS = 5_000;

export interface GitPushServiceDeps {
  /** The engine (real or fake in tests). */
  git: GitService;
  /** Main → renderer push. */
  emit(snapshot: GitSnapshot): void;
  /** Poll interval in ms. */
  intervalMs?: number;
  /**
   * Whether the window is focused. Polling a background window is wasted work,
   * and the renderer reconciles on focus anyway; a missing port means "always".
   */
  isFocused?: () => boolean;
  now?: () => number;
}

export interface GitPushService {
  /** The last snapshot for a folder (memoised by the engine). Never throws. */
  snapshot(projectPath: string): Promise<GitSnapshot>;
  /** Re-reads now and pushes the result. */
  refresh(projectPath: string): Promise<GitSnapshot>;
  /** Starts/stops the poll for one folder; returns whether it is now watched. */
  watch(projectPath: string, enabled: boolean): boolean;
  /** Runs an action, then refreshes and pushes. */
  action(projectPath: string, action: GitAction): Promise<GitActionResult>;
  diff(projectPath: string, request: GitDiffRequest): Promise<GitDiff>;
  log(projectPath: string, request: GitLogRequest): Promise<GitCommitEntry[]>;
  /** HEAD's full commit message, for the amend box. */
  headMessage(projectPath: string): Promise<string | null>;
  /** Local branch names, for the checkout menu. */
  branches(projectPath: string): Promise<string[]>;
  /** Starts the poll loop (idempotent). */
  start(): void;
  /** Stops the poll loop (idempotent). */
  stop(): void;
  /** Which folders are currently watched (Diagnostics and tests). */
  watched(): string[];
  dispose(): void;
}

/**
 * Everything that means something to the rail, and nothing that does not:
 * `fetchedAt` is excluded on purpose (it changes on every read), and the
 * operation `error` is excluded too, because a failure already pushed its own
 * result and re-pushing it would resurrect a dismissed banner.
 */
function signatureOf(snapshot: GitSnapshot): string {
  return JSON.stringify({
    available: snapshot.available,
    reason: snapshot.reason ?? null,
    message: snapshot.message ?? null,
    repo: snapshot.repo
      ? {
          root: snapshot.repo.root,
          branch: snapshot.repo.branch,
          head: snapshot.repo.head,
          detached: snapshot.repo.detached,
          empty: snapshot.repo.empty,
          upstream: snapshot.repo.upstream,
          ahead: snapshot.repo.ahead,
          behind: snapshot.repo.behind,
          identity: snapshot.repo.identity,
        }
      : null,
    staged: snapshot.staged,
    changed: snapshot.changed,
    truncated: snapshot.truncated,
    totalChanged: snapshot.totalChanged,
    stashes: snapshot.stashes,
  });
}

export function createGitPushService(deps: GitPushServiceDeps): GitPushService {
  const intervalMs = deps.intervalMs ?? DEFAULT_GIT_POLL_MS;
  const now = deps.now ?? ((): number => Date.now());

  /** Watched folders, in the order they were watched. */
  const watchedPaths = new Set<string>();
  /** Last emitted signature per folder. */
  const signatures = new Map<string, string>();
  /** In-flight poll per folder, so a slow repo cannot stack reads. */
  const polling = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;

  const emitIfChanged = (snapshot: GitSnapshot): void => {
    const next = signatureOf(snapshot);
    if (signatures.get(snapshot.projectPath) === next) return;
    signatures.set(snapshot.projectPath, next);
    deps.emit(snapshot);
  };

  const read = async (projectPath: string, fresh: boolean): Promise<GitSnapshot> => {
    const snapshot = await deps.git.snapshot(projectPath, { fresh });
    return { ...snapshot, fetchedAt: new Date(now()).toISOString() };
  };

  const pollOne = async (projectPath: string): Promise<void> => {
    if (polling.has(projectPath)) return;
    polling.add(projectPath);
    try {
      emitIfChanged(await read(projectPath, true));
    } catch {
      // The engine turns failures into values; a throw here is a bug or a
      // cancelled process, and neither should stop the next tick.
    } finally {
      polling.delete(projectPath);
    }
  };

  const schedule = (): void => {
    if (!running || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      const focused = deps.isFocused?.() ?? true;
      const work = focused
        ? Promise.all([...watchedPaths].map((path) => pollOne(path)))
        : Promise.resolve([]);
      void work.finally(schedule);
    }, intervalMs);
    // Do not hold the process open for a timer the user cannot see.
    if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  };

  const refreshAndEmit = async (projectPath: string): Promise<GitSnapshot> => {
    const snapshot = await read(projectPath, true);
    emitIfChanged(snapshot);
    return snapshot;
  };

  return {
    snapshot: (projectPath) => deps.git.snapshot(projectPath),

    refresh: (projectPath) => refreshAndEmit(projectPath),

    watch(projectPath, enabled) {
      if (disposed) return false;
      if (enabled) {
        // A newly watched folder should report its current state at once, not
        // one interval from now.
        if (!watchedPaths.has(projectPath)) {
          watchedPaths.add(projectPath);
          void refreshAndEmit(projectPath);
        }
        return true;
      }
      watchedPaths.delete(projectPath);
      signatures.delete(projectPath);
      return false;
    },

    async action(projectPath, action) {
      const result = await deps.git.action(projectPath, action);
      // Push regardless of the outcome: a refused action can change the snapshot
      // (a locked index, a conflicting checkout) and the rail must show it.
      await refreshAndEmit(projectPath).catch(() => undefined);
      return result;
    },

    diff: (projectPath, request) => deps.git.diff(projectPath, request),

    log: (projectPath, request) => deps.git.log(projectPath, request),

    headMessage: (projectPath) => deps.git.headMessage(projectPath),

    async branches(projectPath) {
      const { local } = await deps.git.branches(projectPath);
      return local;
    },

    start() {
      if (running || disposed) return;
      running = true;
      schedule();
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    watched: () => [...watchedPaths],

    dispose() {
      disposed = true;
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watchedPaths.clear();
      signatures.clear();
      polling.clear();
    },
  };
}
