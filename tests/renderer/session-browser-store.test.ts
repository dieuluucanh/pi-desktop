import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { CONTROL_TAB_ID } from "../../src/shared/session-ipc";
import type { TabRecord } from "../../src/shared/session-ipc";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * Session browser, tree and tab lifecycle in the renderer store (plan step 11).
 * The main process owns hosts and files; these tests pin what the store asks for,
 * what it keeps and how it reacts to a refusal.
 */

const WORK = "C:\\work\\pi-desktop";

function rawSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: `${WORK}\\sessions\\s1.jsonl`,
    id: "s1",
    cwd: WORK,
    name: "Fix host protocol",
    created: "2026-09-01T00:00:00.000Z",
    modified: "2026-09-02T00:00:00.000Z",
    messageCount: 4,
    firstMessage: "Fix host protocol",
    allMessagesText: "Fix host protocol",
    ...overrides,
  };
}

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: WORK,
    title: "pi-desktop",
    sessionFile: `${WORK}\\sessions\\s1.jsonl`,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

function resetStore(): void {
  useAppStore.setState({
    view: "welcome",
    project: null,
    projects: [],
    projectsLoaded: false,
    trustPrompt: null,
    trustBusy: false,
    sessionTrust: [],
    prefs: { ...DEFAULT_PREFS },
    hint: null,
    tabs: [],
    activeTabId: null,
    transcripts: {},
    sessionStates: {},
    sessionBrowserOpen: false,
    sessionBrowserQuery: "",
    sessionBrowserScope: "all",
    sessionBrowserSort: "recent",
    sessionBrowserNamedOnly: false,
    projectSessionsQuery: null,
    projectSessions: [],
    projectSessionsLoaded: false,
    projectSessionsError: null,
    projectSessionsErrorKind: null,
    projectSessionsSearching: false,
    projectSessionsTotal: 0,
    projectSessionsMatched: 0,
    projectSessionsTruncated: false,
    sessionTreeOpen: false,
    sessionTree: null,
    sessionTreeLeafId: null,
    sessionTreeError: null,
    forkOpen: false,
    forkCandidates: [],
  });
}

beforeEach(() => {
  resetStore();
  vi.restoreAllMocks();
});

