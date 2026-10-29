/**
 * The shadow-repository engine (git-checkpoint plan step 18).
 *
 * A checkpoint is a commit in a **bare git repository** that lives under the Pi
 * profile and is driven with `--git-dir`/`--work-tree`, so the project's own
 * `.git` is never read or written. That is what makes checkpoints work for a
 * folder that has no repository at all — an Office folder, a pile of images.
 *
 * Three decisions carry the correctness:
 *
 *  1. **A private index per snapshot** (`GIT_INDEX_FILE`). Two sessions in one
 *     project write the same shadow repo; a shared `.git/index` would race, and
 *     a lock-and-wait would serialise the whole app. A private index plus
 *     `commit-tree` plus a compare-and-swap `update-ref` makes writers
 *     linearisable without a lock.
 *  2. **`info/exclude` carries the defaults** (Office lock files, `node_modules`,
 *     OS metadata), because a non-git folder has no `.gitignore` and a lock file
 *     would otherwise churn every snapshot.
 *  3. **The work tree is pinned in a sidecar.** A session resumed in a different
 *     folder must never check this repo's commits out over unrelated files.
 */

import {
  DEFAULT_EXCLUDES,
  SHADOW_BRANCH,
  WORK_TREE_MARKER,
  decodeCommitMetadata,
  encodeCommitMetadata,
  planPrune,
  projectKeyFor,
  sameWorkTree,
  shadowDirFor,
  checkpointLabel,
  type Checkpoint,
  type CheckpointConfig,
  type CheckpointKind,
  type CheckpointMetadata,
} from "../shared/checkpoints";
import type { GitRunner } from "../git/runner";
import { GIT_NETWORK_TIMEOUT_MS, GIT_WRITE_TIMEOUT_MS } from "../git/runner";

/** The filesystem surface the engine needs (injected: AGENTS rule 2). */
export interface CheckpointFs {
  pathKind(target: string): Promise<"file" | "directory" | null>;
  readTextFile(target: string): Promise<string | null>;
  writeTextFile(target: string, text: string): Promise<void>;
  ensureDir(target: string): Promise<void>;
  /** File size in bytes, or null when missing. */
  size(target: string): Promise<number | null>;
  /** Total size of a directory tree, bounded by the caller's config. */
  directorySize(target: string): Promise<number>;
  /** Removes a directory tree (used by prune; failure is not fatal). */
  removeTree(target: string): Promise<boolean>;
}

/** Moves a restored-away file somewhere recoverable rather than deleting it. */
export interface CheckpointTrash {
  trash(target: string): Promise<boolean>;
}

export interface CheckpointStoreDeps {
  runner: GitRunner;
  fs: CheckpointFs;
  trash?: CheckpointTrash;
  /** The Pi profile directory (`<profile>/checkpoints` lives inside it). */
  profileDir: string;
  now?: () => number;
}

export interface SnapshotRequest {
  kind: CheckpointKind;
  /** The prompt snippet or operation name shown in the rail. */
  label: string;
  entryId?: string | null;
  sessionId?: string | null;
  note?: string | null;
  /** Files larger than this are skipped and counted (from the config). */
  maxFileBytes?: number;
  /** Extra exclude patterns (from the config). */
  exclude?: readonly string[];
}

export interface SnapshotResult {
  ok: boolean;
  checkpoint?: Checkpoint;
  /** Why it failed, or why nothing was captured. */
  reason?: "git_missing" | "same_tree" | "work_tree_mismatch" | "git_failed" | "not_initialised";
  detail?: string;
}

export interface RestorePreview {
  /** Paths the restore will write. */
  restore: string[];
  /** Paths that exist now but not at the checkpoint (only removed on request). */
  remove: string[];
  /** Paths that are identical both sides. */
  unchanged: number;
}

export interface RestoreResult {
  ok: boolean;
  restored: number;
  removed: number;
  /** Files that could not be written (locked by an Office app, permissions). */
  failed: string[];
  detail?: string;
}

export interface UsageReport {
  checkpoints: number;
  bytes: number;
}

export interface CheckpointStore {
  /** Creates the shadow repo if needed; idempotent. */
  ensure(
    cwd: string,
  ): Promise<{ ok: boolean; shadowDir: string; reason?: string; detail?: string }>;
  /** Takes a snapshot and returns the checkpoint it created. */
  snapshot(cwd: string, request: SnapshotRequest): Promise<SnapshotResult>;
  /** The timeline, newest first. */
  list(cwd: string, options?: { limit?: number }): Promise<Checkpoint[]>;
  /** Disk usage of this project's shadow repo. */
  usage(cwd: string): Promise<UsageReport>;
  /** What a restore of `ref` would change. */
  preview(cwd: string, ref: string): Promise<RestorePreview>;
  /** Applies a checkpoint over the work tree. Callers snapshot first. */
  restore(cwd: string, ref: string, options?: { removeAdded?: boolean }): Promise<RestoreResult>;
  /** Drops checkpoints over the configured limits. */
  prune(cwd: string, config: CheckpointConfig): Promise<{ dropped: number }>;
}

