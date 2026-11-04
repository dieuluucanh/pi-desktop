import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { emptyGitSnapshot, type GitActionResult, type GitSnapshot } from "../../src/shared/git";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

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
    gitErrors: {},
    gitSync: {},
    gitWatched: null,
    gitDiff: null,
    gitDiffLoading: false,
    gitLog: {},
  });
}

beforeEach(() => {
  resetStore();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.warning).mockClear();
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
    expect(useAppStore.getState().gitErrors[PROJECT]).toBe(
      "index.lock exists Close the other git process.",
    );
  });

  it("keys a snapshot error by its folder", () => {
    useAppStore.getState().applyGitSnapshot(
      snapshot({
        projectPath: "/work/other",
        error: { code: "index_locked", message: "locked", recoverable: true },
      }),
    );
    expect(useAppStore.getState().gitErrors["/work/other"]).toBe("locked");
    expect(useAppStore.getState().gitErrors[PROJECT]).toBeUndefined();
  });

  it("bounds the error map", () => {
    for (let index = 0; index < 7; index += 1) {
      useAppStore.getState().applyGitSnapshot(
        snapshot({
          projectPath: `/work/p${index}`,
          error: { code: "index_locked", message: `locked ${index}`, recoverable: true },
        }),
      );
    }
    expect(Object.keys(useAppStore.getState().gitErrors)).toHaveLength(5);
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
    useAppStore.setState({ gitErrors: { [PROJECT]: "stale failure" } });
    const result = await useAppStore
      .getState()
      .runGitAction(PROJECT, { kind: "stage", paths: ["src/a.ts"] });
    expect(result.ok).toBe(true);
    expect(useAppStore.getState().gitErrors[PROJECT]).toBeUndefined();
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
    expect(useAppStore.getState().gitErrors[PROJECT]).toBe("Updates were rejected. Pull first.");
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

  it("clears only the folder that succeeded", async () => {
    installBridge({ git: snapshot() });
    useAppStore.setState({ gitErrors: { "/work/other": "boom" } });
    await useAppStore.getState().runGitAction(PROJECT, { kind: "stage", paths: ["src/a.ts"] });
    expect(useAppStore.getState().gitErrors[PROJECT]).toBeUndefined();
    expect(useAppStore.getState().gitErrors["/work/other"]).toBe("boom");
  });

  it("keeps a failure on the folder that produced it", async () => {
    installBridge({
      gitAction: { ok: false, error: { code: "conflict", message: "conflict", recoverable: true } },
    });
    await useAppStore
      .getState()
      .runGitAction("/work/other", { kind: "commit", message: "x", amend: false });
    expect(useAppStore.getState().gitErrors["/work/other"]).toBe("conflict");
    expect(useAppStore.getState().gitErrors[PROJECT]).toBeUndefined();
  });

  it("clears the error line on request", () => {
    useAppStore.setState({ gitErrors: { [PROJECT]: "boom" } });
    useAppStore.getState().clearGitError(PROJECT);
    expect(useAppStore.getState().gitErrors[PROJECT]).toBeUndefined();
  });
});