describe("session browser", () => {
  it("loads and sanitizes every session of the profile", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({ sessions: [rawSession(), { nope: true }] }));
    (bridge.sessions as unknown as { request: unknown }).request = request;

    await useAppStore.getState().openSessionBrowser();

    expect(request).toHaveBeenCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "session.list",
      params: { query: "", scope: "all", sort: "recent", namedOnly: false },
    });
    const state = useAppStore.getState();
    expect(state.sessionBrowserOpen).toBe(true);
    expect(state.projectSessions).toHaveLength(1);
    expect(state.projectSessions[0]?.name).toBe("Fix host protocol");
    expect(state.projectSessionsLoaded).toBe(true);
    expect(state.projectSessionsSearching).toBe(false);
  });

  it("sends every filter and stores the page metadata", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({
      sessions: [rawSession()],
      total: 12,
      matched: 3,
      truncated: true,
      error: null,
    }));
    (bridge.sessions as unknown as { request: unknown }).request = request;

    await useAppStore.getState().loadProjectSessions({
      query: "deep",
      scope: "current",
      cwd: WORK,
      sort: "relevance",
      namedOnly: true,
      limit: 25,
      refresh: true,
    });

    expect(request).toHaveBeenCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "session.list",
      params: {
        query: "deep",
        scope: "current",
        cwd: WORK,
        sort: "relevance",
        namedOnly: true,
        limit: 25,
        refresh: true,
      },
    });
    expect(useAppStore.getState()).toMatchObject({
      projectSessionsTotal: 12,
      projectSessionsMatched: 3,
      projectSessionsTruncated: true,
      projectSessionsError: null,
      projectSessionsErrorKind: null,
    });
  });

  it("opens on the current project and records the loaded query", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({
      sessions: [],
      total: 0,
      matched: 0,
      truncated: false,
      error: null,
    }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ project: { path: WORK, name: "pi-desktop" } });

    await useAppStore.getState().openSessionBrowser();

    expect(request).toHaveBeenCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "session.list",
      params: { query: "", scope: "current", cwd: WORK, sort: "recent", namedOnly: false },
    });
    expect(useAppStore.getState().sessionBrowserScope).toBe("current");
    expect(useAppStore.getState().projectSessionsQuery).toEqual({
      query: "",
      scope: "current",
      cwd: WORK,
      sort: "recent",
      namedOnly: false,
    });
  });

  it("records the query even when the host fails, so it cannot retry in a loop", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => {
      throw new Error("host is gone");
    });

    await useAppStore.getState().loadProjectSessions({ query: "x", scope: "all" });

    expect(useAppStore.getState().projectSessionsQuery).toEqual({
      query: "x",
      scope: "all",
      cwd: null,
      sort: "recent",
      namedOnly: false,
    });
    expect(useAppStore.getState().projectSessionsErrorKind).toBe("host");
  });

  it("resolves a spilled session.list response through host.blobs.read", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === "session.list") {
        return { $blob: "C:\\blobs\\sessions.json", bytes: 120 };
      }
      if (input.method === "host.blobs.read") {
        return {
          path: "C:\\blobs\\sessions.json",
          contents: JSON.stringify({ sessions: [rawSession()], total: 1, matched: 1 }),
          offset: 0,
          nextOffset: 120,
          size: 120,
          done: true,
        };
      }
      return {};
    });
    (bridge.sessions as unknown as { request: unknown }).request = request;

    await useAppStore.getState().openSessionBrowser();

    expect(useAppStore.getState().projectSessions).toHaveLength(1);
    expect(useAppStore.getState().projectSessions[0]?.name).toBe("Fix host protocol");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "host.blobs.read" }));
  });

  it("records an unreadable response instead of showing an empty profile", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({}));
    useAppStore.setState({
      projectSessions: [
        {
          path: `${WORK}\\sessions\\s1.jsonl`,
          id: "s1",
          cwd: WORK,
          name: "Fix host protocol",
          created: 1,
          modified: 2,
          messageCount: 4,
          firstMessage: "",
          allMessagesText: "",
          parentSessionPath: null,
        },
      ],
    });

    await useAppStore.getState().loadProjectSessions();

    const state = useAppStore.getState();
    expect(state.projectSessionsError).toMatch(/unreadable session list/i);
    expect(state.projectSessionsErrorKind).toBe("host");
    expect(state.projectSessions).toHaveLength(1);
  });

  it("separates a query error from a transport error", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [],
      total: 5,
      matched: 0,
      truncated: false,
      error: "Invalid regular expression",
    }));

    await useAppStore.getState().loadProjectSessions({ query: "re:(" });

    expect(useAppStore.getState()).toMatchObject({
      projectSessions: [],
      projectSessionsError: "Invalid regular expression",
      projectSessionsErrorKind: "query",
      projectSessionsTotal: 5,
      projectSessionsMatched: 0,
    });
  });

  it("ignores an older response that arrives after a newer one", async () => {
    const { bridge } = installBridge();
    const deferred = (): { promise: Promise<unknown>; resolve: (value: unknown) => void } => {
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const firstPage = deferred();
    const secondPage = deferred();
    const request = vi
      .fn()
      .mockImplementationOnce(() => firstPage.promise)
      .mockImplementationOnce(() => secondPage.promise);
    (bridge.sessions as unknown as { request: unknown }).request = request;

    const first = useAppStore.getState().loadProjectSessions({ query: "a" });
    const second = useAppStore.getState().loadProjectSessions({ query: "ab" });
    secondPage.resolve({ sessions: [rawSession({ path: "/p/2.jsonl", id: "2" })] });
    await second;
    firstPage.resolve({ sessions: [rawSession({ path: "/p/1.jsonl", id: "1" })] });
    await first;

    expect(useAppStore.getState().projectSessions.map((session) => session.id)).toEqual(["2"]);
  });

  it("records a listing failure without throwing", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => {
      throw new Error("host is gone");
    });

    await useAppStore.getState().openSessionBrowser();

    expect(useAppStore.getState().projectSessionsError).toBe("host is gone");
  });

  it("resumes a listed session in a new tab and closes the dialog", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();

    await useAppStore.getState().resumeSession(useAppStore.getState().projectSessions[0]!);

    expect(create).toHaveBeenCalledWith({
      cwd: WORK,
      sessionFile: `${WORK}\\sessions\\s1.jsonl`,
    });
    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);
    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it("dismisses the browser before the host has opened the session", async () => {
    const { bridge } = installBridge();
    let release!: (value: { tabs: TabRecord[]; activeTabId: string | null }) => void;
    const pending = new Promise<{ tabs: TabRecord[]; activeTabId: string | null }>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(() => pending);
    (bridge.sessions as unknown as { create: unknown }).create = create;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();

    const run = useAppStore.getState().resumeSession(useAppStore.getState().projectSessions[0]!);
    await Promise.resolve();

    // The host is still loading (the real resume takes 24-28 s), but the pick
    // has already been acknowledged: the dialog must be gone now.
    expect(create).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);

    release({ tabs: [tab()], activeTabId: "tab-1" });
    await run;

    expect(useAppStore.getState().tabs).toHaveLength(1);
  });

  it("keeps the browser closed when the resume fails", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => {
      throw new Error('request "session.resume" timed out after 30000 ms');
    });
    (bridge.sessions as unknown as { create: unknown }).create = create;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();

    await useAppStore.getState().resumeSession(useAppStore.getState().projectSessions[0]!);

    // A rejected create used to skip the close entirely; the hint is the
    // feedback now, and the dialog must not reappear by itself.
    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);
    expect(useAppStore.getState().hint).toBeTruthy();
    expect(useAppStore.getState().tabs).toHaveLength(0);
  });

  it("ignores a second resume of the same file while one is in flight", async () => {
    const { bridge } = installBridge();
    // The bridge wrapper caches the sessions methods when it is first used, so
    // every double must be installed before the first store call.
    const activate = vi.fn(async (tabId: string) => ({
      tabs: useAppStore.getState().tabs,
      activeTabId: tabId,
    }));
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;
    let release!: (value: { tabs: TabRecord[]; activeTabId: string | null }) => void;
    const pending = new Promise<{ tabs: TabRecord[]; activeTabId: string | null }>((resolve) => {
      release = resolve;
    });
    const create = vi
      .fn()
      .mockImplementationOnce(() => pending)
      .mockResolvedValue({ tabs: [tab()], activeTabId: "tab-1" });
    (bridge.sessions as unknown as { create: unknown }).create = create;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();
    const session = useAppStore.getState().projectSessions[0]!;

    const first = useAppStore.getState().resumeSession(session);
    await Promise.resolve();
    await useAppStore.getState().resumeSession(session);

    expect(create).toHaveBeenCalledTimes(1);

    release({ tabs: [tab()], activeTabId: "tab-1" });
    await first;
    // The guard is per in-flight open, never permanent. Once it settles the
    // file is open, so a second pick returns to that tab instead of minting a
    // second host on the same JSONL.
    await useAppStore.getState().resumeSession(session);
    expect(create).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith("tab-1");
  });

  it("returns to the current session instead of opening a second tab", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    const activate = vi.fn(async (tabId: string) => ({
      tabs: useAppStore.getState().tabs,
      activeTabId: tabId,
    }));
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();
    const current = tab({ id: "tab-current", sessionFile: `${WORK}\\sessions\\s1.jsonl` });
    useAppStore.setState({ tabs: [current], activeTabId: current.id });

    await useAppStore.getState().resumeSession(useAppStore.getState().projectSessions[0]!);

    expect(create).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(current.id);
    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);
    expect(useAppStore.getState().activeTabId).toBe(current.id);
  });

  it("returns to a session open in another tab", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    const activate = vi.fn(async (tabId: string) => ({
      tabs: useAppStore.getState().tabs,
      activeTabId: tabId,
    }));
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();
    const active = tab({ id: "tab-active", sessionFile: `${WORK}\\sessions\\other.jsonl` });
    const picked = tab({ id: "tab-picked", sessionFile: `${WORK}\\sessions\\s1.jsonl` });
    useAppStore.setState({ tabs: [active, picked], activeTabId: active.id });

    await useAppStore.getState().resumeSession(useAppStore.getState().projectSessions[0]!);

    expect(create).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(picked.id);
    expect(useAppStore.getState().activeTabId).toBe(picked.id);
  });

  it("activates the tab main reused instead of treating it as new", async () => {
    const { bridge } = installBridge();
    const existing = tab({ id: "tab-existing", sessionFile: `${WORK}\\sessions\\s1.jsonl` });
    const create = vi.fn(async () => ({
      tabs: [existing],
      activeTabId: existing.id,
      reusedTabId: existing.id,
    }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    const activate = vi.fn(async (tabId: string) => ({
      tabs: useAppStore.getState().tabs,
      activeTabId: tabId,
    }));
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();
    // A stale table: main knows a tab the renderer has not been pushed yet.
    useAppStore.setState({ tabs: [], activeTabId: null });

    await useAppStore.getState().resumeSession(useAppStore.getState().projectSessions[0]!);

    expect(create).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(existing.id);
    expect(useAppStore.getState().tabs.map((entry) => entry.id)).toEqual([existing.id]);
    expect(useAppStore.getState().activeTabId).toBe(existing.id);
  });

  it("assigns an already-open session to the requesting pane", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [rawSession()],
    }));
    await useAppStore.getState().openSessionBrowser();
    const open = tab({ id: "tab-open", sessionFile: `${WORK}\\sessions\\s1.jsonl` });
    useAppStore.setState({
      prefs: {
        ...DEFAULT_PREFS,
        grid: { layout: "two", lastMultiLayout: "two", panes: [null, null] },
      },
      tabs: [open],
      activeTabId: open.id,
      panePickerTarget: 1,
    });

    await useAppStore.getState().resumeSession(useAppStore.getState().projectSessions[0]!);

    expect(create).not.toHaveBeenCalled();
    expect(useAppStore.getState().prefs.grid.panes[1]).toBe(open.id);
    expect(useAppStore.getState().panePickerTarget).toBeNull();
  });

  it("continues the most recent session with a one-row query", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    const request = vi.fn(async () => ({
      // The host sorts by recency and applies `limit`, so the page is one row.
      sessions: [
        rawSession({ path: `${WORK}\\b.jsonl`, id: "b", modified: "2026-09-09T00:00:00Z" }),
      ],
      total: 2,
      matched: 1,
      truncated: false,
      error: null,
    }));
    (bridge.sessions as unknown as { request: unknown }).request = request;

    await useAppStore.getState().continueMostRecent(WORK);

    expect(request).toHaveBeenCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "session.list",
      params: {
        query: "",
        scope: "current",
        cwd: WORK,
        sort: "recent",
        namedOnly: false,
        limit: 1,
      },
    });
    expect(create).toHaveBeenCalledWith({ cwd: WORK, sessionFile: `${WORK}\\b.jsonl` });
  });

  it("says so when a project has no saved session", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [],
    }));

    await useAppStore.getState().continueMostRecent(WORK);

    expect(useAppStore.getState().hint).toMatch(/No saved session/);
  });

  it("ignores a second Continue while the newest-row lookup is running", async () => {
    const { bridge } = installBridge();
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const request = vi.fn(() => pending);
    (bridge.sessions as unknown as { request: unknown }).request = request;
    const create = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { create: unknown }).create = create;

    const first = useAppStore.getState().continueMostRecent(WORK);
    await Promise.resolve();
    await useAppStore.getState().continueMostRecent(WORK);

    expect(request).toHaveBeenCalledTimes(1);

    release({ sessions: [rawSession()], total: 1, matched: 1, truncated: false, error: null });
    await first;

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("surfaces a listing error instead of claiming there is no session", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [],
      total: 0,
      matched: 0,
      truncated: false,
      error: "Session search failed.",
    }));
    const create = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { create: unknown }).create = create;

    await useAppStore.getState().continueMostRecent(WORK);

    expect(useAppStore.getState().hint).toBe("Session search failed.");
    expect(create).not.toHaveBeenCalled();
  });

  it("refreshes with the last filters instead of resetting to all sessions", async () => {
    const { bridge } = installBridge();
    const list = vi.fn(async () => ({ sessions: [rawSession()] }));
    (bridge.sessions as unknown as { request: unknown }).request = list;
    (bridge.sessions as unknown as { deleteSession: unknown }).deleteSession = vi.fn(async () => ({
      ok: true,
      path: `${WORK}\\sessions\\s1.jsonl`,
    }));
    useAppStore.setState({
      projectSessionsQuery: {
        query: "x",
        scope: "current",
        cwd: WORK,
        sort: "relevance",
        namedOnly: true,
      },
    });

    const session = {
      path: `${WORK}\\sessions\\s1.jsonl`,
      id: "s1",
      cwd: WORK,
      name: null,
      created: 0,
      modified: 0,
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
      parentSessionPath: null,
    };
    await useAppStore.getState().deleteSession(session);

    expect(list).toHaveBeenLastCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "session.list",
      params: {
        query: "x",
        scope: "current",
        cwd: WORK,
        sort: "relevance",
        namedOnly: true,
        refresh: true,
      },
    });
  });

  it("trashes a session, closes its tabs and refreshes the list", async () => {
    const { bridge } = installBridge();
    const remove = vi.fn(async () => ({ ok: true, path: `${WORK}\\sessions\\s1.jsonl` }));
    (bridge.sessions as unknown as { deleteSession: unknown }).deleteSession = remove;
    const list = vi.fn(async () => ({ sessions: [rawSession()] }));
    (bridge.sessions as unknown as { request: unknown }).request = list;
    const close = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { close: unknown }).close = close;
    useAppStore.setState({ tabs: [tab()], activeTabId: "tab-1" });

    await useAppStore.getState().loadProjectSessions();
    const session = useAppStore.getState().projectSessions[0]!;
    const ok = await useAppStore.getState().deleteSession(session);

    expect(ok).toBe(true);
    expect(remove).toHaveBeenCalledWith(`${WORK}\\sessions\\s1.jsonl`);
    expect(close).toHaveBeenCalledWith("tab-1");
    expect(useAppStore.getState().hint).toMatch(/trash/i);
  });

  it("surfaces a deletion refusal and refreshes the stale row", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { deleteSession: unknown }).deleteSession = vi.fn(async () => ({
      ok: false,
      error: "that session is not part of this profile",
    }));
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [],
    }));

    const session = useAppStore.getState().projectSessions[0] ?? {
      path: "/p/s.jsonl",
      id: "s",
      cwd: WORK,
      name: null,
      created: 0,
      modified: 0,
      messageCount: 0,
      firstMessage: "",
      allMessagesText: "",
      parentSessionPath: null,
    };
    const ok = await useAppStore.getState().deleteSession(session);

    expect(ok).toBe(false);
    expect(useAppStore.getState().hint).toMatch(/not part of this profile/);
  });
});

