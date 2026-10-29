import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitRunner } from "../../src/git/runner";
import {
  createCheckpointStore,
  type CheckpointFs,
  type CheckpointStore,
} from "../../src/checkpoints/store";
import { DEFAULT_CHECKPOINT_CONFIG, shadowDirFor } from "../../src/shared/checkpoints";
import { hasGit } from "../git/fixture";

/**
 * The shadow-repository engine (git-checkpoint plan step 18).
 *
 * The work folder here is **not** a git repository — that is the whole point:
 * checkpoints exist for Office folders and image dumps, not just for code. The
 * shadow repo lives under the profile and the project is never modified.
 */

function nodeFs(): CheckpointFs {
  return {
    async pathKind(target) {
      try {
        const info = await stat(target);
        return info.isDirectory() ? "directory" : "file";
      } catch {
        return null;
      }
    },
    async readTextFile(target) {
      try {
        return await readFile(target, "utf8");
      } catch {
        return null;
      }
    },
    async writeTextFile(target, text) {
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, text, "utf8");
    },
    async ensureDir(target) {
      await mkdir(target, { recursive: true });
    },
    async size(target) {
      try {
        return (await stat(target)).size;
      } catch {
        return null;
      }
    },
    async directorySize(target) {
      let total = 0;
      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const child = join(dir, entry.name);
          if (entry.isDirectory()) await walk(child);
          else {
            try {
              total += (await stat(child)).size;
            } catch {
              // A vanished temp file is not a failure of the report.
            }
          }
        }
      };
      await walk(target);
      return total;
    },
    async removeTree(target) {
      try {
        await rm(target, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

let skipReason: string | null = null;
let profileDir: string;
let workDir: string;
let store: CheckpointStore;

beforeEach(async () => {
  skipReason = (await hasGit()) ? null : "git is not installed; the engine tests skip";
  if (skipReason) return;
  const base = await mkdtemp(join(tmpdir(), "pi-checkpoints-"));
  profileDir = join(base, "profile");
  workDir = join(base, "work");
  await mkdir(profileDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  store = createCheckpointStore({
    runner: createNodeGitRunner(),
    fs: nodeFs(),
    profileDir,
    now: () => 1_700_000_000_000,
  });
});

afterEach(async () => {
  if (skipReason) return;
  await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("ensure", () => {
  it("creates a bare shadow repo under the profile and pins the work tree", async () => {
    if (skipReason) return;
    const ensured = await store.ensure(workDir);
    expect(ensured.ok).toBe(true);
    expect(ensured.shadowDir).toBe(shadowDirFor(profileDir, workDir));
    // A bare repo: HEAD exists, no working tree inside the shadow dir.
    expect(await readFile(join(ensured.shadowDir, "HEAD"), "utf8")).toContain("ref:");
    expect(await readFile(join(ensured.shadowDir, "pi-work-tree"), "utf8")).toContain(workDir);
  });

  it("is idempotent", async () => {
    if (skipReason) return;
    const first = await store.ensure(workDir);
    const second = await store.ensure(workDir);
    expect(second.ok).toBe(true);
    expect(second.shadowDir).toBe(first.shadowDir);
  });

  it("leaves the project folder untouched (no .git is created there)", async () => {
    if (skipReason) return;
    await store.ensure(workDir);
    await store.snapshot(workDir, { kind: "manual", label: "first" });
    const names = await readdir(workDir);
    expect(names).not.toContain(".git");
  });
});

describe("snapshot", () => {
  it("captures untracked files, including binary content", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "notes.txt"), "hello\n", "utf8");
    await writeFile(join(workDir, "report.docx"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));

    const result = await store.snapshot(workDir, { kind: "manual", label: "first snapshot" });
    expect(result.ok).toBe(true);
    expect(result.checkpoint?.files).toBeGreaterThanOrEqual(2);
    expect(result.checkpoint?.kind).toBe("manual");
    expect(result.checkpoint?.label).toBe("first snapshot");
  });

  it("honours the default excludes (Office lock files, node_modules)", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "real.txt"), "kept\n", "utf8");
    await writeFile(join(workDir, "~$Report.docx"), "lock\n", "utf8");
    await mkdir(join(workDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workDir, "node_modules", "pkg", "index.js"), "ignored\n", "utf8");

    const result = await store.snapshot(workDir, { kind: "manual", label: "excludes" });
    expect(result.ok).toBe(true);
    // `real.txt` is the only captured file.
    expect(result.checkpoint?.files).toBe(1);
  });

  it("reports same_tree instead of inventing a commit", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "a.txt"), "a\n", "utf8");
    expect((await store.snapshot(workDir, { kind: "manual", label: "one" })).ok).toBe(true);

    const again = await store.snapshot(workDir, { kind: "manual", label: "two" });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("same_tree");
  });

  it("captures a second, different snapshot", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "a.txt"), "a\n", "utf8");
    await store.snapshot(workDir, { kind: "manual", label: "one" });
    await writeFile(join(workDir, "a.txt"), "a changed\n", "utf8");
    const second = await store.snapshot(workDir, { kind: "manual", label: "two" });
    expect(second.ok).toBe(true);
    expect(second.checkpoint?.id).not.toBeUndefined();
  });
});

