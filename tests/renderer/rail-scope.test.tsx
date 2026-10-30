import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentsScope } from "../../src/renderer/src/rail/DocumentsScope";
import { projectFolderName } from "../../src/renderer/src/rail/scope-view";
import { RightRail, type RailMenuSpec } from "../../src/renderer/src/rail/RightRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_RAIL_PREFS } from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { parseOfficeDocumentPane } from "../../src/shared/office-documents";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * The rail's scope, as the rail host and the Documents menu render it.
 *
 * Two facts changed in the 2026-10-30 project-scoped rail plan and are pinned
 * here:
 *
 *  - Source Control and Checkpoints no longer spend a row naming the folder and
 *    offering **Go to project**: the rail always follows the selected project, so
 *    the folder lives in the panel header's `title`.
 *  - Documents keeps one compact note (plus its bridge actions). The old two-line
 *    host header named the *host's* project and went stale as soon as the user
 *    switched to a session in a different folder.
 */

const PROJECT = "/work/danone-hcm";

function openRail(activeMenu: RailMenuSpec["id"] = "source-control"): void {
  useAppStore.setState({
    prefs: {
      ...DEFAULT_PREFS,
      drafts: {},
      rail: { ...DEFAULT_RAIL_PREFS, open: true, activeMenu },
    },
  });
}

describe("project folder names", () => {
  it("derives the folder name from either separator", () => {
    expect(projectFolderName("/work/danone-hcm")).toBe("danone-hcm");
    expect(projectFolderName("C:\\Users\\Lenovo\\Projects\\pi-desktop")).toBe("pi-desktop");
    expect(projectFolderName("/work/danone-hcm/")).toBe("danone-hcm");
    expect(projectFolderName("C:\\work\\app\\")).toBe("app");
  });

  it("keeps a bare name and a filesystem root readable", () => {
    expect(projectFolderName("app")).toBe("app");
    // Trimming a root's only separator would change what it means on Windows.
    expect(projectFolderName("/")).toBe("/");
    expect(projectFolderName("C:\\")).toBe("C:\\");
    expect(projectFolderName("D:/")).toBe("D:/");
  });
});

/** A menu set with no scope row, the shape `ProjectRail` builds. */
function menus(scopeTitle?: string): RailMenuSpec[] {
  return [
    {
      id: "source-control",
      scroll: "self",
      scopeTitle,
      content: <p data-testid="sc-self">source control body</p>,
    },
    { id: "checkpoints", scopeTitle, content: <p data-testid="sc-host">checkpoints body</p> },
    { id: "documents", content: <p data-testid="sc-none">documents body</p> },
  ];
}

