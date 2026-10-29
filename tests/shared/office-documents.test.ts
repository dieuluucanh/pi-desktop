import { describe, expect, it } from "vitest";
import {
  documentMentionValue,
  documentMentionsForHost,
  emptyOfficeDocumentsView,
  formatPaneAge,
  officeCapabilityLabel,
  officeDocumentScope,
  officeDocumentTag,
  officeHostTab,
  officeToolCapability,
  officeToolTarget,
  parseDocumentListTable,
  parseOfficeDocumentPane,
  parseOfficeDocumentsView,
  resolveToolDocument,
  shortDocumentId,
  toDocumentMentions,
  type OfficeDocumentPane,
} from "../../src/shared/office-documents";

/** A `/health` payload as the bridge (0.5.0) emits it. */
function healthPayload(panes: unknown[]) {
  return {
    ok: true,
    service: "pi-office-bridge",
    serverVersion: "0.5.0",
    capabilities: ["http-health", "agent-deltas", "client-abort"],
    protocolVersion: 3,
    catalogVersion: 3,
    port: 38617,
    panes,
  };
}

const excelPane = {
  host: "excel",
  paneId: "pane-1",
  clientName: "Excel",
  document: { id: "url_sha256:aaaa1111", name: "Book1.xlsx", source: "url" },
  targetId: "url_sha256:aaaa1111",
  focused: true,
  visible: true,
  windows: 1,
  connectedAt: 1_700_000_000_000,
  lastSeen: 1_700_000_005_000,
  model: "claude-sonnet-4",
  provider: "anthropic",
  ops: ["excel.read_range", "excel.write_range"],
  catalogVersion: 3,
  protocolVersion: 3,
  opsIgnoredCount: 0,
};

const wordPane = {
  host: "word",
  paneId: "pane-2",
  clientName: "Word",
  document: { id: "url_sha256:bbbb2222", name: "Report.docx", source: "url" },
  targetId: "url_sha256:bbbb2222",
  focused: false,
  visible: true,
  windows: 2,
  connectedAt: 1_700_000_001_000,
  lastSeen: 1_700_000_006_000,
  model: null,
  provider: null,
  ops: null,
  catalogVersion: null,
  protocolVersion: null,
  opsIgnoredCount: 3,
};

describe("parseOfficeDocumentsView", () => {
  it("projects a healthy bridge with two panes", () => {
    const view = parseOfficeDocumentsView({
      payload: healthPayload([excelPane, wordPane]),
      status: "ok",
      fetchedAt: "2026-09-20T10:00:00.000Z",
    });

    expect(view.available).toBe(true);
    expect(view.port).toBe(38617);
    expect(view.protocolVersion).toBe(3);
    expect(view.compatibility?.shape).toBe("current");
    expect(view.compatibility?.supportsDeltas).toBe(true);
    expect(view.panes).toHaveLength(2);

    const excel = view.panes[0];
    expect(excel?.hostLabel).toBe("Excel");
    expect(excel?.documentName).toBe("Book1.xlsx");
    expect(excel?.mention).toBe("Book1.xlsx");
    expect(excel?.ops).toEqual(["excel.read_range", "excel.write_range"]);

    // A legacy pane (no ops array) keeps zero ops and its ignored-op count.
    const word = view.panes[1];
    expect(word?.ops).toEqual([]);
    expect(word?.opsIgnoredCount).toBe(3);
    expect(word?.windows).toBe(2);
    expect(word?.mention).toBe("Report.docx");
  });

  it("falls back to the id when two documents share a name", () => {
    const twin = { ...excelPane, paneId: "pane-3", document: { ...excelPane.document } };
    const view = parseOfficeDocumentsView({
      payload: healthPayload([excelPane, twin]),
      status: "ok",
      fetchedAt: "2026-09-20T10:00:00.000Z",
    });
    expect(view.panes[0]?.mention).toBe("url_sha256:aaaa1111");
    expect(view.panes[1]?.mention).toBe("url_sha256:aaaa1111");
  });

  it("is unavailable when the bridge did not answer", () => {
    const view = parseOfficeDocumentsView({
      payload: null,
      status: "unreachable",
      error: "connect ECONNREFUSED",
      fetchedAt: "2026-09-20T10:00:00.000Z",
    });
    expect(view.available).toBe(false);
    expect(view.panes).toEqual([]);
    expect(view.compatibility).toBeNull();
    expect(view.error).toBe("connect ECONNREFUSED");
  });

  it("ignores malformed pane entries instead of throwing", () => {
    const view = parseOfficeDocumentsView({
      payload: healthPayload([null, "nope", 42, excelPane]),
      status: "ok",
      fetchedAt: "2026-09-20T10:00:00.000Z",
    });
    expect(view.panes).toHaveLength(1);
    expect(view.panes[0]?.documentName).toBe("Book1.xlsx");
  });

  it("defaults the view before the first probe", () => {
    const view = emptyOfficeDocumentsView(38617);
    expect(view.available).toBe(false);
    expect(view.status).toBe("unknown");
    expect(view.port).toBe(38617);
  });
});

