import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  DEFAULT_EXCLUDES,
  MAX_EXCLUDE_PATTERNS,
  MIN_SCAN_INTERVAL_MS,
  canRewindCheckpoint,
  checkpointLabel,
  checkpointLink,
  checkpointsRoot,
  decodeCommitMetadata,
  describeRetention,
  encodeCommitMetadata,
  formatBytes,
  planPrune,
  projectKeyFor,
  sameWorkTree,
  sanitizeCheckpointConfig,
  shadowDirFor,
  type Checkpoint,
  type CheckpointMetadata,
  type PruneCandidate,
} from "../../src/shared/checkpoints";

/**
 * The checkpoint model (git-checkpoint plan step 17).
 *
 * Three things must be impossible to get wrong, because they decide what is on
 * disk and what gets deleted: the shadow-repo key must be stable across path
 * spellings, the commit metadata must survive a round trip through `git log`,
 * and pruning must never remove the newest snapshot.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

describe("layout", () => {
  it("puts the shadow root inside the Pi profile", () => {
    expect(checkpointsRoot("/home/ada/.pi/agent")).toBe("/home/ada/.pi/agent/checkpoints");
    expect(checkpointsRoot("/home/ada/.pi/agent/")).toBe("/home/ada/.pi/agent/checkpoints");
  });

  it("keys a project by its name plus a stable hash", () => {
    const key = projectKeyFor("/work/my-app");
    expect(key).toMatch(/^my-app-[0-9a-f]{8}$/);
    // Stable across trailing separators and separator style.
    expect(projectKeyFor("/work/my-app/")).toBe(key);
    expect(projectKeyFor("\\work\\my-app")).toBe(key);
    // Case-sensitive on purpose: two folders differing only by case are two
    // folders on Linux, and the key must not collide.
    expect(projectKeyFor("/work/My-App")).not.toBe(key);
  });

  it("never produces an empty or unsafe key", () => {
    expect(projectKeyFor("/")).toMatch(/^project-[0-9a-f]{8}$/);
    expect(projectKeyFor("/work/..hidden")).toMatch(/^\.\.hidden-[0-9a-f]{8}$/);
    expect(projectKeyFor("/work/spaces here")).toMatch(/^spaces_here-[0-9a-f]{8}$/);
  });

  it("gives two different folders different keys", () => {
    expect(projectKeyFor("/work/a")).not.toBe(projectKeyFor("/work/b"));
    expect(projectKeyFor("/work/a")).not.toBe(projectKeyFor("/other/a"));
  });

  it("builds the shadow dir from the profile and the folder", () => {
    expect(shadowDirFor("/p", "/work/app")).toBe(`/p/checkpoints/${projectKeyFor("/work/app")}`);
  });

  it("compares work trees case- and separator-insensitively", () => {
    expect(sameWorkTree("/work/app", "/work/app/")).toBe(true);
    expect(sameWorkTree("C:\\Work\\App", "c:/work/app")).toBe(true);
    expect(sameWorkTree("/work/app", "/work/other")).toBe(false);
  });
});

describe("config", () => {
  it("returns the defaults for nothing at all", () => {
    expect(sanitizeCheckpointConfig(undefined)).toEqual(DEFAULT_CHECKPOINT_CONFIG);
    expect(sanitizeCheckpointConfig("nope")).toEqual(DEFAULT_CHECKPOINT_CONFIG);
    expect(sanitizeCheckpointConfig([])).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });

  it("is on by default", () => {
    expect(DEFAULT_CHECKPOINT_CONFIG.enabled).toBe(true);
    expect(DEFAULT_CHECKPOINT_CONFIG.maxPerSession).toBe(100);
    expect(DEFAULT_CHECKPOINT_CONFIG.retentionDays).toBe(30);
  });

  it("clamps every numeric limit", () => {
    const config = sanitizeCheckpointConfig({
      maxPerSession: 0,
      retentionDays: 0,
      maxBytesPerProject: 1,
      maxFileBytes: 1,
      scanIntervalMs: 1,
    });
    expect(config.maxPerSession).toBe(1);
    expect(config.retentionDays).toBe(1);
    expect(config.maxBytesPerProject).toBe(64 * 1024 * 1024);
    expect(config.maxFileBytes).toBe(1024 * 1024);
    expect(config.scanIntervalMs).toBe(MIN_SCAN_INTERVAL_MS);
  });

  it("clamps an unbounded value down", () => {
    const config = sanitizeCheckpointConfig({ maxPerSession: 99_999, retentionDays: 99_999 });
    expect(config.maxPerSession).toBe(1000);
    expect(config.retentionDays).toBe(3650);
  });

  it("accepts explicit booleans for `enabled` only", () => {
    expect(sanitizeCheckpointConfig({ enabled: false }).enabled).toBe(false);
    expect(sanitizeCheckpointConfig({ enabled: "no" }).enabled).toBe(true);
  });

  it("filters and bounds the exclude list", () => {
    const config = sanitizeCheckpointConfig({
      exclude: ["*.bak", "  ", 42, "x".repeat(500), ...Array.from({ length: 300 }, () => "y")],
    });
    expect(config.exclude).toContain("*.bak");
    expect(config.exclude).not.toContain("  ");
    expect(config.exclude.length).toBeLessThanOrEqual(MAX_EXCLUDE_PATTERNS);
  });

  it("ships the Office lock-file and build-output excludes", () => {
    expect(DEFAULT_EXCLUDES).toContain("~$*");
    expect(DEFAULT_EXCLUDES).toContain("node_modules/");
    expect(DEFAULT_EXCLUDES).toContain(".DS_Store");
  });

  it("describes the retention policy", () => {
    expect(describeRetention(DEFAULT_CHECKPOINT_CONFIG)).toMatch(/100 per project/);
    expect(describeRetention({ ...DEFAULT_CHECKPOINT_CONFIG, retentionDays: 1 })).toMatch(/1 day/);
  });
});

describe("commit metadata", () => {
  const metadata: CheckpointMetadata = {
    v: 1,
    id: "a".repeat(40),
    kind: "run",
    label: "refactor the rail",
    entryId: "entry-1",
    sessionId: "session-1",
    files: 12,
    skipped: 2,
    note: null,
  };

  it("round-trips through a commit message", () => {
    expect(decodeCommitMetadata(encodeCommitMetadata(metadata))).toEqual(metadata);
  });

  it("stays on one line", () => {
    const encoded = encodeCommitMetadata({ ...metadata, label: "line one\nline two" });
    expect(encoded).not.toContain("\n");
    expect(decodeCommitMetadata(encoded)?.label).toBe("line one line two");
  });

  it("bounds a long label", () => {
    const encoded = encodeCommitMetadata({ ...metadata, label: "x".repeat(1000) });
    expect(decodeCommitMetadata(encoded)?.label.length).toBe(300);
  });

  it("returns null for a foreign commit message", () => {
    expect(decodeCommitMetadata("checkpoint")).toBeNull();
    expect(decodeCommitMetadata("")).toBeNull();
    expect(decodeCommitMetadata("not json at all")).toBeNull();
    expect(decodeCommitMetadata("{}")).toBeNull();
  });

  it("returns null for a future format or a bad kind", () => {
    expect(decodeCommitMetadata(JSON.stringify({ ...metadata, v: 2 }))).toBeNull();
    expect(decodeCommitMetadata(JSON.stringify({ ...metadata, kind: "nope" }))).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const decoded = decodeCommitMetadata(JSON.stringify({ v: 1, id: "x", kind: "manual" }));
    expect(decoded).toEqual({
      v: 1,
      id: "x",
      kind: "manual",
      label: "",
      entryId: null,
      sessionId: null,
      files: 0,
      skipped: 0,
      note: null,
    });
  });
});

describe("planPrune", () => {
  const candidate = (id: string, agoDays: number, bytes = 100): PruneCandidate => ({
    id,
    createdAt: NOW - agoDays * DAY,
    bytes,
  });
  const base = { maxPerSession: 100, retentionDays: 30, maxBytesPerProject: 1_000_000 };

  it("drops nothing when everything fits", () => {
    const plan = planPrune([candidate("a", 1), candidate("b", 2)], base, NOW);
    expect(plan.drop).toEqual([]);
    expect(plan.reclaimedBytes).toBe(0);
  });

  it("drops checkpoints past the age limit", () => {
    const plan = planPrune([candidate("old", 40), candidate("new", 1)], base, NOW);
    expect(plan.drop).toEqual(["old"]);
    expect(plan.reasons.tooOld).toBe(1);
  });

  it("drops the oldest when there are too many", () => {
    const entries = [candidate("a", 5), candidate("b", 4), candidate("c", 3)];
    const plan = planPrune(entries, { ...base, maxPerSession: 2 }, NOW);
    expect(plan.drop).toEqual(["a"]);
    expect(plan.reasons.tooMany).toBe(1);
  });

  it("drops the oldest until the byte budget fits", () => {
    const entries = [candidate("a", 3, 600), candidate("b", 2, 600), candidate("c", 1, 600)];
    const plan = planPrune(entries, { ...base, maxBytesPerProject: 1_300 }, NOW);
    expect(plan.drop).toEqual(["a"]);
    expect(plan.reasons.overBudget).toBe(1);
    expect(plan.reclaimedBytes).toBe(600);
  });

  it("never drops the newest checkpoint, even alone and oversized", () => {
    const plan = planPrune(
      [candidate("only", 1, 9_999_999)],
      { ...base, maxBytesPerProject: 1000 },
      NOW,
    );
    expect(plan.drop).toEqual([]);
    expect(plan.reclaimedBytes).toBe(0);
  });

  it("counts the reasons separately when limits combine", () => {
    const entries = [
      candidate("ancient", 90),
      candidate("old", 40),
      candidate("a", 5),
      candidate("b", 4),
      candidate("c", 1),
    ];
    // The age pass drops two; the *survivors* (a, b, c) then exceed a count of 2,
    // so both limits contribute in one plan.
    const plan = planPrune(entries, { ...base, maxPerSession: 2 }, NOW);
    expect(plan.reasons.tooOld).toBe(2);
    expect(plan.reasons.tooMany).toBe(1);
    expect(plan.drop).toEqual(["ancient", "old", "a"]);
    expect(plan.drop).not.toContain("c");
  });

  it("never drops the newest checkpoint when two share a second", () => {
    // git's `%ct` has one-second resolution, so a burst of runs produces equal
    // `createdAt` values. Without the log-position tie-breaker the sort is free
    // to drop the newest snapshot — the one the user is most likely to restore.
    const entries = [
      { id: "a", createdAt: NOW, bytes: 100, order: 3 },
      { id: "b", createdAt: NOW, bytes: 100, order: 2 },
      { id: "c", createdAt: NOW, bytes: 100, order: 1 },
    ];
    const plan = planPrune(entries, { ...base, maxPerSession: 1 }, NOW);
    expect(plan.drop).toEqual(["c", "b"]);
    expect(plan.drop).not.toContain("a");
  });

  it("keeps a candidate whose order is unknown rather than guessing", () => {
    const plan = planPrune(
      [
        { id: "known", createdAt: NOW, bytes: 100, order: 1 },
        { id: "unknown", createdAt: NOW, bytes: 100 },
      ],
      { ...base, maxPerSession: 1 },
      NOW,
    );
    expect(plan.drop).toEqual(["known"]);
  });

  it("handles an empty list", () => {
    expect(planPrune([], base, NOW)).toEqual({
      drop: [],
      reclaimedBytes: 0,
      reasons: { tooOld: 0, tooMany: 0, overBudget: 0 },
    });
  });
});

describe("presentation", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 1024 * 1.2)).toBe("1.2 GB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });

  it("labels a checkpoint by its kind when it has no label", () => {
    const base: Checkpoint = {
      id: "x",
      ref: "x",
      createdAt: 1,
      kind: "run",
      label: "",
      entryId: null,
      sessionId: null,
      files: 0,
      bytes: 0,
      skipped: 0,
      note: null,
    };
    expect(checkpointLabel({ ...base, label: "my snapshot" })).toBe("my snapshot");
    expect(checkpointLabel(base)).toBe("Before the prompt");
    expect(checkpointLabel({ ...base, kind: "manual" })).toBe("Manual snapshot");
    expect(checkpointLabel({ ...base, kind: "pre-op" })).toBe("Before a destructive action");
    expect(checkpointLabel({ ...base, kind: "pre-restore" })).toBe("Before a restore");
  });
});

/**
 * Session linkage (git-checkpoint plan step 25).
 *
 * One rule decides whether a checkpoint can rewind a conversation, and getting it
 * wrong navigates the user somewhere they did not ask for. So: a run snapshot
 * whose entry id the transcript knows is linked; anything else is not.
 */
