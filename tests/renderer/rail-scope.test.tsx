import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentsScope } from "../../src/renderer/src/rail/DocumentsScope";
import { RailScopeLine } from "../../src/renderer/src/rail/RailScopeLine";
import { projectFolderName, projectScopeLabel } from "../../src/renderer/src/rail/scope-view";
import { RightRail, type RailMenuSpec } from "../../src/renderer/src/rail/RightRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_RAIL_PREFS } from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { parseOfficeDocumentPane } from "../../src/shared/office-documents";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The rail's scope line.
 *
 * The rail's three menus act on three different scopes, and the line is the only
 * place that says so. Two things matter beyond the copy: it must render **outside**
 * the body's scroll container (so a long Checkpoints list cannot scroll the
 * answer away), and it must offer a way to reach the folder it names.
 */

const PROJECT = "/work/danone-hcm";

function openRail(): void {
  useAppStore.setState({
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      rail: { ...DEFAULT_RAIL_PREFS, open: true, activeMenu: "source-control" },
    },
  });
}

describe("project scope labels", () => {
  it("derives the folder name from either separator", () => {
    expect(projectFolderName("/work/danone-hcm")).toBe("danone-hcm");
    expect(projectFolderName("C:\\Users\\Lenovo\\Projects\\pi-desktop")).toBe("pi-desktop");
    expect(projectFolderName("/work/danone-hcm/")).toBe("danone-hcm");
    expect(projectFolderName("C:\\work\\app\\")).toBe("app");
  });

  it("keeps a bare name and a filesystem root readable", () => {
    expect(projectFolderName("app")).toBe("app");
    // A root is its own label. Trimming the only separator would turn `C:\` into
    // `C:`, which on Windows means "the current directory on C:" — a different
    // place entirely, in a row whose whole job is saying where you are.
    expect(projectFolderName("/")).toBe("/");
    expect(projectFolderName("C:\\")).toBe("C:\\");
    expect(projectFolderName("D:/")).toBe("D:/");
  });

  it("prefers a remembered project's own name", () => {
    expect(projectScopeLabel({ path: PROJECT, name: "Danone HCM" })).toEqual({
      name: "Danone HCM",
      path: PROJECT,
      title: PROJECT,
    });
  });

  it("falls back to the folder name when the project has none", () => {
    expect(projectScopeLabel({ path: PROJECT })?.name).toBe("danone-hcm");
    expect(projectScopeLabel({ path: PROJECT, name: "   " })?.name).toBe("danone-hcm");
    expect(projectScopeLabel({ path: PROJECT, name: null })?.name).toBe("danone-hcm");
  });

  it("returns null for no folder at all", () => {
    expect(projectScopeLabel(null)).toBeNull();
    expect(projectScopeLabel({ path: "" })).toBeNull();
  });
});

