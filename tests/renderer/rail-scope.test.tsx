import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocumentsScope } from "../../src/renderer/src/rail/DocumentsScope";
import { projectFolderName } from "../../src/renderer/src/rail/scope-view";
import { RightRail, type RailMenuSpec } from "../../src/renderer/src/rail/RightRail";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_RAIL_PREFS } from "../../src/shared/rail";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import {
  parseOfficeDocumentPane,
  type OfficeDocumentsView,
} from "../../src/shared/office-documents";
import type { TabRecord } from "../../src/shared/session-ipc";
import { documentsViewFixture, installBridge } from "./fixtures";

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
  it("shows the folder in the header and the full path in its title", () => {
    installBridge();
    openRail();
    render(<RightRail menus={menus(PROJECT)} />);

    const heading = screen.getByRole("heading", { name: "Source Control" });
    expect(heading).toHaveAttribute("title", PROJECT);
    const folder = screen.getByTestId("rail-scope-folder");
    expect(folder).toHaveTextContent("danone-hcm");
    expect(folder).toHaveAttribute("title", PROJECT);
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
    // Documents is app-wide: no folder, so no folder span either.
    expect(screen.queryByTestId("rail-scope-folder")).not.toBeInTheDocument();
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

describe("DocumentsScope", () => {
  function seedScope(
    tabs: TabRecord[],
    activeTabId: string | null,
    view: OfficeDocumentsView,
    activeKind: string | null = null,
  ): void {
    useAppStore.setState({
      tabs,
      activeTabId,
      officeDocuments: view,
      officeBridgeBusy: false,
    });
    if (activeKind) {
      // The prop is read directly; the store does not need a second copy.
    }
  }

  function ownerView(sessionId: string | null, overrides: Partial<OfficeDocumentsView> = {}) {
    return documentsViewFixture({
      available: true,
      status: "ok",
      manualLifecycle: true,
      panes: [PANE],
      owner: {
        pid: 7,
        sessionId,
        client: sessionId === null ? "cli" : "desktop",
        cwd: "/work/app",
      },
      ...overrides,
    });
  }

  function offView(overrides: Partial<OfficeDocumentsView> = {}) {
    return documentsViewFixture({
      available: false,
      status: "unreachable",
      manualLifecycle: false,
      panes: [],
      owner: null,
      ...overrides,
    });
  }

  it("names the owner and its project when the bridge is in another tab", () => {
    seedScope(
      [
        tab({ id: "session-1", cwd: "/work/app" }),
        tab({ id: "office-1", kind: "office", title: "Office", cwd: "/work/danone-hcm" }),
      ],
      "session-1",
      ownerView("office-1"),
    );
    render(<DocumentsScope railFolder="/work/app" />);

    const host = screen.getByTestId("documents-scope-host");
    expect(host).toHaveTextContent("Office host: Office · /work/danone-hcm");
    expect(host).toHaveAttribute("title", "/work/danone-hcm");
  });

  it("omits the folder when the owner works in the rail's folder", () => {
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
      ownerView("office-1"),
    );
    render(<DocumentsScope railFolder={PROJECT} />);

    expect(screen.getByTestId("documents-scope-host")).toHaveTextContent("Office host: Office");
    expect(screen.getByTestId("documents-scope-host")).not.toHaveTextContent("danone-hcm");
  });

  it("offers Disconnect and Restart when this session is the owner", () => {
    seedScope([tab({ id: "session-1" })], "session-1", ownerView("session-1"));
    render(<DocumentsScope railFolder={PROJECT} />);

    expect(screen.getByTestId("documents-scope-this-is-host")).toHaveTextContent(
      "This session is the Office host.",
    );
    expect(screen.getByRole("button", { name: "Disconnect Office bridge" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Office bridge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open host session" })).not.toBeInTheDocument();
  });

  it("opens the owner session from another tab", async () => {
    const activateTab = vi.fn(async () => {});
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
      ownerView("office-1"),
    );
    useAppStore.setState({ activateTab });

    render(<DocumentsScope railFolder={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Open host session" }));
    expect(activateTab).toHaveBeenCalledWith("office-1");
  });

  it("asks before moving the bridge, then connects this tab", async () => {
    const connectOfficeBridge = vi.fn(async () => true);
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
      ownerView("office-1"),
    );
    useAppStore.setState({ connectOfficeBridge });

    render(<DocumentsScope railFolder={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Move bridge here" }));

    expect(connectOfficeBridge).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent("Office");
    expect(dialog).toHaveTextContent(/session stays open/i);

    await userEvent.click(screen.getByRole("button", { name: "Move the bridge" }));
    expect(connectOfficeBridge).toHaveBeenCalledWith("session-1");
  });

  it("cancelling the move changes nothing", async () => {
    const connectOfficeBridge = vi.fn(async () => true);
    seedScope(
      [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office", title: "Office" })],
      "session-1",
      ownerView("office-1"),
    );
    useAppStore.setState({ connectOfficeBridge });

    render(<DocumentsScope railFolder={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Move bridge here" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(connectOfficeBridge).not.toHaveBeenCalled();
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("refuses to move a bridge into a web tab and says why", () => {
    seedScope(
      [
        tab({ id: "web-1", kind: "web", cwd: "/work/app" }),
        tab({ id: "office-1", kind: "office" }),
      ],
      "web-1",
      ownerView("office-1"),
      "web",
    );
    render(<DocumentsScope railFolder="/work/app" activeKind="web" />);

    const move = screen.getByRole("button", { name: "Move bridge here" });
    expect(move).toBeDisabled();
    expect(move).toHaveAttribute("title", "A web tab cannot host the Office bridge.");
  });

  it("offers Connect this session when the bridge is off", async () => {
    const connectOfficeBridge = vi.fn(async () => true);
    seedScope([tab({ id: "session-1" })], "session-1", offView());
    useAppStore.setState({ connectOfficeBridge });

    render(<DocumentsScope railFolder={PROJECT} />);
    expect(screen.getByTestId("documents-scope-no-host")).toHaveTextContent(
      /office bridge is off/i,
    );
    await userEvent.click(screen.getByRole("button", { name: "Connect this session" }));
    expect(connectOfficeBridge).toHaveBeenCalledWith("session-1");
  });

  it("offers Start an Office session when there is no active tab", async () => {
    const openOfficeSession = vi.fn(async () => {});
    seedScope([], null, offView());
    useAppStore.setState({ openOfficeSession });

    render(<DocumentsScope railFolder={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Start an Office session" }));
    expect(openOfficeSession).toHaveBeenCalledTimes(1);
  });

  it("shows a foreign owner and asks before taking over", async () => {
    const connectOfficeBridge = vi.fn(async () => true);
    seedScope(
      [tab({ id: "session-1" })],
      "session-1",
      ownerView(null, { owner: { pid: 99, sessionId: null, client: "cli", cwd: "/work/app" } }),
    );
    useAppStore.setState({ connectOfficeBridge });

    render(<DocumentsScope railFolder={PROJECT} />);
    expect(screen.getByTestId("documents-scope-external")).toHaveTextContent(
      /terminal Pi session \(PID 99/,
    );

    await userEvent.click(screen.getByRole("button", { name: "Take over Office bridge" }));
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog).toHaveTextContent(/terminates the process/i);

    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(connectOfficeBridge).toHaveBeenCalledWith("session-1", { takeover: true });
  });

  it("offers a takeover for a foreign program on the port", async () => {
    const connectOfficeBridge = vi.fn(async () => true);
    seedScope(
      [tab({ id: "session-1" })],
      "session-1",
      offView({ status: "not-our-bridge", error: "port busy" }),
    );
    useAppStore.setState({ connectOfficeBridge });

    render(<DocumentsScope railFolder={PROJECT} />);
    expect(screen.getByTestId("documents-scope-no-host")).toHaveTextContent(
      /owned by another program/i,
    );
    await userEvent.click(screen.getByRole("button", { name: "Take over Office port" }));
    await userEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(connectOfficeBridge).toHaveBeenCalledWith("session-1", { takeover: true });
  });

  it("shows the legacy bridge update path instead of controls it cannot use", () => {
    const installOfficeBridge = vi.fn();
    seedScope(
      [tab({ id: "office-1", kind: "office", title: "Office" })],
      "office-1",
      documentsViewFixture({
        available: true,
        status: "ok",
        manualLifecycle: false,
        owner: null,
        panes: [PANE],
      }),
    );
    useAppStore.setState({ installOfficeBridge });

    render(<DocumentsScope railFolder={PROJECT} />);
    expect(screen.getByTestId("documents-legacy-bridge")).toHaveTextContent(/legacy/i);
    expect(screen.getByRole("button", { name: "Update bridge" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disconnect Office bridge" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move bridge here" })).not.toBeInTheDocument();
  });

  it("calls Restart on the owner tab", async () => {
    const restartOfficeBridge = vi.fn(async () => true);
    seedScope([tab({ id: "session-1" })], "session-1", ownerView("session-1"));
    useAppStore.setState({ restartOfficeBridge });

    render(<DocumentsScope railFolder={PROJECT} />);
    await userEvent.click(screen.getByRole("button", { name: "Restart Office bridge" }));
    expect(restartOfficeBridge).toHaveBeenCalledWith("session-1");
  });
});
