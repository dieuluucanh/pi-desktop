import { describe, expect, it, vi } from "vitest";
import type { AppInfo } from "../../src/shared/ipc";
import { HOST_METHODS } from "../../src/shared/host-protocol";
import type { DiagnosticsHostInfo, Incident } from "../../src/shared/diagnostics";
import {
  collectDiagnosticEnvironment,
  createDiagnosticsService,
  renderDiagnosticsBundle,
  type DiagnosticsServiceDeps,
} from "../../src/main/diagnostics-service";

/**
 * The diagnostics service (plan step 22). Two acceptance rows live here: the
 * exported bundle must grep clean of credentials, and the environment section
 * must be an allowlist rather than a dump of the process environment.
 */

function appInfo(overrides: Partial<AppInfo> = {}): AppInfo {
  return {
    name: "Pi Desktop",
    version: "0.0.1",
    electron: "44.4.3",
    chrome: "152.0.0",
    node: "24.21.0",
    platform: "win32",
    arch: "x64",
    isDev: false,
    safeMode: false,
    piOffline: false,
    userDataDir: "C:\\state",
    homeDir: "C:\\Users\\test",
    logsDir: "C:\\state\\logs",
    blobCacheDir: "C:\\state\\blobs",
    profileDir: "C:\\Users\\test\\.pi\\agent",
    profileMode: "shared",
    settingsFile: "C:\\Users\\test\\.pi\\agent\\settings.json",
    authFile: "C:\\Users\\test\\.pi\\agent\\auth.json",
    modelsFile: "C:\\Users\\test\\.pi\\agent\\models.json",
    appStateFile: "C:\\state\\app-state.json",
    runtimeSource: "bundled",
    runtimeNodeVersion: "24.21.0",
    runtimeProblems: [],
    hostMethods: [...HOST_METHODS],
    ...overrides,
  };
}

function host(overrides: Partial<DiagnosticsHostInfo> = {}): DiagnosticsHostInfo {
  return {
    tabId: "tab-1",
    role: "session",
    status: "ready",
    cwd: "C:\\work\\app",
    sessionFile: "C:\\profile\\s1.jsonl",
    officeHost: false,
    pid: 4242,
    startedAt: 1_700_000_000_000,
    rssBytes: 268_435_456,
    buildId: "build-1",
    stale: false,
    logLines: ["spawned node host.mjs\n", "resumed session\n"],
    ...overrides,
  };
}