describe("the folder is named by the panel header, not by a row", () => {
  it("puts the folder in the header's title", () => {
    installBridge();
    openRail();
    render(<RightRail menus={menus(PROJECT)} />);

    const heading = screen.getByRole("heading", { name: "Source Control" });
    expect(heading).toHaveAttribute("title", PROJECT);
  });

  it("carries the title on every menu that declares one", () => {
    installBridge();
    openRail("checkpoints");
    render(<RightRail menus={menus(PROJECT)} />);

    expect(screen.getByRole("heading", { name: "Checkpoints" })).toHaveAttribute("title", PROJECT);
    // Documents is app-wide: it declares no folder, so it gets no title.
    cleanup();
    openRail("documents");
    render(<RightRail menus={menus(PROJECT)} />);
    expect(screen.getByRole("heading", { name: "Documents" })).not.toHaveAttribute("title");
  });

  it("spends no row on a scope line any more", () => {
    installBridge();
    openRail();
    render(<RightRail menus={menus(PROJECT)} />);

    expect(screen.queryByTestId("rail-scope")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Go to project" })).not.toBeInTheDocument();
  });

  it("keeps the body's own scroll container untouched", () => {
    installBridge();
    openRail();
    render(<RightRail menus={menus(PROJECT)} />);
    // The header must not push the body out of its scroller.
    expect(screen.getByText("source control body").parentElement).not.toHaveClass(
      "overflow-y-auto",
    );

    cleanup();
    openRail("checkpoints");
    render(<RightRail menus={menus(PROJECT)} />);
    expect(screen.getByText("checkpoints body").parentElement).toHaveClass("overflow-y-auto");
  });

  it("still renders a pinned row for a menu that supplies one", () => {
    // Documents is the one menu that pins something: its bridge actions.
    installBridge();
    openRail();
    render(
      <RightRail
        menus={[
          {
            id: "documents",
            scope: <p data-testid="pinned-row">host actions</p>,
            content: <p data-testid="sc-none">documents body</p>,
          },
        ]}
      />,
    );
    const pinned = screen.getByTestId("pinned-row");
    const body = screen.getByTestId("sc-none");
    expect(pinned.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.parentElement!.contains(pinned)).toBe(false);
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
  it("names the host and its project when the host is elsewhere", () => {
    seedScope(
      [
        tab({ id: "session-1", cwd: "/work/app" }),
        tab({ id: "office-1", kind: "office", title: "Office", cwd: "/work/danone-hcm" }),
      ],
      "session-1",
    );
    render(<DocumentsScope panes={[PANE]} railFolder="/work/app" />);

    const host = screen.getByTestId("documents-scope-host");
    expect(host).toHaveTextContent("Office host: Office · /work/danone-hcm");
    // The full path stays in the title for the narrow column.
    expect(host).toHaveAttribute("title", "/work/danone-hcm");
  });

  it("omits the folder when the host works in the rail's folder", () => {
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
    );
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);

    expect(screen.getByTestId("documents-scope-host")).toHaveTextContent("Office host: Office");
    expect(screen.getByTestId("documents-scope-host")).not.toHaveTextContent("danone-hcm");
  });

  it("renders no project header row any more", () => {
    seedScope(
      [tab({ id: "office-1", kind: "office", title: "Office", status: "running" })],
      "session-1",
    );
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);

    // The status badge and the two-line header are gone with the stale project
    // name they carried.
    const scope = screen.getByTestId("documents-scope");
    expect(scope).not.toHaveTextContent("working");
    expect(scope.querySelector("[data-testid='documents-scope-status']")).toBeNull();
  });

  it("says so plainly when this session is the host", () => {
    seedScope([tab({ id: "office-1", kind: "office", title: "Office" })], "office-1");
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);

    expect(screen.getByTestId("documents-scope-this-is-host")).toHaveTextContent(
      "This session is the Office host.",
    );
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
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);

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
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Use this session instead" }));

    // Nothing has moved yet: promotion restarts the other tab.
    expect(promoteOfficeHost).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("confirm-dialog");
    // The dialog names the tab that will be demoted, and warns that the port's
    // current owner is terminated (the takeover really does free the port).
    expect(dialog).toHaveTextContent("Office");
    expect(dialog).toHaveTextContent(/terminated/i);

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
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);

    await userEvent.click(screen.getByRole("button", { name: "Use this session instead" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(promoteOfficeHost).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("refuses to promote a web tab, and says why", () => {
    seedScope(
      [
        tab({ id: "web-1", kind: "web", cwd: "/work/app" }),
        tab({ id: "office-1", kind: "office" }),
      ],
      "web-1",
    );
    render(<DocumentsScope panes={[PANE]} railFolder="/work/app" activeKind="web" />);

    const promote = screen.getByRole("button", { name: "Use this session instead" });
    expect(promote).toBeDisabled();
    expect(promote).toHaveAttribute("title", "A web tab cannot host the Office bridge.");
  });

  it("offers to start a session when no tab holds the bridge", async () => {
    const openOfficeSession = vi.fn(async () => {});
    seedScope([tab()], "tab-1");
    useAppStore.setState({ openOfficeSession });
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);

    expect(screen.getByTestId("documents-scope-no-host")).toHaveTextContent(
      /no office session is running the bridge/i,
    );
    await userEvent.click(screen.getByRole("button", { name: "Start an Office session" }));
    expect(openOfficeSession).toHaveBeenCalledTimes(1);
  });

  it("does not treat a stopped office tab as the host", () => {
    seedScope([tab({ id: "office-1", kind: "office", status: "stopped" })], "office-1");
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);
    // A stopped tab keeps its record but no longer holds port 38617.
    expect(screen.getByTestId("documents-scope-no-host")).toBeInTheDocument();
  });

  it("offers a host restart only while the bridge is known to be down", async () => {
    installBridge();
    const restart = vi.fn(async () => ({ tabs: [], activeTabId: null }));
    (window.pi as unknown as { sessions: { restart: unknown } }).sessions.restart = restart;
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
    );

    const { rerender } = render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} />);
    // Bridge answering: the normal switch actions, and nothing to recover from.
    expect(screen.queryByRole("button", { name: "Restart host session" })).not.toBeInTheDocument();

    rerender(<DocumentsScope panes={[PANE]} railFolder={PROJECT} bridgeDown />);
    await userEvent.click(screen.getByRole("button", { name: "Restart host session" }));

    // The host is the tab that owns the port, not the one the user is in.
    expect(restart).toHaveBeenCalledWith("office-1");
  });

  it("offers the restart from the host session too", () => {
    seedScope([tab({ id: "office-1", kind: "office", title: "Office" })], "office-1");
    render(<DocumentsScope panes={[PANE]} railFolder={PROJECT} bridgeDown />);

    expect(screen.getByRole("button", { name: "Restart host session" })).toBeInTheDocument();
  });
});