describe("session tree and forks", () => {
  it("loads the tree and remembers the leaf", async () => {
    const { bridge } = installBridge();
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      tree: [{ entry: { id: "e1" }, children: [] }],
      leafId: "e1",
    }));
    useAppStore.setState({ tabs: [tab()], activeTabId: "tab-1" });

    await useAppStore.getState().openSessionTree("tab-1");

    expect(useAppStore.getState().sessionTreeOpen).toBe(true);
    expect(useAppStore.getState().sessionTreeLeafId).toBe("e1");
  });

  it("navigates a branch, resets the transcript and asks for the history again", async () => {
    const { bridge } = installBridge();
    const calls: string[] = [];
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(
      async (input: { method: string }) => {
        calls.push(input.method);
        if (input.method === "messages.get") return { messages: [] };
        if (input.method === "tree.get") return { tree: [], leafId: "e2" };
        return { cancelled: false, editorText: "draft text" };
      },
    );
    useAppStore.setState({ tabs: [tab()], activeTabId: "tab-1" });

    await useAppStore.getState().navigateTree("tab-1", "e1", { summarize: true });

    expect(calls).toContain("session.navigateTree");
    expect(calls).toContain("messages.get");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("draft text");
    expect(useAppStore.getState().sessionTreeOpen).toBe(false);
  });

  it("loads fork candidates and forks from an entry", async () => {
    const { bridge } = installBridge();
    const fork = vi.fn(async () => ({ cancelled: false }));
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(
      async (input: { method: string }) => {
        if (input.method === "session.forkMessages") {
          return { messages: [{ entryId: "e1", text: "first" }, { text: "no id" }] };
        }
        if (input.method === "session.fork") return fork();
        return { messages: [] };
      },
    );

    await useAppStore.getState().openFork("tab-1");
    expect(useAppStore.getState().forkCandidates).toEqual([{ entryId: "e1", text: "first" }]);

    await useAppStore.getState().forkFrom("tab-1", "e1");
    expect(fork).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().forkOpen).toBe(false);
  });
});