describe("sync status", () => {
  /** A promise the test resolves by hand, to observe the running phase. */
  function deferred(): {
    promise: Promise<GitActionResult>;
    resolve: (value: GitActionResult) => void;
  } {
    let resolve!: (value: GitActionResult) => void;
    const promise = new Promise<GitActionResult>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("marks a network action running before the bridge answers", async () => {
    const pending = deferred();
    installBridge({ git: snapshot(), gitAction: () => pending.promise });

    const run = useAppStore.getState().runGitAction(PROJECT, { kind: "push" });
    const running = useAppStore.getState().gitSync[PROJECT];
    expect(running?.phase).toBe("running");
    expect(running?.action).toEqual({ kind: "push" });

    pending.resolve({ ok: true, message: "Pushed." });
    await run;
    expect(useAppStore.getState().gitSync[PROJECT]?.phase).toBe("ok");
    expect(useAppStore.getState().gitSync[PROJECT]?.message).toBe("Pushed.");
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith("Pushed.");
  });

  it("records a failure and toasts its message with the fix", async () => {
    installBridge({
      git: snapshot(),
      gitAction: {
        ok: false,
        error: {
          code: "auth_required",
          message: "Authentication failed",
          fix: "Prime the credential helper.",
          recoverable: true,
        },
      },
    });
    const result = await useAppStore.getState().runGitAction(PROJECT, { kind: "push" });
    expect(result.ok).toBe(false);
    const status = useAppStore.getState().gitSync[PROJECT];
    expect(status?.phase).toBe("error");
    expect(status?.message).toBe("Authentication failed Prime the credential helper.");
    expect(useAppStore.getState().gitErrors[PROJECT]).toBe(status?.message);
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
      "Push failed: Authentication failed Prime the credential helper.",
    );
  });

  it("turns a thrown bridge rejection into an error status", async () => {
    installBridge({ git: snapshot(), gitAction: () => Promise.reject(new Error("boom")) });
    await useAppStore.getState().runGitAction(PROJECT, { kind: "fetch", remote: null });
    const status = useAppStore.getState().gitSync[PROJECT];
    expect(status?.phase).toBe("error");
    expect(status?.message).toBe("boom");
    expect(useAppStore.getState().gitErrors[PROJECT]).toBe("boom");
  });

  it("returns the same promise for a second click while one runs", async () => {
    const pending = deferred();
    const handles = installBridge({ git: snapshot(), gitAction: () => pending.promise });
    const first = useAppStore.getState().runGitAction(PROJECT, { kind: "push" });
    const second = useAppStore.getState().runGitAction(PROJECT, { kind: "push" });
    pending.resolve({ ok: true, message: "Pushed." });
    await Promise.all([first, second]);
    expect(handles.gitCalls.filter((call) => call.kind === "action")).toHaveLength(1);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it("does not create a sync status for a mutating action", async () => {
    installBridge({ git: snapshot() });
    await useAppStore.getState().runGitAction(PROJECT, { kind: "stage", paths: ["src/a.ts"] });
    expect(useAppStore.getState().gitSync[PROJECT]).toBeUndefined();
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });

  it("reports a missing bridge as a sync failure", async () => {
    (window as unknown as { pi?: unknown }).pi = undefined;
    await useAppStore.getState().runGitAction(PROJECT, { kind: "fetch", remote: null });
    const status = useAppStore.getState().gitSync[PROJECT];
    expect(status?.phase).toBe("error");
    expect(status?.message).toMatch(/bridge is unavailable/);
  });

  it("clears the sync status on request", () => {
    useAppStore.setState({
      gitSync: {
        [PROJECT]: { action: { kind: "push" }, phase: "ok", message: "Pushed.", at: 1 },
      },
    });
    useAppStore.getState().clearGitSync(PROJECT);
    expect(useAppStore.getState().gitSync[PROJECT]).toBeUndefined();
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
    body: "",
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
        [PROJECT]: {
          entries: [entry("a"), entry("b")],
          loading: false,
          hasMore: true,
          key: null,
          seq: 0,
        },
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
        [PROJECT]: { entries: [entry("z")], loading: false, hasMore: true, key: null, seq: 0 },
      },
    });
    await useAppStore.getState().loadGitLog(PROJECT);
    const entries = useAppStore.getState().gitLog[PROJECT]?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subject).toBe("commit a");
  });

  it("writes the requested key with the page", async () => {
    installBridge({ gitLog: [entry("a")] });
    await useAppStore.getState().loadGitLog(PROJECT, { key: "k1" });
    expect(useAppStore.getState().gitLog[PROJECT]?.key).toBe("k1");
  });

  it("drops a superseded response", async () => {
    installBridge({ gitLog: [entry("a")] });
    const first = useAppStore.getState().loadGitLog(PROJECT, { key: "k1" });
    const second = useAppStore.getState().loadGitLog(PROJECT, { key: "k2" });
    await Promise.all([first, second]);
    expect(useAppStore.getState().gitLog[PROJECT]?.key).toBe("k2");
  });

  it("keeps the key when the read fails", async () => {
    const handles = installBridge({ gitLog: [entry("a")] });
    handles.bridge.git.log = () => Promise.reject(new Error("boom"));
    await useAppStore.getState().loadGitLog(PROJECT, { key: "k1" });
    expect(useAppStore.getState().gitLog[PROJECT]?.key).toBe("k1");
  });
});