describe("parseOfficeDocumentPane", () => {
  it("accepts the flat shape too (documentId/documentName at the top level)", () => {
    const pane = parseOfficeDocumentPane({
      host: "powerpoint",
      documentId: "url_sha256:cccc",
      documentName: "Deck.pptx",
      focused: true,
      ops: ["powerpoint.add_slide"],
    });
    expect(pane?.host).toBe("powerpoint");
    expect(pane?.documentId).toBe("url_sha256:cccc");
    expect(pane?.ops).toEqual(["powerpoint.add_slide"]);
    expect(pane?.windows).toBe(1);
  });

  it("rejects a non-object", () => {
    expect(parseOfficeDocumentPane("nope")).toBeNull();
    expect(parseOfficeDocumentPane([])).toBeNull();
  });
});

describe("documentMentionValue", () => {
  it("uses the name when unique and the id otherwise", () => {
    expect(
      documentMentionValue({ documentId: "id-a", targetId: null, documentName: "A.xlsx" }, [
        { documentName: "A.xlsx" },
        { documentName: "B.xlsx" },
      ]),
    ).toBe("A.xlsx");
    expect(
      documentMentionValue({ documentId: "id-a", targetId: null, documentName: "A.xlsx" }, [
        { documentName: "A.xlsx" },
        { documentName: "A.xlsx" },
      ]),
    ).toBe("id-a");
    expect(
      documentMentionValue({ documentId: null, targetId: "t-1", documentName: null }, []),
    ).toBe("t-1");
  });
});

describe("officeDocumentTag", () => {
  it("matches the bridge's formatDocumentTag", () => {
    expect(
      officeDocumentTag({
        host: "excel",
        documentName: "Book1.xlsx",
        documentId: "url_sha256:aaaa",
        targetId: "url_sha256:aaaa",
      }),
    ).toBe('[office:excel "Book1.xlsx" id=url_sha256:aaaa]');
  });

  it("omits the id and labels an untitled document", () => {
    expect(
      officeDocumentTag({ host: "word", documentName: null, documentId: null, targetId: null }),
    ).toBe('[office:word "untitled"]');
  });

  it("returns null when the host is unknown", () => {
    expect(
      officeDocumentTag({ host: null, documentName: "X", documentId: null, targetId: null }),
    ).toBeNull();
  });
});

