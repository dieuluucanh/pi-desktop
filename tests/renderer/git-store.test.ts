import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyGitSnapshot, type GitSnapshot } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The renderer's git slice (git-checkpoint plan step 9).
 *
 * What matters here is the store's bookkeeping rather than git itself: the
 * snapshot map stays bounded, watching is exclusive (a tab switch stops the old
 * folder), an action always refreshes, and a failure is surfaced with its fix
 * instead of being swallowed.
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

function resetStore(): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    git: {},
    gitError: null,
    gitWatched: null,
    gitDiff: null,
    gitDiffLoading: false,
    gitLog: {},
  });
}

beforeEach(() => {
  resetStore();
});

describe("loading snapshots", () => {
  it("applies a snapshot returned by the bridge", async () => {
    installBridge({ git: snapshot() });
    await useAppStore.getState().loadGit(PROJECT);
    const state = useAppStore.getState();
    expect(state.git[PROJECT]?.available).toBe(true);
    expect(state.git[PROJECT]?.repo?.branch).toBe("main");
  });

  it("applies a pushed snapshot from main", () => {
    const handles = installBridge();
    handles.emitGitSnapshot(
      snapshot({
        changed: [
          { path: "src/a.ts", origPath: null, status: "modified", staged: false, unstaged: true },
        ],
        totalChanged: 1,
      }),
    );
    // The emit above reaches no listener until the store subscribes; the store
    // method itself is what App wires to the push.
    useAppStore.getState().applyGitSnapshot(
      snapshot({
        changed: [
          { path: "src/a.ts", origPath: null, status: "modified", staged: false, unstaged: true },
        ],
        totalChanged: 1,
      }),
    );
    expect(useAppStore.getState().git[PROJECT]?.changed.map((entry) => entry.path)).toEqual([
      "src/a.ts",
    ]);
  });

  it("drops an unsafe path from an untrusted payload", () => {
    useAppStore.getState().applyGitSnapshot(
      snapshot({
        changed: [
          {
            path: "../escape.ts",
            origPath: null,
            status: "modified",
            staged: false,
            unstaged: true,
          },
          { path: "ok.ts", origPath: null, status: "modified", staged: false, unstaged: true },
        ],
      }),
    );
    expect(useAppStore.getState().git[PROJECT]?.changed.map((entry) => entry.path)).toEqual([
      "ok.ts",
    ]);
  });

  it("ignores a payload without a project path", () => {
    useAppStore.getState().applyGitSnapshot({ available: true });
    expect(Object.keys(useAppStore.getState().git)).toEqual([]);
  });

  it("surfaces an operation error carried by a snapshot", () => {
    useAppStore.getState().applyGitSnapshot(
      snapshot({
        error: {
          code: "index_locked",
          message: "index.lock exists",
          fix: "Close the other git process.",
          recoverable: true,
        },
      }),
    );
    expect(useAppStore.getState().gitError).toBe("index.lock exists Close the other git process.");
  });

  it("bounds the snapshot map", () => {
    for (let index = 0; index < 7; index += 1) {
      const path = `/work/p${index}`;
      useAppStore.getState().applyGitSnapshot({ ...snapshot(), projectPath: path });
    }
    const keys = Object.keys(useAppStore.getState().git);
    expect(keys).toHaveLength(5);
    // The oldest two were evicted; the newest five remain.
    expect(keys).toEqual(["/work/p2", "/work/p3", "/work/p4", "/work/p5", "/work/p6"]);
  });

  it("refreshes through the refresh channel, not the memoised one", async () => {
    const handles = installBridge({ git: snapshot() });
    await useAppStore.getState().refreshGit(PROJECT);
    expect(handles.gitCalls.map((call) => call.kind)).toEqual(["refresh"]);
  });
});

describe("watching", () => {
  it("watches the requested folder", async () => {
    const handles = installBridge();
    await useAppStore.getState().watchGit(PROJECT);
    expect(useAppStore.getState().gitWatched).toBe(PROJECT);
    expect(handles.gitCalls).toEqual([{ kind: "watch", projectPath: PROJECT, payload: true }]);
  });

  it("stops the previous folder when the target changes", async () => {
    const handles = installBridge();
    await useAppStore.getState().watchGit(PROJECT);
    await useAppStore.getState().watchGit("/work/other");
    expect(handles.gitCalls).toEqual([
      { kind: "watch", projectPath: PROJECT, payload: true },
      { kind: "watch", projectPath: PROJECT, payload: false },
      { kind: "watch", projectPath: "/work/other", payload: true },
    ]);
    expect(useAppStore.getState().gitWatched).toBe("/work/other");
  });

  it("is a no-op when the same folder is already watched", async () => {
    const handles = installBridge();
    await useAppStore.getState().watchGit(PROJECT);
    await useAppStore.getState().watchGit(PROJECT);
    expect(handles.gitCalls).toHaveLength(1);
  });

  it("stops watching when asked for null", async () => {
    const handles = installBridge();
    await useAppStore.getState().watchGit(PROJECT);
    await useAppStore.getState().watchGit(null);
    expect(useAppStore.getState().gitWatched).toBeNull();
    expect(handles.gitCalls.at(-1)).toEqual({
      kind: "watch",
      projectPath: PROJECT,
      payload: false,
    });
  });
});

