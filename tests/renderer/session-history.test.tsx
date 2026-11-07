import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { normalizeSessionListQuery, type SessionSummary } from "../../src/shared/session-browser";
import { ForkDialog } from "../../src/renderer/src/sessions/ForkDialog";
import { SessionBrowserDialog } from "../../src/renderer/src/sessions/SessionBrowser";
import { SessionTreeDialog } from "../../src/renderer/src/sessions/SessionTree";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { installBridge } from "./fixtures";

/**
 * Session browser, tree and fork dialogs (plan step 11).
 *
 * The dialogs are the visible half of the lifecycle work: they must render real
 * `SessionInfo`/tree data, call the right host method for each action, and never
 * invent an action (a disabled/absent control beats a dead button).
 */

const WORK = "C:\\work\\pi-desktop";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    path: `${WORK}\\sessions\\s1.jsonl`,
    id: "s1",
    cwd: WORK,
    name: "Fix host protocol",
    created: 1,
    modified: 2,
    messageCount: 3,
    firstMessage: "Fix host protocol",
    allMessagesText: "Fix host protocol",
    parentSessionPath: null,
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
    projectsLoaded: true,
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
    projectSessionsQuery: normalizeSessionListQuery(),
    projectSessions: [],
    projectSessionsLoaded: true,
    projectSessionsError: null,
    projectSessionsErrorKind: null,
    projectSessionsSearching: false,
    projectSessionsTotal: 0,
    projectSessionsMatched: 0,
    projectSessionsTruncated: false,
    sessionTreeOpen: false,
    sessionTreeTabId: null,
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

