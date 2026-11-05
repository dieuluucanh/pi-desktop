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
const OTHER = "C:\\work\\other";

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
      params: { query: "" },
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

  it("continues the most recent session of a project", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [
        rawSession({ path: `${WORK}\\a.jsonl`, id: "a", modified: "2026-09-01T00:00:00Z" }),
        rawSession({ path: `${WORK}\\b.jsonl`, id: "b", modified: "2026-09-09T00:00:00Z" }),
        rawSession({ path: `${OTHER}\\c.jsonl`, id: "c", cwd: OTHER }),
      ],
    }));

    await useAppStore.getState().continueMostRecent(WORK);

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
