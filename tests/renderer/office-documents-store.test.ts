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

/**
 * The default tab **is** the Office host: `chatAboutDocument` only writes in the
 * session that owns bridge port 38617, so the prepend cases need a host. The
 * non-host behaviour has its own describe block below.
 */
function resetStore() {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {}, rail: { ...DEFAULT_PREFS.rail, open: false } },
    project: { path: PROJECT, name: "app" },
    tabs: [tab({ kind: "office", title: "Office" })],
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

  it("prepends the document tag in the host session, keeping the user's text", () => {
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

    const refreshDocuments = vi.spyOn(window.pi.office, "refreshDocuments");
    const ok = await useAppStore.getState().promoteToOfficeHost("tab-1");

    expect(ok).toBe(true);
    expect(promoteOfficeHost).toHaveBeenCalledWith("tab-1");
    expect(useAppStore.getState().tabs[0]?.kind).toBe("office");
    expect(useAppStore.getState().hint).toMatch(/office host/i);
    // The takeover returns before the bridge binds the port, so the copy must not
    // claim the bridge is already live.
    expect(useAppStore.getState().hint).toMatch(/re-binds port 38617/i);
    expect(useAppStore.getState().hint).not.toMatch(/\(bridge port 38617\)/i);
    // The new host serves the pane registry, so the old list is re-probed rather
    // than left on screen until the next 5 s poll.
    expect(refreshDocuments).toHaveBeenCalled();
    expect(useAppStore.getState().promotingOfficeHost).toBe(false);
  });

  it("re-reads the pane registry after a host restart", async () => {
    // A restart is the documented fix for a bridge that never bound the port, so
    // the panel must not keep saying "waiting" until the next 5 s poll.
    installBridge();
    const refreshDocuments = vi.spyOn(window.pi.office, "refreshDocuments");

    await useAppStore.getState().restartTab("tab-1");

    expect(refreshDocuments).toHaveBeenCalled();
  });

  it("surfaces a failed takeover verbatim and clears the busy flag", async () => {
    // A port the app cannot free rolls back on the main side; the renderer must
    // report why instead of silently keeping the old host.
    installBridge();
    (
      window.pi as unknown as { sessions: { promoteOfficeHost: unknown } }
    ).sessions.promoteOfficeHost = vi.fn(async () => {
      throw new Error("port 38617 is held by evil.exe (pid 7)");
    });

    const ok = await useAppStore.getState().promoteToOfficeHost("tab-1");

    expect(ok).toBe(false);
    expect(useAppStore.getState().hint).toContain("evil.exe");
    expect(useAppStore.getState().promotingOfficeHost).toBe(false);
  });

  it("ignores a second click while a promotion is in flight", async () => {
    installBridge();
    let release: (() => void) | null = null;
    const promoteOfficeHost = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ tabs: [tab({ kind: "office" as const })], activeTabId: "tab-1" });
        }),
    );
    (
      window.pi as unknown as { sessions: { promoteOfficeHost: unknown } }
    ).sessions.promoteOfficeHost = promoteOfficeHost;

    const first = useAppStore.getState().promoteToOfficeHost("tab-1");
    // The recovery restarts two hosts and re-binds a port; a double click must
    // not queue a second round.
    const second = await useAppStore.getState().promoteToOfficeHost("tab-1");
    expect(second).toBe(false);

    release!();
    await first;

    expect(promoteOfficeHost).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().promotingOfficeHost).toBe(false);
  });
});

describe("chat about this follows the host session", () => {
  const PANE = excelPane!;

  it("leaves the draft untouched and explains in a non-host session", () => {
    useAppStore.getState().setDraft("tab-1", "keep me");
    useAppStore.setState({
      // The host is another tab; this one is a sibling in the same project.
      tabs: [
        tab({ id: "tab-1", cwd: PROJECT }),
        tab({ id: "tab-office", kind: "office", title: "Office" }),
      ],
      activeTabId: "tab-1",
    });

    const target = useAppStore.getState().chatAboutDocument(PANE);

    expect(target).toBeNull();
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("keep me");
    // The hint names the host and the one action that fixes it.
    const hint = useAppStore.getState().hint ?? "";
    expect(hint).toMatch(/Office/);
    expect(hint).toMatch(/use this session instead/i);
  });

  it("never writes a tag, even into an empty draft", () => {
    useAppStore.setState({
      tabs: [tab({ id: "tab-1" }), tab({ id: "tab-office", kind: "office" })],
      activeTabId: "tab-1",
    });
    useAppStore.getState().chatAboutDocument(PANE);
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBeUndefined();
  });

  it("points at starting a session when no host exists at all", () => {
    useAppStore.setState({ tabs: [tab({ id: "tab-1" })], activeTabId: "tab-1" });
    expect(useAppStore.getState().chatAboutDocument(PANE)).toBeNull();
    expect(useAppStore.getState().hint).toMatch(/start an office session/i);
  });

  it("ignores a stopped office tab as a host", () => {
    useAppStore.setState({
      tabs: [tab({ id: "tab-1" }), tab({ id: "tab-office", kind: "office", status: "stopped" })],
      activeTabId: "tab-1",
    });
    expect(useAppStore.getState().chatAboutDocument(PANE)).toBeNull();
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBeUndefined();
  });

  it("still prepends exactly once in the host session", () => {
    useAppStore.setState({
      tabs: [tab({ id: "tab-office", kind: "office" })],
      activeTabId: "tab-office",
    });
    useAppStore.getState().chatAboutDocument(PANE);
    useAppStore.getState().chatAboutDocument(PANE);
    expect(
      useAppStore.getState().prefs.drafts["tab-office"]?.match(/\[office:excel/g),
    ).toHaveLength(1);
  });
});