describe("SessionBrowserDialog", () => {
  it("renders nothing while closed", () => {
    installBridge();
    const { container } = render(<SessionBrowserDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("groups sessions by project and resumes on click", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [tab()], activeTabId: "tab-1" }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [summary()],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);

    expect(screen.getByText("pi-desktop")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fix host protocol" }));

    expect(create).toHaveBeenCalledWith({
      cwd: WORK,
      sessionFile: `${WORK}\\sessions\\s1.jsonl`,
    });
  });

  it("hides the browser as soon as a row's title is clicked", async () => {
    const { bridge } = installBridge();
    let release!: (value: { tabs: TabRecord[]; activeTabId: string | null }) => void;
    const pending = new Promise<{ tabs: TabRecord[]; activeTabId: string | null }>((resolve) => {
      release = resolve;
    });
    const create = vi.fn(() => pending);
    (bridge.sessions as unknown as { create: unknown }).create = create;
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [summary()],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Fix host protocol" }));

    // The host is still opening the session; the pick itself must dismiss.
    await waitFor(() => expect(screen.queryByTestId("session-browser")).toBeNull());
    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);

    release({ tabs: [tab()], activeTabId: "tab-1" });
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));
  });

  it("hides the browser when the play button starts a resume", async () => {
    const { bridge } = installBridge();
    let release!: (value: { tabs: TabRecord[]; activeTabId: string | null }) => void;
    const pending = new Promise<{ tabs: TabRecord[]; activeTabId: string | null }>((resolve) => {
      release = resolve;
    });
    (bridge.sessions as unknown as { create: unknown }).create = vi.fn(() => pending);
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [summary()],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Resume session" }));

    await waitFor(() => expect(screen.queryByTestId("session-browser")).toBeNull());
    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);

    release({ tabs: [tab()], activeTabId: "tab-1" });
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));
  });

  it("hides the browser when Continue starts the resume", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({
      sessions: [summary()],
      total: 1,
      matched: 1,
      truncated: false,
      error: null,
    }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    let release!: (value: { tabs: TabRecord[]; activeTabId: string | null }) => void;
    const pending = new Promise<{ tabs: TabRecord[]; activeTabId: string | null }>((resolve) => {
      release = resolve;
    });
    (bridge.sessions as unknown as { create: unknown }).create = vi.fn(() => pending);
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [summary()],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Continue looks the newest row up first; the dialog closes as soon as the
    // resume starts, not when the host has loaded the session.
    await waitFor(() => expect(screen.queryByTestId("session-browser")).toBeNull());
    expect(useAppStore.getState().sessionBrowserOpen).toBe(false);

    release({ tabs: [tab()], activeTabId: "tab-1" });
    await waitFor(() => expect(useAppStore.getState().tabs).toHaveLength(1));
  });

  it("marks the session in the active tab as current", () => {
    installBridge();
    const current = tab({ id: "tab-current", sessionFile: `${WORK}\\sessions\\s1.jsonl` });
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [
        summary(),
        summary({ path: `${WORK}\\sessions\\s2.jsonl`, id: "s2", name: "Second task" }),
      ],
      projectSessionsLoaded: true,
      tabs: [current],
      activeTabId: current.id,
    });

    render(<SessionBrowserDialog />);

    const badge = screen.getByTestId("session-current");
    expect(badge).toHaveTextContent("Current");
    expect(badge.closest("li")).toHaveAttribute("aria-current", "true");
    // Only the focused tab's session is marked; the other row stays plain.
    expect(screen.getAllByTestId("session-row")).toHaveLength(2);
    expect(screen.getAllByTestId("session-current")).toHaveLength(1);
  });

  it("returns to the current session when its row is picked", async () => {
    const { bridge } = installBridge();
    const create = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (bridge.sessions as unknown as { create: unknown }).create = create;
    const activate = vi.fn(async (tabId: string) => ({
      tabs: useAppStore.getState().tabs,
      activeTabId: tabId,
    }));
    (bridge.sessions as unknown as { activate: unknown }).activate = activate;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [summary()],
      total: 1,
      matched: 1,
      truncated: false,
      error: null,
    }));
    const current = tab({ id: "tab-current", sessionFile: `${WORK}\\sessions\\s1.jsonl` });
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [summary()],
      projectSessionsLoaded: true,
      tabs: [current],
      activeTabId: current.id,
    });

    render(<SessionBrowserDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Fix host protocol" }));

    await waitFor(() => expect(screen.queryByTestId("session-browser")).toBeNull());
    // Picking the session you are in returns to it; it never opens a second tab.
    expect(create).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(current.id);
  });

  it("asks the host for a filtered page and renders its rows", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string }) =>
      input.method === "session.list"
        ? {
            sessions: [summary({ path: "/p/a.jsonl", id: "a", name: "Alpha task" })],
            total: 2,
            matched: 1,
            truncated: false,
            error: null,
          }
        : {},
    );
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [
        summary({ path: "/p/a.jsonl", id: "a", name: "Alpha task" }),
        summary({ path: "/p/b.jsonl", id: "b", name: "Beta task" }),
      ],
      projectSessionsLoaded: true,
      projectSessionsTotal: 2,
      projectSessionsMatched: 2,
    });

    render(<SessionBrowserDialog />);
    await userEvent.type(screen.getByLabelText("Search sessions"), "alpha");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "session.list",
          params: expect.objectContaining({ query: "alpha" }),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText("Beta task")).not.toBeInTheDocument());
    expect(screen.getByText("Alpha task")).toBeInTheDocument();
  });

  it("switches scope with the request, not just the tab", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string; params?: Record<string, unknown> }) => {
      if (input.method !== "session.list") return {};
      const current = input.params?.scope === "current";
      return {
        sessions: current
          ? [summary({ path: `${WORK}\\sessions\\cur.jsonl`, id: "cur", name: "Current only" })]
          : [
              summary({ path: `${WORK}\\sessions\\cur.jsonl`, id: "cur", name: "Current only" }),
              summary({
                path: "C:\\work\\other\\sessions\\other.jsonl",
                id: "other",
                cwd: "C:\\work\\other",
                name: "Other project",
              }),
            ],
        total: 2,
        matched: current ? 1 : 2,
        truncated: false,
        error: null,
      };
    });
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({
      sessionBrowserOpen: true,
      project: { path: WORK, name: "pi-desktop" },
      sessionBrowserScope: "current",
      projectSessionsQuery: normalizeSessionListQuery({ scope: "current", cwd: WORK }),
      projectSessions: [
        summary({ path: `${WORK}\\sessions\\cur.jsonl`, id: "cur", name: "Current only" }),
      ],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);
    expect(screen.getByRole("tab", { name: "This project" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "All sessions" }));

    await waitFor(() => expect(screen.getByText("Other project")).toBeInTheDocument());
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "session.list",
        params: expect.objectContaining({ scope: "all" }),
      }),
    );
  });

  it("shows a query error instead of an empty list", () => {
    installBridge();
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [],
      projectSessionsLoaded: true,
      projectSessionsError: "Unterminated group",
      projectSessionsErrorKind: "query",
      projectSessionsTotal: 4,
    });

    render(<SessionBrowserDialog />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Invalid regular expression/);
    expect(screen.queryByText(/No sessions yet/)).not.toBeInTheDocument();
  });

  it("asks before deleting, then trashes the session", async () => {
    const { bridge } = installBridge();
    const remove = vi.fn(async () => ({ ok: true, path: `${WORK}\\sessions\\s1.jsonl` }));
    (bridge.sessions as unknown as { deleteSession: unknown }).deleteSession = remove;
    (bridge.sessions as unknown as { request: unknown }).request = vi.fn(async () => ({
      sessions: [],
    }));
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [summary()],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);
    await userEvent.click(screen.getByRole("button", { name: "Delete session" }));
    expect(screen.getByText("Move to trash?")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(`${WORK}\\sessions\\s1.jsonl`));
  });

  it("shows an empty state when the profile has no sessions", () => {
    installBridge();
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);
    expect(screen.getByText(/No sessions yet/)).toBeInTheDocument();
  });
});