describe("RailScopeLine", () => {
  it("names the folder, hides the path in the title, and offers the way to it", () => {
    const onGoToProject = vi.fn();
    render(<RailScopeLine projectPath={PROJECT} onGoToProject={onGoToProject} />);

    const path = screen.getByTestId("rail-scope-path");
    expect(path).toHaveTextContent("danone-hcm");
    // The full path is what hover is for; the row is 320 px wide.
    expect(path).toHaveAttribute("title", PROJECT);
    expect(screen.getByRole("button", { name: "Go to project" })).toBeInTheDocument();
  });

  it("truncates rather than wrapping", () => {
    render(<RailScopeLine projectPath={PROJECT} onGoToProject={() => {}} />);
    expect(screen.getByTestId("rail-scope-path")).toHaveClass("truncate");
  });

  it("calls the handler exactly once per click", async () => {
    const onGoToProject = vi.fn();
    render(<RailScopeLine projectPath={PROJECT} onGoToProject={onGoToProject} />);
    await userEvent.click(screen.getByRole("button", { name: "Go to project" }));
    expect(onGoToProject).toHaveBeenCalledTimes(1);
  });

  it("renders a trailing row when the menu supplies one", () => {
    render(
      <RailScopeLine
        projectPath={PROJECT}
        onGoToProject={() => {}}
        trailing={<p data-testid="extra-row">extra</p>}
      />,
    );
    expect(screen.getByTestId("extra-row")).toBeInTheDocument();
  });

  it("renders nothing for an empty path", () => {
    const { container } = render(<RailScopeLine projectPath="" onGoToProject={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("the rail host renders it outside the scroller", () => {
  function menus(scope?: React.ReactNode): RailMenuSpec[] {
    return [
      {
        id: "source-control",
        scroll: "self",
        scope,
        content: <p data-testid="sc-self">source control body</p>,
      },
      { id: "checkpoints", scope, content: <p data-testid="sc-host">checkpoints body</p> },
      { id: "documents", content: <p data-testid="sc-none">documents body</p> },
    ];
  }

  it("sits under the title and above the body", () => {
    installBridge();
    openRail();
    render(
      <RightRail menus={menus(<RailScopeLine projectPath={PROJECT} onGoToProject={() => {}} />)} />,
    );

    const scope = screen.getByTestId("rail-scope");
    const heading = screen.getByRole("heading", { name: "Source Control" });
    const body = screen.getByTestId("sc-self");
    expect(heading.compareDocumentPosition(scope) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(scope.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is not inside the body's scroll container, for a host-scrolled menu", () => {
    installBridge();
    openRail();
    // Checkpoints uses the host scroller: the line must stay pinned above it.
    useAppStore.setState({
      prefs: {
        ...useAppStore.getState().prefs,
        rail: { ...useAppStore.getState().prefs.rail, open: true, activeMenu: "checkpoints" },
      },
    });
    render(
      <RightRail menus={menus(<RailScopeLine projectPath={PROJECT} onGoToProject={() => {}} />)} />,
    );

    const scope = screen.getByTestId("rail-scope");
    const body = screen.getByTestId("sc-host");
    const scroller = body.parentElement!;
    expect(scroller).toHaveClass("overflow-y-auto");
    // Containment, both ways: the two live in sibling containers.
    expect(scroller.contains(scope)).toBe(false);
    expect(scope.contains(scroller)).toBe(false);
  });

  it("is not inside the body's scroll container, for a self-scrolled menu", () => {
    installBridge();
    openRail();
    render(
      <RightRail menus={menus(<RailScopeLine projectPath={PROJECT} onGoToProject={() => {}} />)} />,
    );
    const scope = screen.getByTestId("rail-scope");
    const body = screen.getByTestId("sc-self");
    const wrapper = body.parentElement!;
    expect(wrapper.contains(scope)).toBe(false);
  });

  it("renders no scope line for a menu that omits one", () => {
    installBridge();
    openRail();
    render(<RightRail menus={menus(undefined)} />);
    expect(screen.queryByTestId("rail-scope")).not.toBeInTheDocument();
  });

  it("swaps the scope line with the menu", () => {
    installBridge();
    openRail();
    render(
      <RightRail
        menus={[
          {
            id: "source-control",
            scope: <RailScopeLine projectPath={PROJECT} onGoToProject={() => {}} />,
            content: <p>source control</p>,
          },
          { id: "checkpoints", content: <p>checkpoints</p> },
        ]}
      />,
    );
    expect(screen.getByTestId("rail-scope-path")).toHaveTextContent("danone-hcm");
    cleanup();

    // A menu without a scope keeps its own column clean.
    useAppStore.setState({
      prefs: {
        ...useAppStore.getState().prefs,
        rail: { ...useAppStore.getState().prefs.rail, open: true, activeMenu: "checkpoints" },
      },
    });
    render(
      <RightRail
        menus={[
          {
            id: "source-control",
            scope: <RailScopeLine projectPath={PROJECT} onGoToProject={() => {}} />,
            content: <p>source control</p>,
          },
          { id: "checkpoints", content: <p>checkpoints</p> },
        ]}
      />,
    );
    expect(screen.queryByTestId("rail-scope")).not.toBeInTheDocument();
  });
});

/** A tab record, with only the fields the host helpers read. */
function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "/work/danone-hcm",
    title: "Session",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

const PANE = parseOfficeDocumentPane({
  host: "excel",
  paneId: "pane-1",
  document: { id: "url_sha256:aaaa1111", name: "Book1.xlsx" },
  targetId: "url_sha256:aaaa1111",
  focused: true,
  visible: true,
})!;

function seedScope(tabs: TabRecord[], activeTabId: string | null): void {
  useAppStore.setState({ tabs, activeTabId, officeDocuments: null });
}

describe("DocumentsScope", () => {
  it("names the host session and its project", () => {
    seedScope(
      [
        tab({ id: "session-1" }),
        tab({ id: "office-1", kind: "office", title: "Office", cwd: "/work/danone-hcm" }),
      ],
      "session-1",
    );
    render(<DocumentsScope panes={[PANE]} />);

    const host = screen.getByTestId("documents-scope-host");
    expect(host).toHaveTextContent("Office");
    expect(host).toHaveTextContent("danone-hcm");
    expect(host).toHaveAttribute("title", "Office — /work/danone-hcm");
  });

  it("shows the host's status", () => {
    seedScope(
      [tab({ id: "office-1", kind: "office", title: "Office", status: "running" })],
      "office-1",
    );
    render(<DocumentsScope panes={[PANE]} />);
    // The app's own lifecycle word, not the internal enum name.
    expect(screen.getByTestId("documents-scope")).toHaveTextContent("working");
  });

  it("says so plainly when this session is the host", () => {
    seedScope([tab({ id: "office-1", kind: "office", title: "Office" })], "office-1");
    render(<DocumentsScope panes={[PANE]} />);

    expect(screen.getByTestId("documents-scope-this-is-host")).toBeInTheDocument();
    // No "move the bridge" action in the session that already owns it.
    expect(
      screen.queryByRole("button", { name: "Use this session instead" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open host session" })).not.toBeInTheDocument();
  });

  it("opens the host session from another session", async () => {
    const activateTab = vi.fn(async () => {});
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
    );
    useAppStore.setState({ activateTab });
    render(<DocumentsScope panes={[PANE]} />);

    await userEvent.click(screen.getByRole("button", { name: "Open host session" }));
    expect(activateTab).toHaveBeenCalledWith("office-1");
  });

  it("asks before moving the bridge, then promotes once", async () => {
    const promoteOfficeHost = vi.fn(async () => ({ tabs: [tab()], activeTabId: "session-1" }));
    installBridge();
    (
      window.pi as unknown as { sessions: { promoteOfficeHost: unknown } }
    ).sessions.promoteOfficeHost = promoteOfficeHost;
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
    );
    render(<DocumentsScope panes={[PANE]} />);

    await userEvent.click(screen.getByRole("button", { name: "Use this session instead" }));

    // Nothing has moved yet: promotion restarts the other tab.
    expect(promoteOfficeHost).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("confirm-dialog");
    // The dialog names the tab that will be demoted.
    expect(dialog).toHaveTextContent("Office");

    await userEvent.click(screen.getByRole("button", { name: "Move the bridge" }));
    expect(promoteOfficeHost).toHaveBeenCalledTimes(1);
    expect(promoteOfficeHost).toHaveBeenCalledWith("session-1");
  });

  it("cancelling the confirmation moves nothing", async () => {
    const promoteOfficeHost = vi.fn(async () => ({ tabs: [tab()], activeTabId: "session-1" }));
    installBridge();
    (
      window.pi as unknown as { sessions: { promoteOfficeHost: unknown } }
    ).sessions.promoteOfficeHost = promoteOfficeHost;
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
    );
    render(<DocumentsScope panes={[PANE]} />);

    await userEvent.click(screen.getByRole("button", { name: "Use this session instead" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(promoteOfficeHost).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("offers to start a session when no tab holds the bridge", async () => {
    const openOfficeSession = vi.fn(async () => {});
    seedScope([tab()], "tab-1");
    useAppStore.setState({ openOfficeSession });
    render(<DocumentsScope panes={[PANE]} />);

    expect(screen.getByTestId("documents-scope-no-host")).toHaveTextContent(
      /no office session is running the bridge/i,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start an Office session" }));
    expect(openOfficeSession).toHaveBeenCalledTimes(1);
  });

  it("does not treat a stopped office tab as the host", () => {
    seedScope([tab({ id: "office-1", kind: "office", status: "stopped" })], "office-1");
    render(<DocumentsScope panes={[PANE]} />);
    // A stopped tab keeps its record but no longer holds port 38617.
    expect(screen.getByTestId("documents-scope-no-host")).toBeInTheDocument();
  });
});
