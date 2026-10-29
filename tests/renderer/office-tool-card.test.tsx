import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { OfficeToolCard } from "../../src/renderer/src/session/OfficeToolCard";
import { isOfficeTool, officeToolSummary } from "../../src/renderer/src/session/office-tool-card";
import type { TranscriptToolRun } from "../../src/renderer/src/session/session-events";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { parseOfficeDocumentPane } from "../../src/shared/office-documents";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { documentsViewFixture, installBridge } from "./fixtures";

/**
 * Office tool cards (plan step 20): the target document, the capability-gating
 * note, and `office_list_documents` as a table with per-row actions.
 */

function run(overrides: Partial<TranscriptToolRun> = {}): TranscriptToolRun {
  return {
    toolCallId: "t1",
    toolName: "office_excel_read_range",
    args: {},
    isError: false,
    done: true,
    version: 1,
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
  ops: ["excel.read_range"],
  lastSeen: Date.now(),
})!;

function tab(): TabRecord {
  return {
    id: "tab-1",
    // The active tab must be the Office host for "chat about this" to write a
    // tag; a non-host session correctly refuses and sets a hint instead.
    kind: "office",
    cwd: "C:/work/app",
    title: "app",
    sessionFile: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    model: null,
  };
}

function resetStore(panes = [excelPane]) {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {}, rail: { ...DEFAULT_PREFS.rail, open: true } },
    tabs: [tab()],
    activeTabId: "tab-1",
    officeDocuments: documentsViewFixture({ available: true, status: "ok", panes }),
  });
}

beforeEach(() => resetStore());

describe("office tool helpers", () => {
  it("recognizes office tools only", () => {
    expect(isOfficeTool("office_excel_read_range")).toBe(true);
    expect(isOfficeTool("office_list_documents")).toBe(true);
    expect(isOfficeTool("read")).toBe(false);
    expect(isOfficeTool(undefined)).toBe(false);
  });

  it("summarizes an active target and an explicit one", () => {
    expect(officeToolSummary(run(), [excelPane])).toBe("→ active document");
    expect(officeToolSummary(run({ args: { document: "Book1.xlsx" } }), [excelPane])).toBe(
      "→ Book1.xlsx",
    );
    expect(officeToolSummary(run({ toolName: "read" }), [excelPane])).toBeNull();
    expect(officeToolSummary(run({ toolName: "office_list_documents" }), [excelPane])).toBeNull();
  });
});

describe("OfficeToolCard", () => {
  it("names the active document and keeps the output", () => {
    render(
      <OfficeToolCard tool={run({ resultText: "A1:B2 data" })} fallback={<pre>A1:B2 data</pre>} />,
    );

    expect(screen.getByTestId("office-tool-target")).toHaveTextContent("Book1.xlsx (active)");
    expect(screen.getByText("A1:B2 data")).toBeInTheDocument();
    expect(screen.queryByTestId("office-capability-note")).not.toBeInTheDocument();
  });

  it("marks a call the attached pane did not advertise as gated", () => {
    render(
      <OfficeToolCard
        tool={run({ toolName: "office_excel_write_range", args: { document: "Book1.xlsx" } })}
        fallback={null}
      />,
    );

    expect(screen.getByTestId("office-capability-note")).toHaveTextContent(/not advertised/i);
  });

  it("says so when no document of that host is attached", () => {
    resetStore([]);
    render(<OfficeToolCard tool={run()} fallback={null} />);

    expect(screen.getByTestId("office-capability-note")).toHaveTextContent(/no document attached/i);
  });

  it("renders office_list_documents as a table with per-row actions", () => {
    const table = [
      "| document | id | host | focused | windows |",
      "|---|---|---|---|---|",
      "| Book1.xlsx | `url_sha256:aaaa1111` | Excel | yes | 1 |",
      "| Report.docx | `url_sha256:bbbb2222` | Word | no | 2 |",
    ].join("\n");
    render(
      <OfficeToolCard
        tool={run({ toolName: "office_list_documents", resultText: table })}
        fallback={<pre>raw</pre>}
      />,
    );

    expect(screen.getByTestId("office-document-table")).toBeInTheDocument();
    expect(screen.getByText("Book1.xlsx")).toBeInTheDocument();
    expect(screen.getByText("Report.docx")).toBeInTheDocument();
    // Only the pane we know about gets a Chat action.
    expect(screen.getByRole("button", { name: /chat about book1\.xlsx/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /chat about report\.docx/i }),
    ).not.toBeInTheDocument();
  });

  it("tags the draft from a table row", async () => {
    const table = [
      "| document | id | host | focused | windows |",
      "|---|---|---|---|---|",
      "| Book1.xlsx | `url_sha256:aaaa1111` | Excel | yes | 1 |",
    ].join("\n");
    render(
      <OfficeToolCard
        tool={run({ toolName: "office_list_documents", resultText: table })}
        fallback={null}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /chat about book1\.xlsx/i }));

    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe(
      '[office:excel "Book1.xlsx" id=url_sha256:aaaa1111] ',
    );
  });

  it("falls back to raw text when the document list is not a table", () => {
    render(
      <OfficeToolCard
        tool={run({
          toolName: "office_list_documents",
          resultText: "No Office documents are attached to the bridge.",
        })}
        fallback={<pre>No Office documents are attached to the bridge.</pre>}
      />,
    );

    expect(screen.queryByTestId("office-document-table")).not.toBeInTheDocument();
    expect(screen.getByText(/No Office documents are attached/)).toBeInTheDocument();
  });
});