describe("SessionTreeDialog", () => {
  const tree = [
    {
      entry: { id: "e1", type: "message", message: { role: "user", content: "hello" } },
      children: [
        {
          entry: { id: "e2", type: "message", message: { role: "assistant", content: "hi" } },
          children: [],
        },
      ],
    },
  ];

  it("renders the entries and marks the current leaf", () => {
    installBridge();
    useAppStore.setState({
      sessionTreeOpen: true,
      sessionTreeTabId: "tab-1",
      sessionTree: tree,
      sessionTreeLeafId: "e2",
    });

    render(<SessionTreeDialog />);

    expect(screen.getAllByTestId("tree-row")).toHaveLength(2);
    expect(screen.getByText("current")).toBeInTheDocument();
    // The leaf row has no "Go" button; the other row does.
    expect(screen.getAllByRole("button", { name: /Go/ })).toHaveLength(1);
  });

  it("navigates to a branch through the host", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === "messages.get") return { messages: [] };
      if (input.method === "tree.get") return { tree: [], leafId: "e1" };
      return { cancelled: false };
    });
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({
      sessionTreeOpen: true,
      sessionTreeTabId: "tab-1",
      sessionTree: tree,
      sessionTreeLeafId: "e2",
      tabs: [tab()],
    });

    render(<SessionTreeDialog />);
    await userEvent.click(screen.getByRole("button", { name: /Go/ }));

    // Terminal Pi asks about the abandoned branch first (plan step 17).
    await userEvent.click(screen.getByRole("button", { name: "No summary" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "tab-1",
        method: "session.navigateTree",
        params: { targetId: "e1" },
      }),
    );
  });

  it("saves a label on an entry", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === "tree.get") return { tree, leafId: "e2" };
      return { targetId: "e1", label: "bookmark" };
    });
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({
      sessionTreeOpen: true,
      sessionTreeTabId: "tab-1",
      sessionTree: tree,
      sessionTreeLeafId: "e2",
    });

    render(<SessionTreeDialog />);
    await userEvent.click(screen.getAllByRole("button", { name: "Label this entry" })[0]!);
    await userEvent.type(screen.getByLabelText("Entry label"), "bookmark{enter}");

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "tab-1",
        method: "session.setLabel",
        params: { targetId: "e1", label: "bookmark" },
      }),
    );
  });
});

describe("ForkDialog", () => {
  it("forks from the picked message", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === "session.fork") return { cancelled: false };
      return { messages: [] };
    });
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({
      forkOpen: true,
      activeTabId: "tab-1",
      forkCandidates: [{ entryId: "e1", text: "first message" }],
    });

    render(<ForkDialog />);
    expect(screen.getByText("first message")).toBeInTheDocument();
    await userEvent.click(screen.getByText("first message"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "tab-1",
        method: "session.fork",
        params: { entryId: "e1" },
      }),
    );
  });

  it("explains when there is nothing to fork from", () => {
    installBridge();
    useAppStore.setState({ forkOpen: true, forkCandidates: [] });

    render(<ForkDialog />);
    expect(screen.getByText(/no earlier message/i)).toBeInTheDocument();
  });
});

