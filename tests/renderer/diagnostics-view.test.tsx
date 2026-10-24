import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsView } from "../../src/renderer/src/views/DiagnosticsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import type { DiagnosticsSnapshot } from "../../src/shared/diagnostics";
import { installBridge } from "./fixtures";

/**
 * The Diagnostics view (plan step 22): it must show the real evidence — hosts
 * with their log tail, incidents with a fix, extension errors, the Office probe
 * and the allowlisted environment — and offer a redacted export.
 */

function snapshot(overrides: Partial<DiagnosticsSnapshot> = {}): Partial<DiagnosticsSnapshot> {
  return {
    generatedAt: 1_700_000_000_000,
    hosts: [
      {
        tabId: "tab-1",
        role: "session",
        status: "ready",
        cwd: "C:\\work\\app",
        sessionFile: "C:\\profile\\s1.jsonl",
        officeHost: false,
        pid: 4242,
        startedAt: 1_700_000_000_000,
        rssBytes: 268_435_456,
        logLines: ["spawned node host.mjs\n", "resumed session\n"],
      },
    ],
    capacity: {
      hosts: { used: 1, limit: 8, atCapacity: false },
      tabs: { used: 1, limit: 8, atCapacity: false },
    },
    memory: { budgetBytes: 536_870_912, restartBytes: 1_610_612_736 },
    startup: {
      startedAt: 1,
      appReadyAt: 100,
      windowInteractiveAt: 1_200,
      sessionReadyAt: null,
      sessionWarm: false,
      appReadyMs: 99,
      windowInteractiveMs: 1_199,
      sessionReadyMs: null,
      windowInteractive: {
        label: "Window interactive",
        budgetMs: 2_500,
        actualMs: 1_199,
        status: "met",
      },
      sessionReady: {
        label: "Warm session ready",
        budgetMs: 5_000,
        actualMs: null,
        status: "unknown",
      },
      status: "unknown",
    },
    incidents: [
      {
        id: "inc-1",
        kind: "host_crash",
        severity: "error",
        message: "host for tab-1 crashed",
        at: 1_700_000_000_000,
        recoverable: true,
        fix: "Restart the session — history is on disk.",
      },
    ],
    extensionErrors: [
      {
        tabId: "tab-1",
        extensionId: "C:/ext/workflow/extension.ts",
        message: "boom",
        at: 1_700_000_000_000,
      },
    ],
    office: {
      available: true,
      status: "ok",
      port: 38617,
      protocolVersion: 3,
      panes: 2,
    },
    environment: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: "C:\\Users\\test\\.pi\\agent" },
    ...overrides,
  };
}

beforeEach(() => {
  useAppStore.setState({ info: null, diagnostics: null, diagnosticsError: null });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  });
});

describe("DiagnosticsView", () => {
  it("renders hosts, incidents, extension errors and the Office probe", async () => {
    installBridge({ diagnostics: snapshot() });
    render(<DiagnosticsView />);

    expect(await screen.findByTestId("diagnostics-hosts")).toBeInTheDocument();
    expect(screen.getByText(/pid 4242/)).toBeInTheDocument();
    expect(screen.getByText(/resumed session/)).toBeInTheDocument();
    // Per-host RSS and the used/limit caps (plan step 24).
    expect(screen.getByText(/RSS 256 MB/)).toBeInTheDocument();
    expect(screen.getByTestId("diagnostics-hosts")).toHaveTextContent("1/8 hosts");
    expect(screen.getByTestId("diagnostics-hosts")).toHaveTextContent("512 MB");
    expect(screen.getByTestId("diagnostics-startup")).toHaveTextContent("1.2 s");
    expect(screen.getByText("host for tab-1 crashed")).toBeInTheDocument();
    expect(screen.getByText(/Restart the session/)).toBeInTheDocument();
    expect(screen.getByTestId("diagnostics-extension-errors")).toHaveTextContent("boom");
    expect(screen.getByTestId("diagnostics-office")).toHaveTextContent("38617");
    expect(screen.getByTestId("diagnostics-environment")).toHaveTextContent("PI_OFFLINE");
  });

  it("badges safe mode and PI_OFFLINE", async () => {
    installBridge({ appInfo: { safeMode: true }, diagnostics: snapshot() });
    render(<DiagnosticsView />);
    expect(await screen.findByTestId("diagnostics-app")).toHaveTextContent("safe mode");
    expect(screen.getByTestId("diagnostics-app")).toHaveTextContent("PI_OFFLINE");
  });

  it("shows the profile override and warns only while a profile switch is unapplied", async () => {
    installBridge({ appInfo: { profileMode: "shared" }, diagnostics: snapshot() });
    useAppStore.setState({
      info: { profileMode: "shared" } as never,
      prefs: { ...useAppStore.getState().prefs, profileMode: "shared" },
    });
    render(<DiagnosticsView />);

    expect(await screen.findByTestId("diagnostics-profile-override")).toHaveTextContent(
      "C:\\Users\\test\\.pi\\agent",
    );
    expect(screen.queryByTestId("diagnostics-profile-stale")).toBeNull();

    // A mode chosen after launch is pending until the app restarts.
    useAppStore.setState({ prefs: { ...useAppStore.getState().prefs, profileMode: "app" } });
    expect(await screen.findByTestId("diagnostics-profile-stale")).toHaveTextContent(
      /restart to apply/,
    );
  });

  it("says so when nothing has failed", async () => {
    installBridge({ diagnostics: snapshot({ hosts: [], incidents: [], extensionErrors: [] }) });
    render(<DiagnosticsView />);
    expect(await screen.findByTestId("diagnostics-incidents")).toHaveTextContent(
      /Nothing has failed/,
    );
    expect(screen.getByTestId("diagnostics-hosts")).toHaveTextContent(/No host process/);
  });

  it("copies the redacted bundle and reports the redaction count", async () => {
    const handles = installBridge({ diagnostics: snapshot() });
    const exportBundle = vi.fn(async () => ({
      text: "bundle text",
      redactions: 2,
      generatedAt: 0,
    }));
    (handles.bridge.diagnostics as unknown as { export: unknown }).export = exportBundle;
    render(<DiagnosticsView />);

    await userEvent.click(await screen.findByRole("button", { name: /copy bundle/i }));

    await waitFor(() => expect(exportBundle).toHaveBeenCalledOnce());
    expect(await screen.findByTestId("diagnostics-notice")).toHaveTextContent(/2 secrets redacted/);
  });

  it("saves the bundle through the main process", async () => {
    const handles = installBridge({ diagnostics: snapshot() });
    const save = vi.fn(async () => ({ ok: true, path: "C:\\bundle.txt" }));
    (handles.bridge.diagnostics as unknown as { save: unknown }).save = save;
    render(<DiagnosticsView />);

    await userEvent.click(await screen.findByRole("button", { name: /save bundle/i }));

    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(await screen.findByTestId("diagnostics-notice")).toHaveTextContent("C:\\bundle.txt");
  });

  it("surfaces a failed snapshot load", async () => {
    const handles = installBridge({ diagnostics: snapshot() });
    (handles.bridge.diagnostics as unknown as { get: unknown }).get = async () => {
      throw new Error("main is unavailable");
    };
    render(<DiagnosticsView />);
    expect(await screen.findByRole("alert")).toHaveTextContent("main is unavailable");
  });
});