describe("actions", () => {
  it("refreshes after a successful action and clears the error line", async () => {
    const handles = installBridge({ git: snapshot() });
    useAppStore.setState({ gitError: "stale failure" });
    const result = await useAppStore
      .getState()
      .runGitAction(PROJECT, { kind: "stage", paths: ["src/a.ts"] });
    expect(result.ok).toBe(true);
    expect(useAppStore.getState().gitError).toBeNull();
    // The action itself, then a refresh.
    expect(handles.gitCalls.map((call) => call.kind)).toEqual(["action", "refresh"]);
  });

  it("shows a refused action's message and fix", async () => {
    installBridge({
      gitAction: {
        ok: false,
        error: {
          code: "non_fast_forward",
          message: "Updates were rejected.",
          fix: "Pull first.",
          recoverable: true,
        },
      },
    });
    const result = await useAppStore.getState().runGitAction(PROJECT, { kind: "push" });
    expect(result.ok).toBe(false);
    expect(useAppStore.getState().gitError).toBe("Updates were rejected. Pull first.");
  });

  it("does not refresh after a refused action (main already pushed one)", async () => {
    const handles = installBridge({
      gitAction: { ok: false, error: { code: "conflict", message: "conflict", recoverable: true } },
    });
    await useAppStore
      .getState()
      .runGitAction(PROJECT, { kind: "commit", message: "x", amend: false });
    expect(handles.gitCalls.map((call) => call.kind)).toEqual(["action"]);
  });

  it("reports a bridge that is missing", async () => {
    // `window.pi` persists across tests in one jsdom file; clear it explicitly.
    (window as unknown as { pi?: unknown }).pi = undefined;
    const result = await useAppStore.getState().runGitAction(PROJECT, { kind: "init" });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/bridge is unavailable/);
  });

  it("clears the error line on request", () => {
    useAppStore.setState({ gitError: "boom" });
    useAppStore.getState().clearGitError();
    expect(useAppStore.getState().gitError).toBeNull();
  });
});

describe("diff viewer", () => {
  it("stores the diff with the request that produced it", async () => {
    const handles = installBridge({
      gitDiff: {
        scope: "staged",
        files: [
          {
            path: "src/a.ts",
            origPath: null,
            status: "modified",
            binary: false,
            added: 1,
            removed: 1,
            hunks: [],
          },
        ],
        tooLarge: false,
        truncated: false,
      },
    });
    await useAppStore.getState().openGitDiff(PROJECT, { path: "src/a.ts", staged: true });
    const state = useAppStore.getState();
    expect(state.gitDiff?.request).toEqual({ path: "src/a.ts", staged: true });
    expect(state.gitDiff?.diff.files[0]?.path).toBe("src/a.ts");
    expect(state.gitDiffLoading).toBe(false);
    expect(handles.gitCalls[0]).toEqual({
      kind: "diff",
      projectPath: PROJECT,
      payload: { path: "src/a.ts", staged: true },
    });
  });

  it("closes the viewer", async () => {
    installBridge();
    await useAppStore.getState().openGitDiff(PROJECT, {});
    useAppStore.getState().closeGitDiff();
    expect(useAppStore.getState().gitDiff).toBeNull();
  });
});

describe("commit log", () => {
  const entry = (sha: string) => ({
    sha: sha.repeat(40).slice(0, 40),
    shortSha: sha.repeat(7).slice(0, 7),
    subject: `commit ${sha}`,
    author: "Ada",
    at: 1_700_000_000_000,
    refs: [],
    head: false,
  });

  it("loads the first page", async () => {
    const handles = installBridge({ gitLog: [entry("a")] });
    await useAppStore.getState().loadGitLog(PROJECT);
    const page = useAppStore.getState().gitLog[PROJECT];
    expect(page?.entries).toHaveLength(1);
    expect(page?.loading).toBe(false);
    expect(page?.hasMore).toBe(false);
    expect(handles.gitCalls[0]?.payload).toEqual({ limit: 30 });
  });

  it("marks hasMore when the page is full", async () => {
    const full = Array.from({ length: 30 }, (_, index) => entry(String(index % 10)));
    installBridge({ gitLog: full });
    await useAppStore.getState().loadGitLog(PROJECT);
    expect(useAppStore.getState().gitLog[PROJECT]?.hasMore).toBe(true);
  });

  it("appends the next page with a skip cursor", async () => {
    const handles = installBridge({ gitLog: [entry("a")] });
    // Seed a first page so "load more" has an offset to send.
    useAppStore.setState({
      gitLog: {
        [PROJECT]: { entries: [entry("a"), entry("b")], loading: false, hasMore: true },
      },
    });
    await useAppStore.getState().loadGitLog(PROJECT, { more: true });
    expect(handles.gitCalls[0]?.payload).toEqual({ limit: 30, skip: 2 });
    expect(useAppStore.getState().gitLog[PROJECT]?.entries).toHaveLength(3);
  });

  it("replaces rather than appends on a fresh load", async () => {
    installBridge({ gitLog: [entry("a")] });
    useAppStore.setState({
      gitLog: {
        [PROJECT]: { entries: [entry("z")], loading: false, hasMore: true },
      },
    });
    await useAppStore.getState().loadGitLog(PROJECT);
    const entries = useAppStore.getState().gitLog[PROJECT]?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe("commit a");
  });
});