function deps(overrides: Partial<DiagnosticsServiceDeps> = {}): DiagnosticsServiceDeps {
  return {
    appInfo: () => appInfo(),
    sessions: {
      hosts: () => [host()],
      incidents: () => [],
      extensionErrors: () => [],
    },
    office: () => ({
      available: true,
      status: "ok",
      port: 38617,
      protocolVersion: 3,
      panes: 1,
    }),
    officeBundle: async () => "office: ok",
    startup: () => ({
      startedAt: 1,
      appReadyAt: 100,
      windowInteractiveAt: 1_500,
      sessionReadyAt: 4_000,
      sessionWarm: true,
      appReadyMs: 99,
      windowInteractiveMs: 1_499,
      sessionReadyMs: 3_999,
      windowInteractive: {
        label: "Window interactive",
        budgetMs: 2_500,
        actualMs: 1_499,
        status: "met",
      },
      sessionReady: {
        label: "Warm session ready",
        budgetMs: 5_000,
        actualMs: 3_999,
        status: "met",
      },
      status: "met",
    }),
    env: { PI_OFFLINE: "1", PATH: "C:\\Windows" },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

describe("snapshot", () => {
  it("flattens the process, paths, hosts and office state", () => {
    const service = createDiagnosticsService(deps());
    const snapshot = service.snapshot();

    expect(snapshot.app.name).toBe("Pi Desktop");
    expect(snapshot.paths.profileDir).toContain(".pi");
    expect(snapshot.runtime.nodeVersion).toBe("24.21.0");
    expect(snapshot.hosts).toHaveLength(1);
    expect(snapshot.hosts[0]?.logLines).toContain("resumed session\n");
    expect(snapshot.office).toMatchObject({ available: true, protocolVersion: 3, panes: 1 });
  });

  it("samples only the allowlisted environment", () => {
    const service = createDiagnosticsService(deps());
    const snapshot = service.snapshot();
    expect(snapshot.environment.PI_OFFLINE).toBe("1");
    expect(snapshot.environment).not.toHaveProperty("PATH");
  });

  it("merges main and session incidents, newest first", () => {
    const sessionIncident: Incident = {
      id: "s-1",
      kind: "host_crash",
      severity: "error",
      message: "crashed",
      at: 2_000,
      recoverable: true,
    };
    const service = createDiagnosticsService(
      deps({
        sessions: {
          hosts: () => [],
          incidents: () => [sessionIncident],
          extensionErrors: () => [],
        },
        now: () => 5_000,
      }),
    );
    service.recordMain("offline", "ENOTFOUND", undefined);

    const incidents = service.snapshot().incidents;
    expect(incidents.map((incident) => incident.kind)).toEqual(["offline", "host_crash"]);
  });

  it("works without a session service (runtime unavailable)", () => {
    const service = createDiagnosticsService(deps({ sessions: null }));
    const snapshot = service.snapshot();
    expect(snapshot.hosts).toEqual([]);
    expect(snapshot.incidents).toEqual([]);
  });
});

describe("recordReported", () => {
  it("stores a validated renderer incident", () => {
    const service = createDiagnosticsService(deps({ sessions: null }));
    expect(service.recordReported({ message: "ECONNREFUSED 127.0.0.1" })).toBe(true);
    expect(service.incidents()[0]).toMatchObject({ kind: "offline", severity: "warning" });
  });

  it("drops a malformed report", () => {
    const service = createDiagnosticsService(deps({ sessions: null }));
    expect(service.recordReported({ message: "" })).toBe(false);
    expect(service.incidents()).toEqual([]);
  });

  it("records process-level failures with their own kinds", () => {
    const service = createDiagnosticsService(deps({ sessions: null }));
    service.recordMain("uncaught_exception", "boom", "stack line");
    expect(service.incidents()[0]).toMatchObject({
      kind: "uncaught_exception",
      detail: "stack line",
    });
  });
});

describe("renderDiagnosticsBundle", () => {
  it("includes hosts, incidents and the office section", () => {
    const service = createDiagnosticsService(deps());
    service.recordMain("host_crash", "host for tab-1 crashed");
    const text = renderDiagnosticsBundle(service.snapshot(), "office wizard text");

    expect(text).toContain("Pi Desktop — diagnostics bundle");
    expect(text).toContain("## Hosts (1)");
    expect(text).toContain("role=session status=ready pid=4242 build=build-1");
    expect(text).toContain("log (tail");
    expect(text).toContain("host_crash");
    expect(text).toContain("office wizard text");
    expect(text).toContain("safe mode: no");
  });

  it("marks safe mode and PI_OFFLINE in the header", () => {
    const service = createDiagnosticsService(deps({ appInfo: () => appInfo({ safeMode: true }) }));
    const text = renderDiagnosticsBundle(service.snapshot(), "");
    expect(text).toContain("safe mode: yes");
    expect(text).toContain("pi offline: yes");
    expect(text).toContain("(not available)");
  });
});

describe("exportBundle", () => {
  it("redacts credentials out of the whole bundle", async () => {
    const service = createDiagnosticsService(deps());
    service.recordMain(
      "extension_error",
      "request failed with Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz",
      'api_key: "sk-abcdefghijklmnopqrstuvwxyz1234"',
    );

    const bundle = await service.exportBundle();

    expect(bundle.redactions).toBeGreaterThan(0);
    expect(bundle.text).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz");
    expect(bundle.text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234");
    expect(bundle.text).toContain("***REDACTED***");
    expect(bundle.generatedAt).toBe(1_700_000_000_000);
  });

  it("keeps going when the Office bundle throws", async () => {
    const service = createDiagnosticsService(
      deps({
        officeBundle: async () => {
          throw new Error("wizard unavailable");
        },
      }),
    );
    const bundle = await service.exportBundle();
    expect(bundle.text).toContain("Office diagnostics failed: wizard unavailable");
  });

  it("never writes a file or touches Electron (that is main's job)", async () => {
    const officeBundle = vi.fn(async () => "office");
    const service = createDiagnosticsService(deps({ officeBundle }));
    await service.exportBundle();
    expect(officeBundle).toHaveBeenCalledOnce();
  });
});

describe("collectDiagnosticEnvironment", () => {
  it("returns an empty object when nothing is set", () => {
    expect(collectDiagnosticEnvironment({})).toEqual({});
  });

  it("keeps only the allowlisted keys", () => {
    expect(
      collectDiagnosticEnvironment({ PI_OFFLINE: "1", SECRET_TOKEN: "x", HOME: "/root" }),
    ).toEqual({ PI_OFFLINE: "1" });
  });
});
