import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitPushService, DEFAULT_GIT_POLL_MS } from "../../src/main/git-service";
import type { GitService } from "../../src/git/service";
import { emptyGitSnapshot, type GitDiff, type GitSnapshot } from "../../src/shared/git";

/**
 * The source-control push service (git-checkpoint plan step 8).
 *
 * The behaviours worth pinning are the ones a user notices: an unchanged
 * repository must not churn the store, a hidden window must not poll, closing
 * the rail must stop the timer, and an action must push its result immediately
 * instead of waiting for the next tick.
 */

const PROJECT = "/work/app";

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  const base = emptyGitSnapshot(PROJECT);
  return {
    ...base,
    available: true,
    repo: {
      root: PROJECT,
      gitDir: `${PROJECT}/.git`,
      branch: "main",
      head: "abc1234",
      detached: false,
      empty: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      remotes: [],
      identity: { name: "Ada", email: "ada@example.com", source: "global" },
    },
    ...overrides,
  };
}

/** A fake engine: each call returns (and records) whatever the test queues. */
function fakeEngine() {
  const reads: Array<{ projectPath: string; fresh: boolean }> = [];
  const actions: string[] = [];
  let next: GitSnapshot = snapshot();
  let actionResult: { ok: boolean; message?: string } = { ok: true };

  const engine: GitService = {
    async snapshot(projectPath, options) {
      reads.push({ projectPath, fresh: options?.fresh === true });
      return { ...next, projectPath };
    },
    async diff(): Promise<GitDiff> {
      return { scope: "working", files: [], tooLarge: false, truncated: false };
    },
    async log() {
      return [];
    },
    async headMessage() {
      return null;
    },
    async action(_projectPath, action) {
      actions.push(action.kind);
      return { ...actionResult };
    },
    async branches() {
      return { local: [], current: null };
    },
    clearCache() {
      // no cache in the fake
    },
  };

  return {
    engine,
    reads,
    actions,
    setNext(value: GitSnapshot) {
      next = value;
    },
    setActionResult(value: { ok: boolean; message?: string }) {
      actionResult = value;
    },
  };
}

function serviceUnderTest(
  options: { intervalMs?: number; focused?: boolean; emit?: (snapshot: GitSnapshot) => void } = {},
) {
  const fake = fakeEngine();
  const emitted: GitSnapshot[] = [];
  const push = createGitPushService({
    git: fake.engine,
    emit: (value) => {
      emitted.push(value);
      options.emit?.(value);
    },
    intervalMs: options.intervalMs ?? DEFAULT_GIT_POLL_MS,
    isFocused: () => options.focused ?? true,
    now: () => 1_000,
  });
  return { push, fake, emitted };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("change-only emission", () => {
  it("does not emit when only fetchedAt changed", async () => {
    const { push, emitted } = serviceUnderTest();
    await push.refresh(PROJECT);
    await push.refresh(PROJECT);
    expect(emitted).toHaveLength(1);
  });

  it("emits when the branch changes", async () => {
    const { push, fake, emitted } = serviceUnderTest();
    await push.refresh(PROJECT);
    fake.setNext(
      snapshot({
        repo: {
          ...snapshot().repo!,
          branch: "feat/x",
        },
      }),
    );
    await push.refresh(PROJECT);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.repo?.branch).toBe("feat/x");
  });

  it("emits when a file appears", async () => {
    const { push, fake, emitted } = serviceUnderTest();
    await push.refresh(PROJECT);
    fake.setNext(
      snapshot({
        changed: [
          { path: "src/a.ts", origPath: null, status: "modified", staged: false, unstaged: true },
        ],
        totalChanged: 1,
      }),
    );
    await push.refresh(PROJECT);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.changed.map((entry) => entry.path)).toEqual(["src/a.ts"]);
  });

  it("emits an unavailable state once", async () => {
    const { push, fake, emitted } = serviceUnderTest();
    fake.setNext(emptyGitSnapshot(PROJECT, "not_a_repo"));
    await push.refresh(PROJECT);
    await push.refresh(PROJECT);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.reason).toBe("not_a_repo");
  });

  it("does not emit for a plain snapshot read", async () => {
    const { push, emitted } = serviceUnderTest();
    await push.snapshot(PROJECT);
    expect(emitted).toEqual([]);
  });
});