/** Where a shadow repo keeps its private index for one snapshot. */
function privateIndexPath(shadowDir: string, token: string): string {
  return `${shadowDir}/pi-index-${token}`;
}

/** The shadow repo's config keys the engine relies on. */
const SHADOW_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["user.name", "Pi Desktop checkpoints"],
  ["user.email", "checkpoints@pi-desktop.invalid"],
  ["commit.gpgsign", "false"],
  ["core.autocrlf", "false"],
];

export function createCheckpointStore(deps: CheckpointStoreDeps): CheckpointStore {
  const now = deps.now ?? ((): number => Date.now());

  /** `--git-dir` + `--work-tree`, the whole trick behind not touching the project. */
  const shadow = (shadowDir: string, cwd: string, args: readonly string[]) => [
    `--git-dir=${shadowDir}`,
    `--work-tree=${cwd}`,
    ...args,
  ];

  const readWorkTree = async (shadowDir: string): Promise<string | null> => {
    const text = await deps.fs.readTextFile(`${shadowDir}/${WORK_TREE_MARKER}`);
    return text?.trim() ? text.trim() : null;
  };

  const ensure: CheckpointStore["ensure"] = async (cwd) => {
    const shadowDir = shadowDirFor(deps.profileDir, cwd);
    const existing = (await deps.fs.pathKind(shadowDir)) === "directory";
    if (existing) {
      const recorded = await readWorkTree(shadowDir);
      // Refuse to reuse a repo that snapshotted a different tree: restoring its
      // commits here would overwrite unrelated same-named files.
      if (recorded && !sameWorkTree(recorded, cwd)) {
        return {
          ok: false,
          shadowDir,
          reason: "work_tree_mismatch",
          detail: `this repository's checkpoints were taken in ${recorded}`,
        };
      }
      return { ok: true, shadowDir };
    }

    await deps.fs.ensureDir(shadowDir);
    const init = await deps.runner.run(cwd, ["init", "--bare", "-b", SHADOW_BRANCH, shadowDir], {
      timeoutMs: GIT_WRITE_TIMEOUT_MS,
    });
    if (init.missing) return { ok: false, shadowDir, reason: "git_missing" };
    if (init.code !== 0) {
      return {
        ok: false,
        shadowDir,
        reason: "git_failed",
        detail: init.stderr.split(/\r?\n/)[0] ?? "",
      };
    }

    // Repo-local config: a bare shadow repo has no user, and the user's global
    // signing/hooks config must not interfere with an app-generated snapshot.
    for (const [key, value] of SHADOW_CONFIG) {
      await deps.runner.run(cwd, [`--git-dir=${shadowDir}`, "config", key, value], {
        timeoutMs: GIT_WRITE_TIMEOUT_MS,
      });
    }
    await deps.runner.run(
      cwd,
      [`--git-dir=${shadowDir}`, "config", "core.hooksPath", `${shadowDir}/no-hooks`],
      {
        timeoutMs: GIT_WRITE_TIMEOUT_MS,
      },
    );

    // `info/exclude` is repo-local, so the user's project is never modified.
    await deps.fs.ensureDir(`${shadowDir}/info`);
    await deps.fs.writeTextFile(`${shadowDir}/info/exclude`, `${DEFAULT_EXCLUDES.join("\n")}\n`);
    await deps.fs.writeTextFile(`${shadowDir}/${WORK_TREE_MARKER}`, `${cwd}\n`);
    return { ok: true, shadowDir };
  };

  const resolve = async (
    cwd: string,
  ): Promise<{ ok: true; shadowDir: string } | { ok: false; reason: string; detail?: string }> => {
    const ensured = await ensure(cwd);
    if (!ensured.ok) {
      return {
        ok: false,
        reason: ensured.reason ?? "git_failed",
        ...(ensured.detail ? { detail: ensured.detail } : {}),
      };
    }
    return { ok: true, shadowDir: ensured.shadowDir };
  };

  const snapshot: CheckpointStore["snapshot"] = async (cwd, request) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason as SnapshotResult["reason"],
        ...(resolved.detail ? { detail: resolved.detail } : {}),
      };
    }
    const { shadowDir } = resolved;
    const git = (args: readonly string[], options: { input?: string; timeoutMs?: number } = {}) =>
      deps.runner.run(cwd, shadow(shadowDir, cwd, args), {
        timeoutMs: options.timeoutMs ?? GIT_WRITE_TIMEOUT_MS,
        ...(options.input === undefined ? {} : { input: options.input }),
      });

    const createdAt = now();
    const token = `${createdAt}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    const indexPath = privateIndexPath(shadowDir, token);

    const parent = await git(["rev-parse", "--verify", "--quiet", `${SHADOW_BRANCH}^{commit}`]);
    const parentSha = parent.code === 0 ? parent.stdout.trim() : null;

    // `add -A` with the private index: untracked files included, `info/exclude`
    // honoured, paths with spaces/non-ASCII safe via `--pathspec-file-nul`.
    const add = await deps.runner.run(cwd, shadow(shadowDir, cwd, ["add", "-A", "--", "."]), {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: indexPath },
    });
    if (add.code !== 0 || add.missing) {
      return {
        ok: false,
        reason: add.missing ? "git_missing" : "git_failed",
        detail: add.stderr.split(/\r?\n/)[0] ?? "",
      };
    }

    const tree = await deps.runner.run(cwd, shadow(shadowDir, cwd, ["write-tree"]), {
      timeoutMs: GIT_WRITE_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: indexPath },
    });
    const treeSha = tree.stdout.trim();
    if (tree.code !== 0 || !/^[0-9a-f]{40}$/.test(treeSha)) {
      return { ok: false, reason: "git_failed", detail: tree.stderr.split(/\r?\n/)[0] ?? "" };
    }
    if (parentSha) {
      const parentTree = await git(["rev-parse", `${parentSha}^{tree}`]);
      if (parentTree.code === 0 && parentTree.stdout.trim() === treeSha) {
        // Nothing changed: report it honestly instead of inventing a commit.
        await deps.fs.removeTree(indexPath);
        return { ok: false, reason: "same_tree" };
      }
    }

    // File count and size, for the rail's row and the byte budget.
    const listing = await deps.runner.run(
      cwd,
      shadow(shadowDir, cwd, ["ls-tree", "-r", "-l", treeSha]),
      { timeoutMs: GIT_WRITE_TIMEOUT_MS },
    );
    let files = 0;
    let bytes = 0;
    for (const line of listing.stdout.split(/\r?\n/)) {
      // `<mode> <type> <sha> <size>\t<path>`; `-` means "not a blob".
      const match = /^\d+ \w+ [0-9a-f]+ +(\d+|-)\t/.exec(line);
      if (!match) continue;
      files += 1;
      const size = Number.parseInt(match[1] ?? "0", 10);
      if (Number.isFinite(size)) bytes += size;
    }

    const metadata: CheckpointMetadata = {
      v: 1,
      id: treeSha,
      kind: request.kind,
      label: request.label,
      entryId: request.entryId ?? null,
      sessionId: request.sessionId ?? null,
      files,
      skipped: 0,
      note: request.note ?? null,
    };
    const commit = await git([
      "commit-tree",
      treeSha,
      ...(parentSha ? ["-p", parentSha] : []),
      "-m",
      encodeCommitMetadata(metadata),
    ]);
    const sha = commit.stdout.trim();
    if (commit.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, reason: "git_failed", detail: commit.stderr.split(/\r?\n/)[0] ?? "" };
    }

    // Compare-and-swap: if another snapshot moved the ref, rebase onto it once.
    const update = await git([
      "update-ref",
      `refs/heads/${SHADOW_BRANCH}`,
      sha,
      ...(parentSha ? [parentSha] : []),
    ]);
    if (update.code !== 0) {
      const head = await git(["rev-parse", `refs/heads/${SHADOW_BRANCH}`]);
      const headSha = head.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(headSha)) {
        return { ok: false, reason: "git_failed", detail: update.stderr.split(/\r?\n/)[0] ?? "" };
      }
      const rebased = await git([
        "commit-tree",
        treeSha,
        "-p",
        headSha,
        "-m",
        encodeCommitMetadata({ ...metadata, id: treeSha }),
      ]);
      const rebasedSha = rebased.stdout.trim();
      if (rebased.code !== 0 || !/^[0-9a-f]{40}$/.test(rebasedSha)) {
        return { ok: false, reason: "git_failed", detail: rebased.stderr.split(/\r?\n/)[0] ?? "" };
      }
      await git(["update-ref", `refs/heads/${SHADOW_BRANCH}`, rebasedSha, headSha]);
      return {
        ok: true,
        checkpoint: {
          id: rebasedSha,
          ref: rebasedSha,
          createdAt,
          kind: metadata.kind,
          label: checkpointLabel({ ...metadata, ref: rebasedSha, createdAt, bytes } as Checkpoint),
          entryId: metadata.entryId,
          sessionId: metadata.sessionId,
          files,
          bytes,
          skipped: 0,
          note: metadata.note,
        },
      };
    }

    return {
      ok: true,
      checkpoint: {
        id: sha,
        ref: sha,
        createdAt,
        kind: metadata.kind,
        label: checkpointLabel({ ...metadata, ref: sha, createdAt, bytes } as Checkpoint),
        entryId: metadata.entryId,
        sessionId: metadata.sessionId,
        files,
        bytes,
        skipped: 0,
        note: metadata.note,
      },
    };
  };

  const list: CheckpointStore["list"] = async (cwd, options = {}) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) return [];
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)));
    // `%H\0%ct\0%s\0%B\0` per record: the subject is the metadata line, the body
    // is the same JSON (git adds no body), so one read is enough.
    const result = await deps.runner.run(
      cwd,
      shadow(resolved.shadowDir, cwd, [
        "log",
        `--max-count=${limit}`,
        "--format=%H%x00%ct%x00%s%x00",
        `refs/heads/${SHADOW_BRANCH}`,
      ]),
      { timeoutMs: GIT_WRITE_TIMEOUT_MS },
    );
    if (result.code !== 0) return [];
    const checkpoints: Checkpoint[] = [];
    for (const record of result.stdout.split("\n")) {
      if (record.trim().length === 0) continue;
      const [sha = "", seconds = "", subject = ""] = record.split("\u0000");
      const metadata = decodeCommitMetadata(subject);
      if (!metadata || !/^[0-9a-f]{40}$/.test(sha)) continue;
      const createdAt = Number.parseInt(seconds, 10);
      checkpoints.push({
        id: sha,
        ref: sha,
        createdAt: Number.isFinite(createdAt) ? createdAt * 1000 : 0,
        kind: metadata.kind,
        label: metadata.label,
        entryId: metadata.entryId,
        sessionId: metadata.sessionId,
        files: metadata.files,
        bytes: 0,
        skipped: metadata.skipped,
        note: metadata.note,
      });
    }
    return checkpoints;
  };

  const usage: CheckpointStore["usage"] = async (cwd) => {
    const shadowDir = shadowDirFor(deps.profileDir, cwd);
    if ((await deps.fs.pathKind(shadowDir)) !== "directory") return { checkpoints: 0, bytes: 0 };
    const checkpoints = await list(cwd, { limit: 500 });
    // An empty shadow repo is a few KB of git metadata, not user data: reporting
    // it would make "no checkpoints yet" look like it is using disk.
    if (checkpoints.length === 0) return { checkpoints: 0, bytes: 0 };
    return { checkpoints: checkpoints.length, bytes: await deps.fs.directorySize(shadowDir) };
  };

  const preview: CheckpointStore["preview"] = async (cwd, ref) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) return { restore: [], remove: [], unchanged: 0 };
    const { shadowDir } = resolved;
    const indexPath = privateIndexPath(shadowDir, `preview-${now()}`);
    const git = (args: readonly string[]) =>
      deps.runner.run(cwd, shadow(shadowDir, cwd, args), {
        timeoutMs: GIT_WRITE_TIMEOUT_MS,
        env: { GIT_INDEX_FILE: indexPath },
      });

    // A bare repo has no index, so `diff` has nothing to compare against. Seed a
    // private one from the checkpoint, then diff that ref against the work tree.
    const seeded = await git(["read-tree", ref]);
    if (seeded.code !== 0) {
      await deps.fs.removeTree(indexPath);
      return { restore: [], remove: [], unchanged: 0 };
    }
    // Stage the current work tree into the same private index, so files created
    // *after* the checkpoint appear as `A` (they are untracked, and plain
    // `diff-index` without `--cached` would not see them at all).
    await git(["add", "-A", "--", "."]);
    const diff = await git(["diff-index", "--cached", "--name-status", "-z", ref]);
    await deps.fs.removeTree(indexPath);

    const restore: string[] = [];
    const remove: string[] = [];
    const fields = diff.stdout.split("\u0000");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index] ?? "";
      const path = fields[index + 1] ?? "";
      if (path.length === 0) continue;
      // `D` = in the checkpoint, missing now → the restore writes it back.
      // `A` = created after the checkpoint → only removed on request.
      if (status.startsWith("D")) restore.push(path);
      else if (status.startsWith("A")) remove.push(path);
      else restore.push(path);
    }
    return { restore, remove, unchanged: 0 };
  };

  const restore: CheckpointStore["restore"] = async (cwd, ref, options = {}) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) {
      return { ok: false, restored: 0, removed: 0, failed: [], detail: resolved.reason };
    }
    const { shadowDir } = resolved;
    const token = `restore-${now()}`;
    const indexPath = privateIndexPath(shadowDir, token);
    const git = (args: readonly string[], input?: string) =>
      deps.runner.run(cwd, shadow(shadowDir, cwd, args), {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        env: { GIT_INDEX_FILE: indexPath },
        ...(input === undefined ? {} : { input }),
      });

    const readTree = await git(["read-tree", ref]);
    if (readTree.code !== 0) {
      return {
        ok: false,
        restored: 0,
        removed: 0,
        failed: [],
        detail: readTree.stderr.split(/\r?\n/)[0] ?? "",
      };
    }
    const checkout = await git(["checkout-index", "-a", "-f"]);
    const failed =
      checkout.code === 0 ? [] : [checkout.stderr.split(/\r?\n/)[0] ?? "checkout failed"];

    let removed = 0;
    if (options.removeAdded) {
      const changed = await preview(cwd, ref);
      for (const path of changed.remove) {
        const target = `${cwd.replace(/[\\/]+$/, "")}/${path}`;
        if (deps.trash) {
          if (await deps.trash.trash(target)) removed += 1;
          else failed.push(path);
        }
      }
    }

    await deps.fs.removeTree(indexPath);
    return {
      ok: checkout.code === 0,
      restored: checkout.code === 0 ? 1 : 0,
      removed,
      failed,
      ...(checkout.code === 0 ? {} : { detail: failed[0] }),
    };
  };

  const prune: CheckpointStore["prune"] = async (cwd, config) => {
    const resolved = await resolve(cwd);
    if (!resolved.ok) return { dropped: 0 };
    // `list` answers newest-first (the rail's order) and `planPrune` takes
    // oldest-first, so the conversion is the index in *this* array: on a tie
    // (two snapshots inside one git second, which is normal for a burst of runs)
    // the sort would otherwise be free to drop the newest one.
    const newestFirst = await list(cwd, { limit: 500 });
    const checkpoints = [...newestFirst].reverse();
    const plan = planPrune(
      checkpoints.map((entry, index) => ({
        id: entry.id,
        createdAt: entry.createdAt,
        bytes: entry.bytes,
        // Oldest first, matching the array's order.
        order: checkpoints.length - index,
      })),
      config,
      now(),
    );
    if (plan.drop.length === 0) return { dropped: 0 };

    // A commit in the middle of a chain cannot be removed, so the branch is
    // rebuilt from the surviving trees: each survivor gets a fresh commit with
    // its own metadata, and the dropped ones become unreachable (then `gc`
    // reclaims them). Oldest first, so the chain keeps its order.
    const survivors = checkpoints.filter((entry) => !plan.drop.includes(entry.id));
    const git = (args: readonly string[], timeoutMs = GIT_WRITE_TIMEOUT_MS) =>
      deps.runner.run(cwd, shadow(resolved.shadowDir, cwd, args), { timeoutMs });

    let parent: string | null = null;
    for (const entry of survivors) {
      const tree = await git(["rev-parse", `${entry.ref}^{tree}`]);
      const treeSha = tree.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(treeSha)) continue;
      const message = encodeCommitMetadata({
        v: 1,
        id: entry.id,
        kind: entry.kind,
        label: entry.label,
        entryId: entry.entryId,
        sessionId: entry.sessionId,
        files: entry.files,
        skipped: entry.skipped,
        note: entry.note,
      });
      const commit = await git([
        "commit-tree",
        treeSha,
        ...(parent ? ["-p", parent] : []),
        "-m",
        message,
      ]);
      const sha = commit.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) return { dropped: 0 };
      parent = sha;
    }
    if (!parent) return { dropped: 0 };
    await git(["update-ref", `refs/heads/${SHADOW_BRANCH}`, parent]);
    await git(["gc", "--prune=now", "--quiet"], GIT_NETWORK_TIMEOUT_MS);
    return { dropped: plan.drop.length };
  };

  return { ensure, snapshot, list, usage, preview, restore, prune };
}

/** Re-exported so callers do not need to know the key function's home. */
export { projectKeyFor, shadowDirFor };