describe("checkpointLink", () => {
  const run = { kind: "run" as const, entryId: "e1" };

  it("links a run snapshot whose entry this session has", () => {
    expect(checkpointLink(run, new Set(["e1"]))).toBe("linked");
    expect(checkpointLink(run, { e1: true })).toBe("linked");
  });

  it("reports an ancestor's run as from-before-fork", () => {
    expect(checkpointLink(run, new Set(["other"]))).toBe("from-before-fork");
    expect(checkpointLink(run, {})).toBe("from-before-fork");
  });

  it("treats a manual or safety snapshot as unlinked even with an entry id", () => {
    // The entry id of a manual snapshot would point at a turn it was not taken
    // for; rewinding there would be wrong.
    expect(checkpointLink({ kind: "manual", entryId: "e1" }, new Set(["e1"]))).toBe("unlinked");
    expect(checkpointLink({ kind: "pre-op", entryId: "e1" }, new Set(["e1"]))).toBe("unlinked");
    expect(checkpointLink({ kind: "pre-restore", entryId: null }, new Set(["e1"]))).toBe(
      "unlinked",
    );
  });

  it("is unlinked when the rail has no transcript yet", () => {
    expect(checkpointLink(run, undefined)).toBe("unlinked");
  });

  it("offers conversation rewind only for a linked checkpoint", () => {
    expect(canRewindCheckpoint(run, new Set(["e1"]))).toBe(true);
    expect(canRewindCheckpoint(run, new Set())).toBe(false);
    expect(canRewindCheckpoint({ kind: "manual", entryId: null }, new Set(["e1"]))).toBe(false);
  });
});