describe("watching", () => {
  it("emits the current state as soon as a folder is watched", async () => {
    const { push, emitted } = serviceUnderTest();
    expect(push.watch(PROJECT, true)).toBe(true);
    // The immediate refresh is fire-and-forget; let it settle.
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(push.watched()).toEqual([PROJECT]);
  });

  it("is idempotent: watching twice does not stack reads", async () => {
    const { push, fake } = serviceUnderTest();
    push.watch(PROJECT, true);
    push.watch(PROJECT, true);
    await vi.waitFor(() => expect(fake.reads.length).toBeGreaterThan(0));
    expect(fake.reads).toHaveLength(1);
  });

  it("stops watching and forgets the signature", async () => {
    const { push, emitted } = serviceUnderTest();
    push.watch(PROJECT, true);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(push.watch(PROJECT, false)).toBe(false);
    expect(push.watched()).toEqual([]);
    // Watching again re-emits, because the signature was forgotten.
    push.watch(PROJECT, true);
    await vi.waitFor(() => expect(emitted).toHaveLength(2));
  });

  it("polls a watched folder and emits only on change", async () => {
    vi.useFakeTimers();
    const { push, fake, emitted } = serviceUnderTest({ intervalMs: 100 });
    push.watch(PROJECT, true);
    push.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted).toHaveLength(1);

    // Two ticks with an unchanged repository: no new emission.
    await vi.advanceTimersByTimeAsync(300);
    expect(emitted).toHaveLength(1);

    // A real change is picked up by the next tick.
    fake.setNext(
      snapshot({
        staged: [
          { path: "src/a.ts", origPath: null, status: "added", staged: true, unstaged: false },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(emitted).toHaveLength(2);

    push.dispose();
  });

  it("does not poll while the window is unfocused", async () => {
    vi.useFakeTimers();
    const { push, fake } = serviceUnderTest({ intervalMs: 100, focused: false });
    push.watch(PROJECT, true);
    push.start();
    const before = fake.reads.length;
    await vi.advanceTimersByTimeAsync(500);
    // Only the watch-time refresh (which is not focus-gated) ran.
    expect(fake.reads.length).toBe(before);
    push.dispose();
  });

  it("stops polling after stop()", async () => {
    vi.useFakeTimers();
    const { push, fake } = serviceUnderTest({ intervalMs: 100 });
    push.watch(PROJECT, true);
    push.start();
    await vi.advanceTimersByTimeAsync(250);
    const before = fake.reads.length;
    push.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.reads.length).toBe(before);
  });

  it("start() is idempotent", async () => {
    vi.useFakeTimers();
    const { push, fake } = serviceUnderTest({ intervalMs: 100 });
    push.watch(PROJECT, true);
    push.start();
    push.start();
    await vi.advanceTimersByTimeAsync(250);
    // One tick's worth of reads, not two overlapping loops.
    expect(fake.reads.length).toBeLessThanOrEqual(3);
    push.dispose();
  });
});

describe("actions", () => {
  it("refreshes and emits after a successful action", async () => {
    const { push, fake, emitted } = serviceUnderTest();
    await push.action(PROJECT, { kind: "stage", paths: ["src/a.ts"] });
    expect(fake.actions).toEqual(["stage"]);
    expect(emitted).toHaveLength(1);
    // The post-action read is a fresh one, not the memo.
    expect(fake.reads.at(-1)?.fresh).toBe(true);
  });

  it("refreshes and emits after a refused action too", async () => {
    const { push, fake, emitted } = serviceUnderTest();
    fake.setActionResult({ ok: false, message: "index.lock" });
    const result = await push.action(PROJECT, { kind: "commit", message: "x", amend: false });
    expect(result.ok).toBe(false);
    // A refused action can still change the snapshot (a locked index), so the
    // rail must be told what the repository looks like now.
    expect(emitted).toHaveLength(1);
  });

  it("returns the engine's result unchanged", async () => {
    const { push, fake } = serviceUnderTest();
    fake.setActionResult({ ok: true, message: "Staged 1 file." });
    const result = await push.action(PROJECT, { kind: "stage", paths: ["a.ts"] });
    expect(result).toEqual({ ok: true, message: "Staged 1 file." });
  });
});

describe("lifecycle", () => {
  it("forgets everything on dispose", async () => {
    const { push } = serviceUnderTest();
    push.watch(PROJECT, true);
    push.start();
    push.dispose();
    expect(push.watched()).toEqual([]);
    // A watch after dispose is refused rather than starting a ghost timer.
    expect(push.watch(PROJECT, true)).toBe(false);
  });

  it("tolerates a read that throws", async () => {
    vi.useFakeTimers();
    const fake = fakeEngine();
    const original = fake.engine.snapshot.bind(fake.engine);
    let calls = 0;
    fake.engine.snapshot = async (...args) => {
      calls += 1;
      if (calls > 1) throw new Error("engine exploded");
      return original(...args);
    };
    const emitted: GitSnapshot[] = [];
    const push = createGitPushService({
      git: fake.engine,
      emit: (value) => emitted.push(value),
      intervalMs: 100,
      now: () => 1_000,
    });
    push.watch(PROJECT, true);
    push.start();
    await vi.advanceTimersByTimeAsync(300);
    // The first read emitted; the throwing ticks were swallowed and the loop
    // kept running.
    expect(emitted).toHaveLength(1);
    expect(calls).toBeGreaterThan(1);
    push.dispose();
  });
});
