import { describe, expect, it } from "vitest";
import { officeEvidenceLine, type OfficeSetupView } from "../../src/shared/office-setup";

/**
 * The log-safe evidence summary (plan step 19). The Integrations card shows the
 * full picture; this line is what a support log keeps, so it must stay one line
 * and must not grow fields nobody asked for.
 */

function view(overrides: Partial<OfficeSetupView> = {}): OfficeSetupView {
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

describe("officeEvidenceLine", () => {
  it("summarizes an idle wizard without inventing fields", () => {
    const line = officeEvidenceLine(view());
    expect(line).toBe("status=idle port=38617 office=unknown");
    expect(line).not.toContain("\n");
  });

  it("carries the facts a support log needs after a full run", () => {
    const line = officeEvidenceLine(
      view({
        status: "done",
        currentStep: "verify",
        bridge: { status: "already-installed", version: "0.5.0", error: null, installLog: "" },
        detection: {
          os: "windows",
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
        health: {
          status: "ok",
          url: "http://127.0.0.1:38617/health",
          portConflict: false,
          error: null,
          serverName: "pi-office-bridge",
          serverVersion: "0.5.0",
          protocolVersion: 3,
          catalogVersion: 3,
          capabilities: [],
        },
        compatibility: {
          shape: "current",
          protocolVersion: 3,
          targetProtocolVersion: 3,
          serverVersion: "0.5.0",
          catalogVersion: 3,
          supportsDeltas: true,
          supportsAbort: true,
          summary: "",
        },
      }),
    );

    expect(line).toContain("status=done");
    expect(line).toContain("step=verify");
    expect(line).toContain("office=16.0 sideloaded=true");
    expect(line).toContain("bridge=already-installed@0.5.0");
    expect(line).toContain("health=ok");
    expect(line).toContain("compat=current");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("includes the error text a failed run needs to be diagnosable", () => {
    const line = officeEvidenceLine(view({ status: "failed", error: "npm install failed" }));
    expect(line).toContain("status=failed");
    expect(line).toContain("error=npm install failed");
  });
});