describe("tab lifecycle actions", () => {
  it("closes every other tab through the service", async () => {
    const { bridge } = installBridge();
    const closeOthers = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { closeOthers: unknown }).closeOthers = closeOthers;

    await useAppStore.getState().closeOtherTabs("tab-1");

    expect(closeOthers).toHaveBeenCalledWith("tab-1");
  });

  it("reorders optimistically and confirms through the service", async () => {
    const { bridge } = installBridge();
    const reorder = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { reorder: unknown }).reorder = reorder;
    useAppStore.setState({
      tabs: [tab({ id: "a" }), tab({ id: "b" }), tab({ id: "c" })],
      activeTabId: "a",
    });

    await useAppStore.getState().moveTab("a", 2);

    expect(reorder).toHaveBeenCalledWith("a", 2);
  });

  it("exports a session and reveals the written file", async () => {
    const { bridge } = installBridge();
    const reveal = vi.fn(async () => true);
    (bridge as unknown as { revealPath: unknown }).revealPath = reveal;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      path: "C:\\out\\session.html",
    }));

    await useAppStore.getState().exportSessionHtml("tab-1");

    expect(reveal).toHaveBeenCalledWith("C:\\out\\session.html");
    expect(useAppStore.getState().hint).toMatch(/Exported to/);
  });
});
