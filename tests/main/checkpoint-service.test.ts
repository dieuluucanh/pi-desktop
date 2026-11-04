import { describe, expect, it, vi } from "vitest";
import {
  createCheckpointService,
  describeUnavailable,
  MIN_SCAN_INTERVAL_MS,
  type CheckpointServiceDeps,
} from "../../src/main/checkpoint-service";
import type { CheckpointStore, RestorePreview, SnapshotRequest } from "../../src/checkpoints/store";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  type Checkpoint,
  type CheckpointConfig,
  type CheckpointState,
} from "../../src/shared/checkpoints";
import type { OfficeDocumentPane } from "../../src/shared/office-documents";

/**
 * The rail's checkpoint backend (git-checkpoint plan step 20).
 *
 * The store is faked here: step 18 already proves the shadow-repo mechanics
 * against real git. What this suite pins is the *policy* that lives above it —
 * when a snapshot happens, that a restore is always undoable, and that one
 * project is never mutated twice at once.
 */

const PROJECT = "/work/reports";
const NOW = 1_700_000_000_000;

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "a".repeat(40),
    ref: "a".repeat(40),
    createdAt: NOW - 1000,
    kind: "manual",
    label: "Manual snapshot",
    entryId: null,
    sessionId: null,
    files: 3,
    bytes: 100,
    skipped: 0,
    note: null,
    ...overrides,
  };
}

interface FakeStore extends CheckpointStore {
  snapshots: SnapshotRequest[];
  /** The folder each snapshot was taken in, parallel to `snapshots`. */
  snapshotCwds: string[];
  restores: { ref: string; removeAdded?: boolean }[];
  pruneCalls: number;
  /** Ordered log of every mutating call, for the ordering/mutex assertions. */
  events: string[];
  entries: Checkpoint[];
  previewResult: RestorePreview;
  snapshotOutcome: (
    request: SnapshotRequest,
    index: number,
  ) => Awaited<ReturnType<CheckpointStore["snapshot"]>>;
}

function fakeStore(overrides: Partial<FakeStore> = {}): FakeStore {
  const events: string[] = [];
  const store: FakeStore = {
    snapshots: [],
    snapshotCwds: [],
    restores: [],
    pruneCalls: 0,
    events,
    entries: [],
    previewResult: { restore: [], remove: [], unchanged: 0 },
    snapshotOutcome: (request, index) => ({
      ok: true,
      checkpoint: checkpoint({
        kind: request.kind,
        label: request.label,
        ref: String(index + 1)
          .repeat(40)
          .slice(0, 40),
        id: String(index + 1)
          .repeat(40)
          .slice(0, 40),
      }),
    }),
    async ensure() {
      return { ok: true, shadowDir: "/profile/checkpoints/reports" };
    },
    async snapshot(cwd, request) {
      store.snapshots.push(request);
      store.snapshotCwds.push(cwd);
      store.events.push(`snapshot:${request.kind}`);
      const index = store.snapshots.length - 1;
      const result = store.snapshotOutcome(request, index);
      if (result.ok && result.checkpoint) store.entries = [result.checkpoint, ...store.entries];
      return result;
    },
    async list() {
      return store.entries;
    },
    async usage() {
      return { checkpoints: store.entries.length, bytes: store.entries.length * 100 };
    },
    async preview() {
      return store.previewResult;
    },
    async restore(_cwd, ref, options) {
      store.restores.push({ ref, ...(options?.removeAdded ? { removeAdded: true } : {}) });
      store.events.push(`restore:${ref.slice(0, 2)}`);
      return { ok: true, restored: 1, removed: options?.removeAdded ? 1 : 0, failed: [] };
    },
    async prune() {
      store.pruneCalls += 1;
      return { dropped: 1 };
    },
    ...overrides,
  };
  return store;
}

function pane(documentName: string): OfficeDocumentPane {
  return {
    host: "word",
    hostLabel: "Word",
    paneId: "p1",
    clientName: null,
    documentId: "doc",
    documentName,
    targetId: "t1",
    focused: true,
    visible: true,
    windows: 1,
    ops: [],
    catalogVersion: null,
    protocolVersion: null,
    opsIgnoredCount: 0,
    connectedAt: NOW,
    lastSeen: NOW,
    model: null,
    provider: null,
    mention: documentName,
  };
}