describe("formatPaneAge", () => {
  const now = 1_700_000_060_000;
  it("renders just now, seconds, minutes and hours", () => {
    expect(formatPaneAge(now - 1_000, now)).toBe("just now");
    expect(formatPaneAge(now - 12_000, now)).toBe("12s ago");
    expect(formatPaneAge(now - 3 * 60_000, now)).toBe("3m ago");
    expect(formatPaneAge(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(formatPaneAge(null, now)).toBe("unknown");
  });
});

describe("shortDocumentId", () => {
  it("keeps the hash tail", () => {
    expect(shortDocumentId("url_sha256:abcdef123456")).toBe("abcdef12");
    expect(shortDocumentId(null)).toBe("—");
  });
});

describe("officeToolTarget", () => {
  it("splits an office tool name into host and op", () => {
    expect(officeToolTarget("office_excel_read_range")).toEqual({
      host: "excel",
      op: "excel.read_range",
    });
    expect(officeToolTarget("office_word_get_capabilities")).toEqual({
      host: "word",
      op: "word.get_capabilities",
    });
    expect(officeToolTarget("office_list_documents")).toBeNull();
    expect(officeToolTarget("read")).toBeNull();
  });
});

describe("officeToolCapability", () => {
  const panes = [
    { host: "excel" as const, ops: ["excel.read_range"] },
    { host: "word" as const, ops: [] },
  ];

  it("classifies advertised, legacy, gated and unattached", () => {
    expect(officeToolCapability("office_excel_read_range", panes)).toBe("advertised");
    expect(officeToolCapability("office_word_read_document", panes)).toBe("legacy");
    expect(officeToolCapability("office_excel_write_range", panes)).toBe("gated");
    expect(officeToolCapability("office_powerpoint_add_slide", panes)).toBe("unattached");
    expect(officeToolCapability("office_list_documents", panes)).toBe("unknown");
  });

  it("labels the non-advertised states and stays quiet for advertised", () => {
    expect(officeCapabilityLabel("advertised")).toBeNull();
    expect(officeCapabilityLabel("legacy")).toMatch(/legacy/);
    expect(officeCapabilityLabel("gated")).toMatch(/not advertised/);
    expect(officeCapabilityLabel("unattached")).toMatch(/no document/);
  });
});

describe("resolveToolDocument", () => {
  const pane = parseOfficeDocumentPane(excelPane) as OfficeDocumentPane;
  const panes = [pane];

  it("resolves active to the focused pane", () => {
    expect(resolveToolDocument("office_excel_read_range", {}, panes)).toEqual({
      label: "Book1.xlsx",
      pane,
      explicit: false,
    });
    expect(
      resolveToolDocument("office_excel_read_range", { document: "active" }, panes)?.explicit,
    ).toBe(false);
  });

  it("resolves an explicit id or name", () => {
    expect(
      resolveToolDocument("office_excel_read_range", { document: "Book1.xlsx" }, panes)?.label,
    ).toBe("Book1.xlsx");
    expect(
      resolveToolDocument("office_excel_read_range", { document: "url_sha256:aaaa1111" }, panes)
        ?.pane,
    ).toBe(pane);
  });

  it("keeps an unknown explicit target as a label with no pane", () => {
    const resolved = resolveToolDocument(
      "office_excel_read_range",
      { document: "Nope.xlsx" },
      panes,
    );
    expect(resolved?.label).toBe("Nope.xlsx");
    expect(resolved?.pane).toBeNull();
    expect(resolved?.explicit).toBe(true);
  });

  it("returns null for a non-office tool", () => {
    expect(resolveToolDocument("read", {}, panes)).toBeNull();
  });
});

describe("parseDocumentListTable", () => {
  it("parses the bridge's markdown table", () => {
    const rows = parseDocumentListTable(
      [
        "| document | id | host | focused | windows |",
        "|---|---|---|---|---|",
        "| Book1.xlsx | `url_sha256:aaaa` | Excel | yes | 1 |",
        "| Report.docx | `url_sha256:bbbb` | Word | no | 2 |",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { document: "Book1.xlsx", id: "url_sha256:aaaa", host: "Excel", focused: true, windows: 1 },
      {
        document: "Report.docx",
        id: "url_sha256:bbbb",
        host: "Word",
        focused: false,
        windows: 2,
      },
    ]);
  });

  it("returns nothing for a non-table answer", () => {
    expect(parseDocumentListTable("No Office documents are attached to the bridge.")).toEqual([]);
  });
});

describe("toDocumentMentions", () => {
  it("orders focused documents first and carries host + focus notes", () => {
    const focused = parseOfficeDocumentPane({ ...wordPane, focused: true })!;
    const idle = parseOfficeDocumentPane({ ...excelPane, focused: false })!;

    const mentions = toDocumentMentions([idle, focused]);

    expect(mentions.map((entry) => entry.name)).toEqual(["Report.docx", "Book1.xlsx"]);
    expect(mentions[0]).toMatchObject({ kind: "Word", description: "Word · focused · 2 windows" });
    expect(mentions[1]?.id).toBe("url_sha256:aaaa1111");
  });

  it("uses the ambiguous-name fallback the pane already computed", () => {
    const view = parseOfficeDocumentsView({
      payload: healthPayload([excelPane, { ...excelPane, paneId: "pane-9" }]),
      status: "ok",
      fetchedAt: "2026-09-20T10:00:00.000Z",
    });
    expect(toDocumentMentions(view.panes).map((entry) => entry.name)).toEqual([
      "url_sha256:aaaa1111",
      "url_sha256:aaaa1111",
    ]);
  });
});

/** One tab record, with only the fields the host helpers read. */
function tab(
  overrides: Partial<{
    id: string;
    kind: "session" | "office" | "web";
    cwd: string;
    title: string;
    status: "idle" | "running" | "starting" | "crashed" | "failed" | "stopped";
  }> = {},
) {
  return {
    id: "tab-1",
    kind: "session" as const,
    cwd: "/work/danone-hcm",
    title: "Session",
    status: "idle" as const,
    ...overrides,
  };
}

describe("officeHostTab", () => {
  it("finds the office tab that holds the bridge", () => {
    const host = officeHostTab([tab(), tab({ id: "office-1", kind: "office", title: "Office" })]);
    expect(host?.id).toBe("office-1");
    expect(host?.kind).toBe("office");
  });

  it("ignores a stopped office tab, because it no longer holds the port", () => {
    const host = officeHostTab([
      tab({ id: "office-1", kind: "office", status: "stopped" }),
      tab({ id: "office-2", kind: "office", status: "running" }),
    ]);
    // The live tab wins even though the stopped record comes first.
    expect(host?.id).toBe("office-2");
  });

  it("returns null when the only candidate is stopped", () => {
    expect(officeHostTab([tab({ kind: "office", status: "stopped" })])).toBeNull();
  });

  it("returns null when no tab is an office tab", () => {
    expect(officeHostTab([tab(), tab({ id: "tab-2" })])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(officeHostTab([])).toBeNull();
  });

  it("still treats a crashed host as the host: it is assigned the port", () => {
    // Whether its process answers right now is a different question from identity.
    expect(officeHostTab([tab({ kind: "office", status: "crashed" })])?.status).toBe("crashed");
    expect(officeHostTab([tab({ kind: "office", status: "failed" })])?.status).toBe("failed");
  });
});

describe("officeDocumentScope", () => {
  const panes = parseOfficeDocumentsView({
    payload: healthPayload([excelPane]),
    status: "ok",
    fetchedAt: "2026-09-20T10:00:00.000Z",
  }).panes;

  it("reports isHost only for the host tab itself", () => {
    const tabs = [tab({ id: "session-1" }), tab({ id: "office-1", kind: "office" })];
    expect(officeDocumentScope(panes, tabs, "office-1").isHost).toBe(true);
    expect(officeDocumentScope(panes, tabs, "session-1").isHost).toBe(false);
  });

  it("resolves the host's project path from its cwd", () => {
    const tabs = [
      tab({ id: "session-1", cwd: "/work/other" }),
      tab({ id: "office-1", kind: "office", cwd: "/work/danone-hcm", title: "Office" }),
    ];
    expect(officeDocumentScope(panes, tabs, "session-1")).toEqual({
      host: {
        id: "office-1",
        title: "Office",
        projectPath: "/work/danone-hcm",
        status: "idle",
      },
      isHost: false,
    });
  });

  it("reports no host and no isHost flag when nothing holds the bridge", () => {
    expect(officeDocumentScope(panes, [tab()], "tab-1")).toEqual({ host: null, isHost: false });
  });

  it("does not claim host-ness for a null active tab", () => {
    expect(officeDocumentScope(panes, [tab({ kind: "office" })], null).isHost).toBe(false);
  });
});

describe("documentMentionsForHost", () => {
  const panes = parseOfficeDocumentsView({
    payload: healthPayload([excelPane]),
    status: "ok",
    fetchedAt: "2026-09-20T10:00:00.000Z",
  }).panes;

  it("returns the mention list for the host session", () => {
    const tabs = [tab({ id: "office-1", kind: "office" })];
    const mentions = documentMentionsForHost(panes, tabs, "office-1");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.name).toBe("Book1.xlsx");
  });

  it("returns nothing for a sibling session in the same project", () => {
    const tabs = [
      tab({ id: "office-1", kind: "office" }),
      tab({ id: "session-1", cwd: "/work/danone-hcm" }),
    ];
    // Same folder, different tab: the `office_*` call still lands on the host,
    // so a mention here would tag a prompt this session cannot serve.
    expect(documentMentionsForHost(panes, tabs, "session-1")).toEqual([]);
  });

  it("returns nothing when no host exists at all", () => {
    expect(documentMentionsForHost(panes, [tab()], "tab-1")).toEqual([]);
  });
});