describe("SessionTreeDialog parity (plan step 17)", () => {
  const tree = [
    {
      entry: { id: "e1", type: "message", message: { role: "user", content: "hello" } },
      children: [
        {
          entry: {
            id: "e2",
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", name: "read", arguments: { path: "gizmo.txt" } }],
            },
          },
          children: [
            {
              entry: { id: "e3", type: "message", message: { role: "user", content: "next" } },
              children: [],
            },
          ],
        },
      ],
    },
  ];

  beforeEach(() => {
    installBridge();
    useAppStore.setState({
      sessionTreeOpen: true,
      sessionTreeTabId: "tab-1",
      sessionTree: tree,
      sessionTreeLeafId: "e3",
      sessionTreeBusy: false,
      sessionTreeError: null,
      settings: { global: {}, project: {} },
      tabs: [tab()],
    });
  });

  it("searches the tree by tool name and arguments", async () => {
    render(<SessionTreeDialog />);
    expect(screen.getAllByTestId("tree-row")).toHaveLength(3);
    await userEvent.type(screen.getByLabelText("Search this session tree"), "gizmo.txt");
    expect(screen.getAllByTestId("tree-row")).toHaveLength(1);
  });

  it("folds a branch and hides its descendants", async () => {
    render(<SessionTreeDialog />);
    await userEvent.click(screen.getAllByRole("button", { name: "Fold this branch" })[0]!);
    expect(screen.getAllByTestId("tree-row").length).toBeLessThan(3);
    await userEvent.click(screen.getAllByRole("button", { name: "Unfold this branch" })[0]!);
    expect(screen.getAllByTestId("tree-row")).toHaveLength(3);
  });

  it("persists the filter through settings.set", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({
      settings: { global: { treeFilterMode: "all" }, project: {} },
      errors: [],
      files: {
        global: { path: "/p/settings.json", exists: true, mtimeMs: 1 },
        project: { path: "/w/.pi/settings.json", exists: false, mtimeMs: 0 },
      },
      projectTrusted: true,
    }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ project: { path: WORK, name: "pi" } });

    render(<SessionTreeDialog />);
    await userEvent.click(screen.getByTestId("tree-filter"));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: "control",
          method: "settings.set",
          params: expect.objectContaining({ key: "treeFilterMode", value: "no-tools" }),
        }),
      ),
    );
  });

  it("asks about the abandoned branch and passes a custom prompt", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === "messages.get") return { messages: [] };
      if (input.method === "tree.get") return { tree: [], leafId: "e1" };
      return { cancelled: false };
    });
    (bridge.sessions as unknown as { request: unknown }).request = request;

    render(<SessionTreeDialog />);
    await userEvent.click(screen.getAllByRole("button", { name: /Go/ })[0]!);
    expect(screen.getByTestId("tree-summary-prompt")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Custom prompt…" }));
    await userEvent.type(
      screen.getByLabelText("Branch summary instructions"),
      "just the decisions",
    );
    await userEvent.click(screen.getByRole("button", { name: "Summarize with prompt" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "tab-1",
        method: "session.navigateTree",
        params: {
          targetId: "e1",
          summarize: true,
          customInstructions: "just the decisions",
          replaceInstructions: true,
        },
      }),
    );
  });

  it("summarizes without custom instructions when asked", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async (input: { method: string }) => {
      if (input.method === "messages.get") return { messages: [] };
      if (input.method === "tree.get") return { tree: [], leafId: "e1" };
      return { cancelled: false };
    });
    (bridge.sessions as unknown as { request: unknown }).request = request;

    render(<SessionTreeDialog />);
    await userEvent.click(screen.getAllByRole("button", { name: /Go/ })[0]!);
    await userEvent.click(screen.getByRole("button", { name: "Summarize" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "tab-1",
        method: "session.navigateTree",
        params: { targetId: "e1", summarize: true },
      }),
    );
  });

  it("cancels an in-flight summary", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({ aborted: true }));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ sessionTreeBusy: true });

    render(<SessionTreeDialog />);
    expect(screen.getByTestId("tree-summary-busy")).toHaveTextContent(/Summarizing branch/);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "tab-1",
        method: "session.abortBranchSummary",
      }),
    );
  });

  it("treats navigating to the current leaf as a no-op", async () => {
    const { bridge } = installBridge();
    const request = vi.fn(async () => ({}));
    (bridge.sessions as unknown as { request: unknown }).request = request;
    useAppStore.setState({ sessionTreeLeafId: "e3", hint: null });

    await useAppStore.getState().navigateTree("tab-1", "e3");

    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toBe("Already at this point.");
  });
});
