import { describe, expect, it } from "vitest";
import {
  applyOfficeIntegrationPatch,
  deriveOfficeIntegrationFacts,
  emptyIntegrationsState,
  findOfficeBridgePackage,
  officeBridgePackageName,
  officeBridgePackageSource,
  sanitizeIntegrationsState,
  sanitizeOfficeIntegrationRecord,
} from "../../src/shared/integrations";
import { PI_OFFICE_BRIDGE } from "../../src/shared/office";
import type { OfficeSetupView } from "../../src/shared/office-setup";

/**
 * The Office integration model (plan step 19): the card's facts are derived,
 * never hand-maintained, and the app-state record round-trips through the same
 * sanitizers the store uses.
 *
 * This suite lives in the node project, so it declares a minimal view fixture
 * instead of importing the renderer fixtures (which need the DOM project).
 */

function officeViewFixture(overrides: Partial<OfficeSetupView> = {}): OfficeSetupView {
  return {
    status: "idle",
    currentStep: null,
    running: false,
    startedAt: null,
    finishedAt: null,
    dryRun: false,
    port: 38617,
    steps: [],
    detection: null,
    bridge: null,
    sideload: null,
    openOffice: null,
    health: null,
    bridgeConnect: null,
    compatibility: null,
    run: null,
    panes: [],
    troubleshooting: [],
    diagnostics: "",
    redactions: 0,
    error: null,
    log: [],
    ...overrides,
  };
}

describe("bridge source", () => {
  it("hands the package manager the same pinned spec the wizard installs", () => {
    expect(officeBridgePackageName()).toBe(PI_OFFICE_BRIDGE.packageName);
    expect(officeBridgePackageSource()).toBe(
      `npm:${PI_OFFICE_BRIDGE.packageName}@${PI_OFFICE_BRIDGE.pinnedVersion}`,
    );
  });
});

describe("findOfficeBridgePackage", () => {
  it("finds the bridge regardless of prefix, version or scope", () => {
    const found = findOfficeBridgePackage([
      { name: "@dieulc/other", installed: true },
      { name: "@dieulc/pi-office-bridge", version: "0.5.2", scope: "user", installed: true },
    ]);
    expect(found).toEqual({ configured: true, installed: true, version: "0.5.2", scope: "user" });
  });

  it("reports a configured-but-missing package distinctly from an absent one", () => {
    expect(findOfficeBridgePackage([{ name: "@dieulc/pi-office-bridge@0.5.0" }])).toEqual({
      configured: true,
      installed: false,
      version: null,
      scope: null,
    });
    expect(findOfficeBridgePackage([])).toEqual({
      configured: false,
      installed: false,
      version: null,
      scope: null,
    });
  });
});