interface Harness {
  service: ReturnType<typeof createCheckpointService>;
  store: FakeStore;
  emitted: CheckpointState[];
  setConfig(config: Partial<CheckpointConfig>): void;
  setPanes(panes: OfficeDocumentPane[]): void;
  setTabs(tabs: { cwd: string; status: string }[]): void;
  advance(ms: number): void;
}

function harness(overrides: Partial<CheckpointServiceDeps> = {}): Harness {
  const store = (overrides.store as FakeStore | undefined) ?? fakeStore();
  const emitted: CheckpointState[] = [];
  let config: CheckpointConfig = { ...DEFAULT_CHECKPOINT_CONFIG };
  let panes: OfficeDocumentPane[] = [];
  let tabs: { cwd: string; status: string }[] = [{ cwd: PROJECT, status: "idle" }];
  let clock = NOW;

  const service = createCheckpointService({
    store,
    config: async () => config,
    attachedPanes: () => panes,
    tabs: () => tabs,
    // The idle scan is restricted to the Office host's folder, so the harness
    // models a host in PROJECT unless a case says otherwise.
    officeHostProjectPath: () => PROJECT,
    onChange: (state) => emitted.push(state),
    now: () => clock,
    ...overrides,
  });

  return {
    service,
    store,
    emitted,
    setConfig(patch) {
      config = { ...config, ...patch };
    },
    setPanes(next) {
      panes = next;
    },
    setTabs(next) {
      tabs = next;
    },
    advance(ms) {
      clock += ms;
    },
  };
}

