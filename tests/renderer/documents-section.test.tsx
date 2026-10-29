import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsSection } from "../../src/renderer/src/rail/DocumentsSection";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { parseOfficeDocumentPane } from "../../src/shared/office-documents";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { documentsViewFixture, installBridge } from "./fixtures";

/**
 * The Documents section (plan step 20, moved onto the rail by the 2026-10-27
 * plan): visible only when the bridge answers `/health`, one row per attached
 * pane, and the actions that turn a document into a targeted prompt.
 *
 * The column itself — its `<aside>`, width, toggle and close button — belongs to
 * `RightRail` and is asserted in `right-rail.test.tsx`. This suite covers the
 * *body*: the rows, the empty state, the actions and the host footer.
 */

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "C:/work/app",
    title: "app",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
    ...overrides,
  };
}

const excelPane = parseOfficeDocumentPane({
  host: "excel",
  paneId: "pane-1",
  document: { id: "url_sha256:aaaa1111", name: "Book1.xlsx" },
  targetId: "url_sha256:aaaa1111",
  focused: true,
  visible: true,
  windows: 1,
  ops: ["excel.read_range", "excel.write_range"],
  lastSeen: Date.now(),
})!;

const wordPane = parseOfficeDocumentPane({
  host: "word",
  paneId: "pane-2",
  document: { id: "url_sha256:bbbb2222", name: "Report.docx" },
  targetId: "url_sha256:bbbb2222",
  focused: false,
  visible: true,
  windows: 2,
  ops: [],
  lastSeen: Date.now(),
})!;

function resetStore() {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {}, rail: { ...DEFAULT_PREFS.rail, open: true } },
    project: { path: "C:/work/app", name: "app" },
    tabs: [tab()],
    activeTabId: "tab-1",
    officeDocuments: null,
    officeDocumentsLoaded: false,
    hint: null,
    view: "session",
  });
}

beforeEach(resetStore);

describe("documents panel", () => {
  it("renders nothing until the bridge answers /health", () => {
    render(<DocumentsSection />);
    expect(screen.queryByTestId("documents-section")).not.toBeInTheDocument();
  });

  it("lists each pane with its host, id, windows and advertised ops", () => {
    useAppStore.setState({
      officeDocuments: documentsViewFixture({
        available: true,
        status: "ok",
        panes: [excelPane, wordPane],
      }),
    });
    render(<DocumentsSection />);

    expect(screen.getByTestId("documents-section")).toBeInTheDocument();
    expect(screen.getByText("Book1.xlsx")).toBeInTheDocument();
    expect(screen.getByText("Report.docx")).toBeInTheDocument();
    expect(screen.getByText("Excel")).toBeInTheDocument();
    expect(screen.getByText("Word")).toBeInTheDocument();
    expect(screen.getByText("2 ops")).toBeInTheDocument();
    expect(screen.getByText("legacy v1 ops")).toBeInTheDocument();
    expect(screen.getByText("2 windows")).toBeInTheDocument();
    expect(screen.getByText("focused")).toBeInTheDocument();
  });

  it("shows a helpful empty state when the bridge is up but nothing is attached", () => {
    useAppStore.setState({
      officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [] }),
    });
    render(<DocumentsSection />);

    expect(screen.getByTestId("documents-empty")).toHaveTextContent(
      /open the pi for office add-in/i,
    );
    expect(screen.getByRole("button", { name: /re-check for documents/i })).toBeInTheDocument();
  });

  it("tags the composer draft from 'Chat about this'", async () => {
    useAppStore.setState({
      officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [excelPane] }),
    });
    render(<DocumentsSection />);

    await userEvent.click(screen.getByRole("button", { name: /chat about book1\.xlsx/i }));

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe(
      '[office:excel "Book1.xlsx" id=url_sha256:aaaa1111] ',
    );
  });

  it("inserts a #mention from a row", async () => {
    useAppStore.setState({
      officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [excelPane] }),
    });
    render(<DocumentsSection />);

    await userEvent.click(screen.getByRole("button", { name: /insert document mention/i }));

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("#Book1.xlsx ");
  });

  it("offers promotion when no tab owns the Office host port", async () => {
    const promoteOfficeHost = vi.fn(async () => ({
      tabs: [tab({ kind: "office" })],
      activeTabId: "tab-1",
    }));
    installBridge();
    (
      window.pi as unknown as { sessions: { promoteOfficeHost: unknown } }
    ).sessions.promoteOfficeHost = promoteOfficeHost;
    useAppStore.setState({
      officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [excelPane] }),
    });
    render(<DocumentsSection />);

    await userEvent.click(screen.getByRole("button", { name: /promote to office host/i }));

    await waitFor(() => expect(promoteOfficeHost).toHaveBeenCalledWith("tab-1"));
  });

  it("names the current Office host instead of offering promotion", () => {
    useAppStore.setState({
      tabs: [tab(), tab({ id: "tab-office", kind: "office", title: "Office" })],
      officeDocuments: documentsViewFixture({ available: true, status: "ok", panes: [excelPane] }),
    });
    render(<DocumentsSection />);

    expect(screen.getByText(/port 38617/)).toBeInTheDocument();
    expect(screen.getByText("Office")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /promote to office host/i }),
    ).not.toBeInTheDocument();
  });
});
