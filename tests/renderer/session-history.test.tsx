import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import type { SessionSummary } from "../../src/shared/session-browser";
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
    projectSessions: [],
    projectSessionsLoaded: true,
    projectSessionsError: null,
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

  it("filters the list with the search box", async () => {
    installBridge();
    useAppStore.setState({
      sessionBrowserOpen: true,
      projectSessions: [
        summary({ path: "/p/a.jsonl", id: "a", name: "Alpha task" }),
        summary({ path: "/p/b.jsonl", id: "b", name: "Beta task" }),
      ],
      projectSessionsLoaded: true,
    });

    render(<SessionBrowserDialog />);
    await userEvent.type(screen.getByLabelText("Search sessions"), "alpha");

    expect(screen.getByText("Alpha task")).toBeInTheDocument();
    expect(screen.queryByText("Beta task")).not.toBeInTheDocument();
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
