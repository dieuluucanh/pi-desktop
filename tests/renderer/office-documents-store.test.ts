import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { parseOfficeDocumentPane } from "../../src/shared/office-documents";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { documentsViewFixture, installBridge } from "./fixtures";

/**
 * The live Office pane registry in the renderer store (plan step 20).
 *
 * The panel and `#` completion read the registry from here, and "chat about this
 * document" is the one action that has to reach the composer: it prepends the
 * bridge's document tag to the active session's draft without discarding what
 * the user already typed.
 */

const PROJECT = "C:/work/app";

function tab(overrides: Partial<TabRecord> = {}): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: PROJECT,
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
  document: { id: "url_sha256:aaaa", name: "Book1.xlsx" },
  targetId: "url_sha256:aaaa",
  focused: true,
  visible: true,
  windows: 1,
  ops: ["excel.read_range"],
  lastSeen: 1_000,
});

function resetStore() {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {}, rail: { ...DEFAULT_PREFS.rail, open: false } },
    project: { path: PROJECT, name: "app" },
    tabs: [tab()],
    activeTabId: "tab-1",
    officeDocuments: null,
    officeDocumentsLoaded: false,
    hint: null,
    view: "session",
  });
}

beforeEach(resetStore);

describe("office documents store", () => {
  it("applies a pushed registry and opens the rail once panes attach", () => {
    const view = documentsViewFixture({ available: true, status: "ok", panes: [excelPane!] });

    useAppStore.getState().applyOfficeDocuments(view);

    const state = useAppStore.getState();
    expect(state.officeDocuments?.panes).toHaveLength(1);
    expect(state.officeDocumentsLoaded).toBe(true);
    expect(state.prefs.rail.open).toBe(true);
  });

  it("keeps the rail closed for an available bridge with no panes", () => {
    useAppStore
      .getState()
      .applyOfficeDocuments(documentsViewFixture({ available: true, status: "ok", panes: [] }));
    expect(useAppStore.getState().prefs.rail.open).toBe(false);
  });

  it("loads the registry once and refreshes on demand", async () => {
    const documents = vi.fn(async () =>
      documentsViewFixture({ available: true, status: "ok", panes: [excelPane!] }),
    );
    const refreshDocuments = vi.fn(async () => documentsViewFixture({ status: "unreachable" }));
    installBridge();
    (window.pi as unknown as { office: { documents: unknown } }).office.documents = documents;
    (window.pi as unknown as { office: { refreshDocuments: unknown } }).office.refreshDocuments =
      refreshDocuments;

    await useAppStore.getState().loadOfficeDocuments();
    await useAppStore.getState().loadOfficeDocuments();
    expect(documents).toHaveBeenCalledTimes(1);

    await useAppStore.getState().refreshOfficeDocuments();
    expect(refreshDocuments).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().officeDocuments?.status).toBe("unreachable");
  });

  it("toggles the rail", () => {
    useAppStore.getState().toggleRail();
    expect(useAppStore.getState().prefs.rail.open).toBe(true);
    useAppStore.getState().toggleRail();
    expect(useAppStore.getState().prefs.rail.open).toBe(false);
  });

  it("prepends the document tag to the active draft, keeping the user's text", () => {
    useAppStore.getState().setDraft("tab-1", "summarize this");

    const target = useAppStore.getState().chatAboutDocument(excelPane!);

    expect(target).toBe("tab-1");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe(
      '[office:excel "Book1.xlsx" id=url_sha256:aaaa] summarize this',
    );
  });

  it("starts an empty tagged prompt when the composer is blank", () => {
    useAppStore.getState().chatAboutDocument(excelPane!);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe(
      '[office:excel "Book1.xlsx" id=url_sha256:aaaa] ',
    );
  });

  it("is idempotent and never stacks the same tag twice", () => {
    useAppStore.getState().chatAboutDocument(excelPane!);
    useAppStore.getState().chatAboutDocument(excelPane!);
    expect(useAppStore.getState().prefs.drafts["tab-1"]?.match(/\[office:excel/g)).toHaveLength(1);
  });

  it("refuses without a session instead of writing nowhere", () => {
    useAppStore.setState({ activeTabId: null });
    expect(useAppStore.getState().chatAboutDocument(excelPane!)).toBeNull();
    expect(useAppStore.getState().hint).toMatch(/open a session/i);
  });

  it("promotes a tab to the Office host through the session bridge", async () => {
    const promoteOfficeHost = vi.fn(async () => ({
      tabs: [tab({ kind: "office" as const })],
      activeTabId: "tab-1",
    }));
    installBridge();
    (
      window.pi as unknown as { sessions: { promoteOfficeHost: unknown } }
    ).sessions.promoteOfficeHost = promoteOfficeHost;

    const ok = await useAppStore.getState().promoteToOfficeHost("tab-1");

    expect(ok).toBe(true);
    expect(promoteOfficeHost).toHaveBeenCalledWith("tab-1");
    expect(useAppStore.getState().tabs[0]?.kind).toBe("office");
    expect(useAppStore.getState().hint).toMatch(/office host/i);
  });
});