describe("deriveOfficeIntegrationFacts", () => {
  it("is not-installed until the package appears anywhere", () => {
    const facts = deriveOfficeIntegrationFacts({ view: null, packages: [] });
    expect(facts.status).toBe("not-installed");
    expect(facts.installed).toBe(false);
    expect(facts.pinnedVersion).toBe(PI_OFFICE_BRIDGE.pinnedVersion);
    expect(facts.port).toBe(PI_OFFICE_BRIDGE.defaultPort);
    expect(facts.healthStatus).toBeNull();
  });

  it("treats a package-manager install as installed even before the wizard runs", () => {
    const facts = deriveOfficeIntegrationFacts({
      view: null,
      packages: [{ name: "@dieulc/pi-office-bridge", version: "0.5.0", installed: true }],
    });
    expect(facts.installed).toBe(true);
    expect(facts.installedVersion).toBe("0.5.0");
    expect(facts.status).toBe("installed");
  });

  it("reports connected once the bridge answers /health", () => {
    const view = officeViewFixture({
      status: "done",
      bridge: { status: "already-installed", version: "0.5.0", error: null, installLog: "" },
      health: {
        status: "ok",
        url: "http://127.0.0.1:38617/health",
        portConflict: false,
        error: null,
        serverName: "pi-office-bridge",
        serverVersion: "0.5.0",
        protocolVersion: 3,
        catalogVersion: 3,
        capabilities: ["agent-deltas"],
      },
      detection: {
        os: "win32",
        supported: true,
        isWsl: false,
        officeVersion: "16.0",
        products: [],
        apps: [],
        anyAppInstalled: true,
        sideloaded: true,
        sideloadProblems: [],
        notes: [],
        checkedAt: "2026-09-20T10:00:00.000Z",
      },
    });
    const facts = deriveOfficeIntegrationFacts({ view, packages: [] });
    expect(facts.status).toBe("connected");
    expect(facts.protocolVersion).toBe(3);
    expect(facts.catalogVersion).toBe(3);
    expect(facts.sideloaded).toBe(true);
    expect(facts.checkedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(facts.healthUrl).toBe("http://127.0.0.1:38617/health");
  });

  it("marks a failed wizard or a bad health probe as attention", () => {
    const failed = officeViewFixture({ status: "failed", error: "npm install failed" });
    expect(deriveOfficeIntegrationFacts({ view: failed, packages: [] }).status).toBe(
      "not-installed",
    );

    const withBridge = officeViewFixture({
      status: "failed",
      bridge: { status: "installed", version: "0.5.0", error: null, installLog: "" },
    });
    expect(deriveOfficeIntegrationFacts({ view: withBridge, packages: [] }).status).toBe(
      "attention",
    );

    const unreachable = officeViewFixture({
      status: "done",
      bridge: { status: "already-installed", version: "0.5.0", error: null, installLog: "" },
      health: {
        status: "unreachable",
        url: "http://127.0.0.1:38617/health",
        portConflict: false,
        error: "connect ECONNREFUSED",
        serverName: null,
        serverVersion: null,
        protocolVersion: null,
        catalogVersion: null,
        capabilities: [],
      },
    });
    expect(deriveOfficeIntegrationFacts({ view: unreachable, packages: [] }).status).toBe(
      "attention",
    );
  });

  it("prefers the wizard's version when both sources have one", () => {
    const view = officeViewFixture({
      bridge: { status: "installed", version: "0.5.1", error: null, installLog: "" },
    });
    const facts = deriveOfficeIntegrationFacts({
      view,
      packages: [{ name: "@dieulc/pi-office-bridge", version: "0.5.0", installed: true }],
    });
    expect(facts.installedVersion).toBe("0.5.1");
    expect(facts.bridgeStatus).toBe("installed");
  });
});

describe("app-state record", () => {
  it("starts empty and round-trips only valid timestamps", () => {
    expect(sanitizeIntegrationsState(undefined)).toEqual(emptyIntegrationsState());
    const record = sanitizeOfficeIntegrationRecord({
      bridgeInstalledAt: "2026-09-20T10:00:00.000Z",
      lastSetupAt: "not a date",
    });
    expect(record.bridgeInstalledAt).toBe("2026-09-20T10:00:00.000Z");
    expect(record.lastSetupAt).toBeNull();
  });

  it("applies a patch without letting unknown keys through", () => {
    const current = { bridgeInstalledAt: null, lastSetupAt: null };
    const next = applyOfficeIntegrationPatch(current, {
      bridgeInstalledAt: "2026-09-20T10:00:00.000Z",
      somethingElse: "ignored",
    });
    expect(next).toEqual({
      bridgeInstalledAt: "2026-09-20T10:00:00.000Z",
      lastSetupAt: null,
    });
  });

  it("keeps the previous value when a patch omits the key", () => {
    const current = {
      bridgeInstalledAt: "2026-09-20T10:00:00.000Z",
      lastSetupAt: "2026-09-20T11:00:00.000Z",
    };
    expect(applyOfficeIntegrationPatch(current, {})).toEqual(current);
  });
});