describe("list and usage", () => {
  it("returns the timeline newest first with its metadata", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "a.txt"), "a\n", "utf8");
    await store.snapshot(workDir, { kind: "manual", label: "first" });
    await writeFile(join(workDir, "a.txt"), "b\n", "utf8");
    await store.snapshot(workDir, { kind: "run", label: "second", entryId: "e1" });

    const checkpoints = await store.list(workDir);
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]?.label).toBe("second");
    expect(checkpoints[0]?.kind).toBe("run");
    expect(checkpoints[0]?.entryId).toBe("e1");
    expect(checkpoints[1]?.label).toBe("first");
  });

  it("reports usage for the shadow repo", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "a.txt"), "a\n", "utf8");
    await store.snapshot(workDir, { kind: "manual", label: "one" });
    const usage = await store.usage(workDir);
    expect(usage.checkpoints).toBe(1);
    expect(usage.bytes).toBeGreaterThan(0);
  });

  it("returns nothing for a folder that was never snapshotted", async () => {
    if (skipReason) return;
    expect(await store.list(workDir)).toEqual([]);
    expect(await store.usage(workDir)).toEqual({ checkpoints: 0, bytes: 0 });
  });
});

describe("preview and restore", () => {
  it("previews what a restore would change", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "keep.txt"), "before\n", "utf8");
    const first = await store.snapshot(workDir, { kind: "manual", label: "one" });
    if (!first.checkpoint) throw new Error("expected a checkpoint");

    await writeFile(join(workDir, "keep.txt"), "after\n", "utf8");
    await writeFile(join(workDir, "added-later.txt"), "new\n", "utf8");

    const preview = await store.preview(workDir, first.checkpoint.ref);
    expect(preview.restore).toContain("keep.txt");
    expect(preview.remove).toContain("added-later.txt");
  });

  it("writes the checkpoint's content back over the folder", async () => {
    if (skipReason) return;
    await writeFile(join(workDir, "keep.txt"), "before\n", "utf8");
    const first = await store.snapshot(workDir, { kind: "manual", label: "one" });
    if (!first.checkpoint) throw new Error("expected a checkpoint");

    await writeFile(join(workDir, "keep.txt"), "after\n", "utf8");
    const restored = await store.restore(workDir, first.checkpoint.ref);
    expect(restored.ok, restored.detail).toBe(true);
    expect(await readFile(join(workDir, "keep.txt"), "utf8")).toBe("before\n");
  });
});

describe("prune", () => {
  it("drops the oldest checkpoint past the count limit but keeps the newest", async () => {
    if (skipReason) return;
    for (let index = 0; index < 3; index += 1) {
      await writeFile(join(workDir, "a.txt"), `value ${index}\n`, "utf8");
      await store.snapshot(workDir, { kind: "manual", label: `snapshot ${index}` });
    }
    expect(await store.list(workDir)).toHaveLength(3);

    const dropped = await store.prune(workDir, {
      ...DEFAULT_CHECKPOINT_CONFIG,
      maxPerSession: 2,
    });
    expect(dropped.dropped).toBe(1);

    const remaining = await store.list(workDir);
    expect(remaining).toHaveLength(2);
    // The newest snapshot is still there.
    expect(remaining[0]?.label).toBe("snapshot 2");
  });
});