describe("get", () => {
  it("hydrates the rail from the store", async () => {
    const h = harness();
    h.store.entries = [checkpoint()];
    const state = await h.service.get(PROJECT);
    expect(state.available).toBe(true);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.usage).toEqual({ checkpoints: 1, bytes: 100, maxBytes: 2 * 1024 ** 3 });
  });

  it("coalesces concurrent reads into one store pass", async () => {
    const h = harness();
    const listSpy = vi.spyOn(h.store, "list");
    await Promise.all([h.service.get(PROJECT), h.service.get(PROJECT), h.service.get(PROJECT)]);
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it("states git_missing instead of pretending the folder is empty", async () => {
    const store = fakeStore({
      async ensure() {
        return { ok: false, shadowDir: "/x", reason: "git_missing" };
      },
    });
    const h = harness({ store });
    const state = await h.service.get(PROJECT);
    expect(state.available).toBe(false);
    expect(state.reason).toBe("git_missing");
    // The sentence is the rail's copy, not a raw spawn error.
    expect(state.message).toBe(describeUnavailable("git_missing"));
  });

  it("states a work-tree mismatch (a profile copied between folders)", async () => {
    const store = fakeStore({
      async ensure() {
        return { ok: false, shadowDir: "/x", reason: "work_tree_mismatch" };
      },
    });
    const state = await harness({ store }).service.get(PROJECT);
    expect(state.reason).toBe("work_tree_mismatch");
  });

  it("does not probe the store when the config disables checkpoints", async () => {
    const h = harness();
    h.setConfig({ enabled: false });
    const ensureSpy = vi.spyOn(h.store, "ensure");
    const state = await h.service.get(PROJECT);
    expect(ensureSpy).not.toHaveBeenCalled();
    expect(state.available).toBe(true);
    expect(state.enabled).toBe(false);
  });

  it("reports runSnapshots false in safe mode but keeps manual work available", async () => {
    const h = harness({ safeMode: () => true, runSnapshots: () => true });
    const state = await h.service.get(PROJECT);
    expect(state.runSnapshots).toBe(false);
    expect(state.available).toBe(true);
  });

  it("reports runSnapshots false for a stale host", async () => {
    const h = harness({ runSnapshots: () => false });
    expect((await h.service.get(PROJECT)).runSnapshots).toBe(false);
  });
});

describe("emission", () => {
  it("pushes only when something the rail renders changed", async () => {
    const h = harness();
    await h.service.get(PROJECT);
    expect(h.emitted).toHaveLength(1);
    // The same store answer, a later clock: no second push.
    h.advance(5000);
    await h.service.refresh(PROJECT);
    expect(h.emitted).toHaveLength(1);
    h.store.entries = [checkpoint({ label: "new" })];
    await h.service.refresh(PROJECT);
    expect(h.emitted).toHaveLength(2);
  });
});

describe("create", () => {
  it("takes a manual snapshot and pushes the new timeline", async () => {
    const h = harness();
    const result = await h.service.action(PROJECT, { kind: "create" });
    expect(result.ok).toBe(true);
    expect(h.store.snapshots[0]).toMatchObject({ kind: "manual", label: "Manual snapshot" });
    expect(result.checkpoint?.kind).toBe("manual");
    expect(h.emitted.at(-1)?.checkpoints).toHaveLength(1);
  });

  it("uses a caller-supplied label", async () => {
    const h = harness();
    await h.service.action(PROJECT, { kind: "create", label: "Before the demo" });
    expect(h.store.snapshots[0]?.label).toBe("Before the demo");
  });

  it("reports same_tree as a normal outcome, not an error", async () => {
    const store = fakeStore({ snapshotOutcome: () => ({ ok: false, reason: "same_tree" }) });
    const h = harness({ store });
    const result = await h.service.action(PROJECT, { kind: "create" });
    expect(result).toMatchObject({ ok: true, skipped: "same_tree" });
  });

  it("refuses when the config disables checkpoints and never touches the store", async () => {
    const h = harness();
    h.setConfig({ enabled: false });
    const snapshotSpy = vi.spyOn(h.store, "snapshot");
    const result = await h.service.action(PROJECT, { kind: "create" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(describeUnavailable("disabled"));
    expect(snapshotSpy).not.toHaveBeenCalled();
  });

  it("passes the configured size cap and excludes to the store", async () => {
    const h = harness();
    h.setConfig({ maxFileBytes: 1024, exclude: ["*.iso"] });
    await h.service.action(PROJECT, { kind: "create" });
    expect(h.store.snapshots[0]).toMatchObject({ maxFileBytes: 1024, exclude: ["*.iso"] });
  });
});

describe("preview", () => {
  it("groups the preview and flags a target an Office pane holds open", async () => {
    const store = fakeStore({
      previewResult: {
        restore: ["Report.docx", "notes.txt"],
        remove: ["scratch.tmp"],
        unchanged: 4,
      },
    });
    const h = harness({ store });
    h.setPanes([pane("Report.docx")]);
    const result = await h.service.action(PROJECT, { kind: "preview", ref: "a".repeat(40) });
    expect(result.preview).toEqual({
      restore: ["Report.docx", "notes.txt"],
      remove: ["scratch.tmp"],
      // Only the file a pane actually has open.
      openInOffice: ["Report.docx"],
    });
  });

  it("matches a nested path against a pane's bare file name", async () => {
    const store = fakeStore({
      previewResult: { restore: ["docs/Q3/Report.docx"], remove: [], unchanged: 0 },
    });
    const h = harness({ store });
    h.setPanes([pane("Report.docx")]);
    const result = await h.service.action(PROJECT, { kind: "preview", ref: "b".repeat(40) });
    expect(result.preview?.openInOffice).toEqual(["docs/Q3/Report.docx"]);
  });
});

describe("restore", () => {
  it("always takes a pre-restore snapshot first (D10) and returns its ref", async () => {
    const h = harness();
    const ref = "c".repeat(40);
    const result = await h.service.action(PROJECT, { kind: "restore", ref });
    // Ordering is the safety argument: the snapshot strictly precedes checkout.
    expect(h.store.events).toEqual(["snapshot:pre-restore", `restore:${ref.slice(0, 2)}`]);
    expect(result.undoRef).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it("aborts when the safety snapshot cannot be taken", async () => {
    const store = fakeStore({
      snapshotOutcome: () => ({ ok: false, reason: "git_failed", detail: "fatal: disk full" }),
    });
    const h = harness({ store });
    const result = await h.service.action(PROJECT, { kind: "restore", ref: "d".repeat(40) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disk full");
    // Nothing was checked out: an undoable restore or none at all.
    expect(h.store.restores).toEqual([]);
  });

  it("proceeds when the safety snapshot is a no-op (same_tree)", async () => {
    const store = fakeStore({ snapshotOutcome: () => ({ ok: false, reason: "same_tree" }) });
    store.entries = [checkpoint({ ref: "e".repeat(40) })];
    const h = harness({ store });
    const result = await h.service.action(PROJECT, { kind: "restore", ref: "d".repeat(40) });
    expect(result.ok).toBe(true);
    // The current tip becomes the undo ref: restoring it returns the folder.
    expect(result.undoRef).toBe("e".repeat(40));
  });

  it("passes removeAdded only when asked", async () => {
    const h = harness();
    await h.service.action(PROJECT, { kind: "restore", ref: "f".repeat(40) });
    await h.service.action(PROJECT, { kind: "restore", ref: "f".repeat(40), removeAdded: true });
    expect(h.store.restores.map((entry) => entry.removeAdded)).toEqual([undefined, true]);
  });

  it("reports files it could not write without failing the whole restore", async () => {
    const store = fakeStore({
      async restore() {
        return { ok: true, restored: 1, removed: 0, failed: ["locked.docx"] };
      },
    });
    const result = await harness({ store }).service.action(PROJECT, {
      kind: "restore",
      ref: "1".repeat(40),
    });
    expect(result.ok).toBe(true);
    expect(result.error).toContain("locked.docx");
  });
});

describe("prune and usage", () => {
  it("prunes through the configured limits", async () => {
    const h = harness();
    h.store.entries = [checkpoint()];
    const result = await h.service.action(PROJECT, { kind: "prune" });
    expect(h.store.pruneCalls).toBe(1);
    expect(result.message).toBe("Pruned 1 checkpoint(s).");
    expect(result.usage).toBeDefined();
  });

  it("says nothing was prunable rather than reporting a fake success", async () => {
    const store = fakeStore({
      async prune() {
        return { dropped: 0 };
      },
    });
    const result = await harness({ store }).service.action(PROJECT, { kind: "prune" });
    expect(result.message).toBe("Nothing to prune.");
  });

  it("answers a usage read without mutating anything", async () => {
    const h = harness();
    const result = await h.service.action(PROJECT, { kind: "usage" });
    expect(result.usage).toEqual({ checkpoints: 0, bytes: 0, maxBytes: 2 * 1024 ** 3 });
    expect(h.store.snapshots).toEqual([]);
  });
});

describe("snapshotBefore (the git engine's pre-op hook)", () => {
  it("takes a pre-op snapshot", async () => {
    const h = harness();
    await h.service.snapshotBefore(PROJECT, "discard 2 file(s)");
    expect(h.store.snapshots[0]).toMatchObject({
      kind: "pre-op",
      label: "discard 2 file(s)",
    });
  });

  it("swallows same_tree: nothing to protect is not a failure", async () => {
    const store = fakeStore({ snapshotOutcome: () => ({ ok: false, reason: "same_tree" }) });
    await expect(
      harness({ store }).service.snapshotBefore(PROJECT, "discard x"),
    ).resolves.toBeUndefined();
  });

  it("throws when the snapshot genuinely failed, so the action is aborted", async () => {
    const store = fakeStore({
      snapshotOutcome: () => ({ ok: false, reason: "git_failed", detail: "index.lock" }),
    });
    await expect(harness({ store }).service.snapshotBefore(PROJECT, "discard x")).rejects.toThrow(
      /index\.lock/,
    );
  });
});

describe("the idle scan (D15)", () => {
  function scanning(overrides: Partial<CheckpointServiceDeps> = {}): Harness {
    const h = harness({
      fingerprint: async () => {
        throw new Error("fingerprint not stubbed");
      },
      scanTickMs: MIN_SCAN_INTERVAL_MS,
      ...overrides,
    });
    return h;
  }

  it("does nothing with no Office pane attached", async () => {
    const h = scanning({ fingerprint: async () => "v1" });
    await h.service.get(PROJECT);
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
  });

  it("establishes a baseline on the first tick, then snapshots a real change", async () => {
    let fingerprint = "v1";
    const h = scanning({ fingerprint: async () => fingerprint });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    // The first observation is the baseline: nothing to report yet.
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
    fingerprint = "v2";
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();
    expect(h.store.snapshots).toHaveLength(1);
    expect(h.store.snapshots[0]?.label).toBe("Office documents changed");
  });

  it("respects scanIntervalMs between scans", async () => {
    let fingerprint = "v1";
    const h = scanning({ fingerprint: async () => fingerprint });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    await h.service.tick();
    fingerprint = "v2";
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();
    expect(h.store.snapshots).toHaveLength(1);
    // A second change inside the interval must wait.
    h.advance(1000);
    fingerprint = "v3";
    await h.service.tick();
    expect(h.store.snapshots).toHaveLength(1);
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();
    expect(h.store.snapshots).toHaveLength(2);
  });

  it("skips while a session in that project is running", async () => {
    const h = scanning({ fingerprint: async () => "v1" });
    h.setPanes([pane("Report.docx")]);
    h.setTabs([{ cwd: PROJECT, status: "running" }]);
    await h.service.get(PROJECT);
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
  });

  it("treats a trailing separator/case difference as the same project", async () => {
    const h = scanning({ fingerprint: async () => "v1" });
    h.setPanes([pane("Report.docx")]);
    h.setTabs([{ cwd: "/work/Reports/", status: "running" }]);
    await h.service.get(PROJECT);
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
  });

  it("does nothing when checkpoints are disabled", async () => {
    const h = scanning({ fingerprint: async () => "v1" });
    h.setPanes([pane("Report.docx")]);
    h.setConfig({ enabled: false });
    await h.service.get(PROJECT);
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
  });

  it("does not churn when the fingerprint is unchanged", async () => {
    const h = scanning({ fingerprint: async () => "same" });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    await h.service.tick();
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
  });

  it("only scans folders the rail asked about", async () => {
    const h = scanning({ fingerprint: async () => "v1" });
    h.setPanes([pane("Report.docx")]);
    // No `get()` for PROJECT: nobody is looking at it.
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
  });

  it("does not snapshot another project the rail merely visited", async () => {
    // The regression this step fixes: opening one workbook used to start
    // collecting "Office documents changed" checkpoints in every folder the rail
    // had ever asked about.
    const other = "/work/unrelated";
    const fingerprints: Record<string, string> = { [PROJECT]: "v1", [other]: "a1" };
    const h = scanning({ fingerprint: async (path) => fingerprints[path] ?? "x" });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    await h.service.get(other);
    // Baseline both.
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);

    // Both folders change; only the host's folder may be captured.
    fingerprints[PROJECT] = "v2";
    fingerprints[other] = "a2";
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();

    expect(h.store.snapshots).toHaveLength(1);
    // The capture happened in the host's folder, not the other one.
    expect(h.store.snapshotCwds).toEqual([PROJECT]);
  });

  it("does nothing when no session owns the Office bridge", async () => {
    const h = scanning({
      fingerprint: async () => "v1",
      officeHostProjectPath: () => null,
    });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);
  });

  it("does nothing when the host works in a different folder", async () => {
    let fingerprint = "v1";
    const h = scanning({
      fingerprint: async () => fingerprint,
      officeHostProjectPath: () => "/work/host-elsewhere",
    });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    await h.service.tick();
    fingerprint = "v2";
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();
    // A pane is attached and this folder changed, but it is not the host's.
    expect(h.store.snapshots).toEqual([]);
  });

  it("matches the host folder through case and separator differences", async () => {
    let fingerprint = "v1";
    const h = scanning({
      fingerprint: async () => fingerprint,
      officeHostProjectPath: () => `${PROJECT.toUpperCase()}/`,
    });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    await h.service.tick();
    fingerprint = "v2";
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();
    expect(h.store.snapshots).toHaveLength(1);
  });
});

describe("the per-project mutex", () => {
  it("serialises a restore against a concurrent snapshot", async () => {
    const events: string[] = [];
    const store = fakeStore({
      async snapshot(_cwd, request) {
        events.push(`snapshot:${request.kind}:start`);
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push(`snapshot:${request.kind}:end`);
        return { ok: true, checkpoint: checkpoint({ kind: request.kind }) };
      },
      async restore(_cwd, ref) {
        events.push(`restore:${ref.slice(0, 2)}:start`);
        events.push(`restore:${ref.slice(0, 2)}:end`);
        return { ok: true, restored: 1, removed: 0, failed: [] };
      },
    });
    const h = harness({ store });
    const ref = "9".repeat(40);
    await Promise.all([
      h.service.action(PROJECT, { kind: "create" }),
      h.service.action(PROJECT, { kind: "restore", ref }),
    ]);
    // No interleaving: the first operation's start and end arrive together.
    expect(events).toEqual([
      "snapshot:manual:start",
      "snapshot:manual:end",
      "snapshot:pre-restore:start",
      "snapshot:pre-restore:end",
      "restore:99:start",
      "restore:99:end",
    ]);
  });

  it("keeps a failure from breaking the chain", async () => {
    let calls = 0;
    const store = fakeStore({
      async snapshot(_cwd, request) {
        calls += 1;
        if (request.kind === "pre-op") throw new Error("boom");
        return { ok: true, checkpoint: checkpoint({ kind: request.kind }) };
      },
    });
    const h = harness({ store });
    await expect(h.service.snapshotBefore(PROJECT, "discard")).rejects.toThrow("boom");
    // The next snapshot still runs.
    const result = await h.service.action(PROJECT, { kind: "create" });
    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("lifecycle", () => {
  it("start/stop are idempotent and dispose stops the ticker", () => {
    const h = harness();
    h.service.start();
    h.service.start();
    h.service.stop();
    h.service.stop();
    h.service.start();
    h.service.dispose();
    // A disposed service never ticks again, even if start is called late.
    h.service.start();
    expect(h.store.snapshots).toEqual([]);
  });
});

/**
 * Config changes apply without a restart (git-checkpoint plan step 27).
 *
 * The service reads the projected config on every capture rather than caching it
 * at construction, which is what lets a Settings change take effect on the next
 * idle-scan tick. Two consequences are pinned here: a disable stops the *next*
 * snapshot, and an enable resumes it — with no service rebuild in between.
 */
describe("a config change applies on the next tick", () => {
  it("stops scanning as soon as the config says disabled", async () => {
    let fingerprint = "v1";
    const h = harness({ fingerprint: async () => fingerprint });
    h.setPanes([pane("Report.docx")]);
    await h.service.get(PROJECT);
    // Baseline.
    await h.service.tick();
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    fingerprint = "v2";
    await h.service.tick();
    expect(h.store.snapshots).toHaveLength(1);

    // The user turns checkpoints off in Settings; no restart, no rebuild.
    h.setConfig({ enabled: false });
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    fingerprint = "v3";
    await h.service.tick();
    expect(h.store.snapshots).toHaveLength(1);
  });

  it("resumes when the config is re-enabled", async () => {
    let fingerprint = "v1";
    const h = harness({ fingerprint: async () => fingerprint });
    h.setPanes([pane("Report.docx")]);
    h.setConfig({ enabled: false });
    await h.service.get(PROJECT);
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    await h.service.tick();
    expect(h.store.snapshots).toEqual([]);

    h.setConfig({ enabled: true });
    fingerprint = "v2";
    await h.service.tick();
    // The first tick after re-enabling establishes its baseline, then a change
    // is what gets captured.
    h.advance(DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs);
    fingerprint = "v3";
    await h.service.tick();
    expect(h.store.snapshots.length).toBeGreaterThan(0);
  });

  it("uses the new size cap and excludes on the very next snapshot", async () => {
    const h = harness();
    await h.service.action(PROJECT, { kind: "create" });
    h.setConfig({ maxFileBytes: 4096, exclude: ["*.iso"] });
    await h.service.action(PROJECT, { kind: "create" });
    expect(h.store.snapshots[1]).toMatchObject({ maxFileBytes: 4096, exclude: ["*.iso"] });
  });
});
