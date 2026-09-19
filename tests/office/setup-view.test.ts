import { describe, expect, it } from "vitest";
import type { BridgePane } from "../../src/main/office/verify";
import { toOfficeSetupView } from "../../src/main/office/setup-view";
import { createOfficeSetupService } from "../../src/main/office/setup-service";
import type { OfficeSetupState } from "../../src/main/office/setup-controller";
import type { OfficeDetectionResult } from "../../src/main/office/types";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createFakeCommandRunner } from "../../src/main/office/exec";

const DETECTION: OfficeDetectionResult = {
  os: "windows",
  supported: true,
  isWsl: false,
  apps: [
    { host: "excel", label: "Excel", installed: true },
    { host: "word", label: "Word", installed: false },
    { host: "powerpoint", label: "PowerPoint", installed: true },
  ],
  anyAppInstalled: true,
  office: {
    version: "16.0.20326.20144",
    platform: "x64",
    products: ["O365HomePremRetail"],
    source: "HKLM\\...\\Configuration",
  },
  sideload: {
    installed: true,
    entries: [],
    searched: ["HKCU\\...\\WEF\\Developer"],
    problems: ["stale entry"],
  },
  officeOnTheWeb: { url: "https://www.office.com/", recommended: false },
  notes: ["registry read ok"],
  checkedAt: "2026-09-19T10:00:00.000Z",
};

const PANE: BridgePane = {
  clientName: "pi-for-office",
  host: "excel",
  documentId: "doc-1",
  documentName: "Budget.xlsx",
  focused: true,
  visible: true,
  windows: 2,
  ops: 34,
  model: "claude-sonnet",
  provider: "anthropic",
};

function baseState(overrides: Partial<OfficeSetupState> = {}): OfficeSetupState {
  const service = createOfficeSetupService({
    agentDir: "C:\\Users\\Test\\.pi\\agent",
    cwd: "C:\\work",
    manifestPath: "C:\\app\\manifest.prod.xml",
    nodePath: null,
    npmCliPath: null,
    dryRun: true,
    fs: createMemoryFsPort(),
    runner: createFakeCommandRunner([]),
    onView: () => {},
  });
  return { ...service.getState(), ...overrides };
}

describe("toOfficeSetupView", () => {
  it("projects a fresh state without inventing data", () => {
    const view = toOfficeSetupView(baseState(), { dryRun: true, port: 38617 });

    expect(view.status).toBe("idle");
    expect(view.running).toBe(false);
    expect(view.dryRun).toBe(true);
    expect(view.port).toBe(38617);
    expect(view.detection).toBeNull();
    expect(view.bridge).toBeNull();
    expect(view.sideload).toBeNull();
    expect(view.health).toBeNull();
    expect(view.panes).toEqual([]);
    expect(view.error).toBeNull();
    // The checklist is produced by detection, so a state that has never run has
    // no steps yet; the panel renders the five known labels as pending instead.
    expect(view.steps).toEqual([]);
  });

  it("maps the checklist once the wizard has run", () => {
    const state = baseState({
      checklist: [
        { id: "detect", title: "Detect Office", status: "ok", detail: "windows", actions: [] },
        {
          id: "bridge-package",
          title: "Install the bridge package",
          status: "failed",
          detail: "npm failed",
          actions: ["Check your network"],
        },
      ],
    });

    const view = toOfficeSetupView(state, { dryRun: false, port: 38617 });

    expect(view.steps.map((step) => step.id)).toEqual(["detect", "bridge-package"]);
    expect(view.steps[1]?.status).toBe("failed");
    expect(view.steps[1]?.actions).toEqual(["Check your network"]);
  });

  it("maps detection, health and panes", () => {
    const state = baseState({
      status: "attention",
      currentStep: "verify",
      detection: DETECTION,
      health: {
        status: "ok",
        url: "http://127.0.0.1:38617/health",
        httpStatus: 200,
        portConflict: false,
        error: null,
        durationMs: 12,
        health: {
          serverName: "pi-office-bridge",
          serverVersion: "0.4.1",
          piVersion: "0.85.1",
          protocolVersion: 2,
          catalogVersion: 3,
          capabilities: ["excel"],
          panes: [PANE],
          raw: { secret: true },
        },
      },
      panes: [PANE],
    });

    const view = toOfficeSetupView(state, { dryRun: false, port: 38617 });

    expect(view.running).toBe(false);
    expect(view.currentStep).toBe("verify");
    expect(view.detection?.officeVersion).toBe("16.0.20326.20144");
    expect(view.detection?.apps.map((app) => app.installed)).toEqual([true, false, true]);
    expect(view.detection?.sideloaded).toBe(true);
    expect(view.detection?.sideloadProblems).toEqual(["stale entry"]);
    expect(view.health?.serverVersion).toBe("0.4.1");
    expect(view.health?.protocolVersion).toBe(2);
    expect(view.panes[0]?.documentName).toBe("Budget.xlsx");
    // The bridge's raw payload must not leak into the renderer contract.
    expect(Object.keys(view.health ?? {})).not.toContain("raw");
  });

  it("flags a running wizard", () => {
    const view = toOfficeSetupView(baseState({ status: "running" }), { dryRun: true, port: 1 });
    expect(view.running).toBe(true);
  });

  it("keeps only the tail of the log", () => {
    const log = Array.from({ length: 100 }, (_value, index) => ({
      at: `2026-09-19T00:00:${String(index).padStart(2, "0")}.000Z`,
      level: "info" as const,
      message: `line ${index}`,
    }));

    const view = toOfficeSetupView(baseState({ log }), { dryRun: true, port: 1, logLimit: 3 });

    expect(view.log.map((entry) => entry.message)).toEqual(["line 97", "line 98", "line 99"]);
  });

  it("carries troubleshooting, diagnostics and the redaction count", () => {
    const state = baseState({
      troubleshooting: [
        {
          id: "port",
          severity: "warning",
          title: "Port busy",
          detail: "38617 in use",
          actions: ["Close the other session"],
        },
      ],
      diagnostics: "bundle text",
      redactions: 4,
      error: "boom",
    });

    const view = toOfficeSetupView(state, { dryRun: false, port: 38617 });

    expect(view.troubleshooting[0]?.severity).toBe("warning");
    expect(view.diagnostics).toBe("bundle text");
    expect(view.redactions).toBe(4);
    expect(view.error).toBe("boom");
  });
});
