import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { detectOfficeWith } from "../../src/main/office/detect";
import type { OfficeDetectionResult } from "../../src/main/office/types";
import {
  bridgeHealthUrl,
  buildSetupChecklist,
  checkBridgeHealth,
  openOfficeHost,
  parseBridgeHealth,
  waitForPane,
  type BridgeHealthCheck,
  type FetchLike,
  type VerifyDeps,
} from "../../src/main/office/verify";
import { PI_FOR_OFFICE } from "../../src/shared/office";
import { makeDetectDeps } from "./helpers";

const HEALTH_OK = {
  serverName: "pi-office-bridge",
  serverVersion: "0.4.1",
  piVersion: "0.85.1",
  protocolVersion: 2,
  catalogVersion: 3,
  uptimeMs: 12_345,
  capabilities: ["http-health"],
  panes: [
    {
      clientName: "pi-for-office",
      host: "excel",
      documentId: "url_sha256:abc",
      documentName: "Budget.xlsx",
      focused: true,
      visible: true,
      windows: 1,
      ops: 34,
      model: "sonnet",
      provider: "anthropic",
    },
  ],
};

interface FetchStep {
  status?: number;
  body?: string;
  throw?: Error;
}

function fakeDeps(steps: readonly FetchStep[]): { deps: VerifyDeps; fetchCount: () => number } {
  let clock = 0;
  let index = 0;
  const fetchImpl: FetchLike = async () => {
    const step = steps[Math.min(index, steps.length - 1)] ?? {};
    index += 1;
    if (step.throw) throw step.throw;
    return {
      ok: (step.status ?? 200) < 400,
      status: step.status ?? 200,
      text: async () => step.body ?? "",
    };
  };
  return {
    deps: { fetch: fetchImpl, now: () => clock, sleep: async (ms) => void (clock += ms) },
    fetchCount: () => index,
  };
}

async function windowsDetection(
  installedHosts: readonly ("excel" | "word" | "powerpoint")[] = ["excel"],
): Promise<OfficeDetectionResult> {
  const programFiles = "C:\\Program Files";
  const excelExe = path.join(programFiles, "Microsoft Office", "root", "Office16", "EXCEL.EXE");
  const wordExe = path.join(programFiles, "Microsoft Office", "root", "Office16", "WINWORD.EXE");
  const files: Record<string, string> = {};
  if (installedHosts.includes("excel")) files[excelExe] = "MZ";
  if (installedHosts.includes("word")) files[wordExe] = "MZ";
  const { deps } = makeDetectDeps({
    platform: "win32",
    env: { ProgramFiles: programFiles, LOCALAPPDATA: path.join("C:", "la") },
    homedir: "C:\\Users\\Test",
    files,
    commands: [],
  });
  return detectOfficeWith(deps);
}

describe("bridgeHealthUrl", () => {
  it("targets the loopback bridge health endpoint", () => {
    expect(bridgeHealthUrl()).toBe("http://127.0.0.1:38617/health");
    expect(bridgeHealthUrl(39000)).toBe("http://127.0.0.1:39000/health");
  });
});

describe("parseBridgeHealth", () => {
  it("parses the protocol v2 payload", () => {
    const health = parseBridgeHealth(HEALTH_OK);
    expect(health).toMatchObject({
      serverName: "pi-office-bridge",
      serverVersion: "0.4.1",
      protocolVersion: 2,
      catalogVersion: 3,
    });
    expect(health?.panes).toEqual([
      {
        clientName: "pi-for-office",
        host: "excel",
        documentId: "url_sha256:abc",
        documentName: "Budget.xlsx",
        focused: true,
        visible: true,
        windows: 1,
        ops: 34,
        model: "sonnet",
        provider: "anthropic",
      },
    ]);
  });

  it("tolerates missing panes and odd values", () => {
    const health = parseBridgeHealth({
      serverName: "pi-office-bridge",
      panes: [42, {}, { host: "nope" }],
    });
    expect(health?.panes).toHaveLength(2);
    expect(health?.panes[0]?.host).toBeNull();
    expect(health?.panes[1]?.host).toBeNull();
    expect(health?.capabilities).toEqual([]);
  });

  it("returns null for non-object payloads", () => {
    expect(parseBridgeHealth(null)).toBeNull();
    expect(parseBridgeHealth("nope")).toBeNull();
    expect(parseBridgeHealth([])).toBeNull();
  });
});

describe("checkBridgeHealth", () => {
  it("reports ok for the Pi bridge", async () => {
    const { deps } = fakeDeps([{ body: JSON.stringify(HEALTH_OK) }]);
    const check = await checkBridgeHealth(deps);
    expect(check.status).toBe("ok");
    expect(check.portConflict).toBe(false);
    expect(check.health?.panes).toHaveLength(1);
    expect(check.error).toBeNull();
  });

  it("detects a port conflict with a different service", async () => {
    const { deps } = fakeDeps([{ body: JSON.stringify({ serverName: "some-other-app" }) }]);
    const check = await checkBridgeHealth(deps);
    expect(check.status).toBe("not-our-bridge");
    expect(check.portConflict).toBe(true);
    expect(check.error).toContain("instead of the Pi Office bridge");
  });

  it("detects a non-JSON response on the port", async () => {
    const { deps } = fakeDeps([{ body: "<html>hello</html>" }]);
    const check = await checkBridgeHealth(deps);
    expect(check.status).toBe("not-our-bridge");
    expect(check.portConflict).toBe(true);
    expect(check.error).toContain("non-JSON body");
  });

  it("reports unreachable when nothing listens", async () => {
    const { deps } = fakeDeps([{ throw: new Error("connect ECONNREFUSED 127.0.0.1:38617") }]);
    const check = await checkBridgeHealth(deps);
    expect(check.status).toBe("unreachable");
    expect(check.portConflict).toBe(false);
    expect(check.error).toContain("unreachable");
  });
});

describe("waitForPane", () => {
  it("attaches as soon as a pane appears", async () => {
    const empty = JSON.stringify({ ...HEALTH_OK, panes: [] });
    const { deps } = fakeDeps([
      { body: empty },
      { body: empty },
      { body: JSON.stringify(HEALTH_OK) },
    ]);
    const polls: number[] = [];

    const result = await waitForPane(deps, {
      pollIntervalMs: 1_000,
      timeoutMs: 30_000,
      onPoll: (_check, elapsed) => polls.push(elapsed),
    });

    expect(result.status).toBe("attached");
    expect(result.polls).toBe(3);
    expect(result.panes).toHaveLength(1);
    expect(result.panes[0]?.documentName).toBe("Budget.xlsx");
    expect(result.waitedMs).toBe(2_000);
    expect(polls).toEqual([0, 1_000, 2_000]);
  });

  it("honours the expected host filter", async () => {
    const wordOnly = JSON.stringify({
      ...HEALTH_OK,
      panes: [{ ...HEALTH_OK.panes[0], host: "word", documentName: "Report.docx" }],
    });
    const { deps } = fakeDeps([{ body: wordOnly }]);

    const excel = await waitForPane(deps, {
      hosts: ["excel"],
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
    });
    expect(excel.status).toBe("timeout");

    const word = await waitForPane(deps, {
      hosts: ["word"],
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
    });
    expect(word.status).toBe("attached");
    expect(word.panes[0]?.documentName).toBe("Report.docx");
  });

  it("times out with an actionable error", async () => {
    const { deps } = fakeDeps([{ body: JSON.stringify({ ...HEALTH_OK, panes: [] }) }]);
    const result = await waitForPane(deps, { timeoutMs: 5_000, pollIntervalMs: 1_000 });
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("within 5s");
  });

  it("surfaces a port conflict at timeout instead of a generic message", async () => {
    const { deps } = fakeDeps([{ body: JSON.stringify({ serverName: "some-other-app" }) }]);
    const result = await waitForPane(deps, { timeoutMs: 2_000, pollIntervalMs: 1_000 });
    expect(result.status).toBe("timeout");
    expect(result.error).toContain("instead of the Pi Office bridge");
  });

  it("can be cancelled", async () => {
    const controller = new AbortController();
    const { deps } = fakeDeps([{ body: JSON.stringify({ ...HEALTH_OK, panes: [] }) }]);
    controller.abort();
    const result = await waitForPane(deps, { signal: controller.signal });
    expect(result.status).toBe("aborted");
    expect(result.error).toContain("cancelled");
  });
});

describe("openOfficeHost", () => {
  it("launches the detected executable through shell.openPath", async () => {
    const detection = await windowsDetection(["excel", "word"]);
    const opened: string[] = [];
    const result = await openOfficeHost({
      host: "excel",
      detection,
      openPath: async (target) => {
        opened.push(target);
        return "";
      },
    });
    expect(result.ok).toBe(true);
    expect(result.usedWebFallback).toBe(false);
    expect(result.path).toContain("EXCEL.EXE");
    expect(opened).toHaveLength(1);
  });

  it("reports a launch failure", async () => {
    const detection = await windowsDetection(["excel"]);
    const result = await openOfficeHost({
      host: "excel",
      detection,
      openPath: async () => "The file could not be opened",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("The file could not be opened");
  });

  it("falls back to Office on the web when the executable path is unknown", async () => {
    const detection = await windowsDetection([]);
    // Simulate a Click-to-Run install with no resolvable path.
    detection.apps = detection.apps.map((app) =>
      app.host === "word" ? { ...app, installed: true, evidence: "click-to-run" } : app,
    );
    const external: string[] = [];
    const result = await openOfficeHost({
      host: "word",
      detection,
      openExternal: async (url) => void external.push(url),
    });
    expect(result.ok).toBe(true);
    expect(result.usedWebFallback).toBe(true);
    expect(result.note).toContain("executable path is unknown");
    expect(external).toEqual([PI_FOR_OFFICE.officeOnTheWebUrl]);
  });

  it("falls back to Office on the web when the app is missing", async () => {
    const detection = await windowsDetection([]);
    const result = await openOfficeHost({
      host: "powerpoint",
      detection,
      openExternal: async () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.usedWebFallback).toBe(true);
    expect(result.note).toContain("was not detected");
  });

  it("fails when it has no way to open anything", async () => {
    const detection = await windowsDetection([]);
    const result = await openOfficeHost({ host: "excel", detection });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No way to open");
  });
});

describe("buildSetupChecklist", () => {
  const okHealth = parseBridgeHealth(HEALTH_OK);
  const okCheck: BridgeHealthCheck = {
    status: "ok",
    url: bridgeHealthUrl(),
    httpStatus: 200,
    health: okHealth,
    portConflict: false,
    error: null,
    durationMs: 3,
  };

  it("reports every step green in the happy path", async () => {
    const detection = await windowsDetection(["excel"]);
    const steps = buildSetupChecklist({
      detection,
      bridge: {
        status: "installed",
        packageName: "@dieulc/pi-office-bridge",
        version: "0.4.1",
        error: null,
      },
      sideload: { ok: true, verified: true, error: null, platform: "windows" },
      openOffice: {
        ok: true,
        host: "excel",
        path: "EXCEL.EXE",
        usedWebFallback: false,
        note: null,
        error: null,
      },
      health: okCheck,
      panes: okHealth?.panes ?? [],
    });

    expect(steps.map((step) => step.id)).toEqual([
      "detect",
      "bridge-package",
      "sideload",
      "open-office",
      "bridge-listening",
      "pane-attached",
    ]);
    expect(steps.every((step) => step.status === "ok")).toBe(true);
    expect(steps[5]?.detail).toContain("Excel · Budget.xlsx (focused)");
  });

  it("surfaces an npm failure with retry actions", async () => {
    const steps = buildSetupChecklist({
      detection: await windowsDetection(["excel"]),
      bridge: {
        status: "failed",
        packageName: "@dieulc/pi-office-bridge",
        version: null,
        error: "npm ERR! 404 Not Found",
      },
      sideload: null,
      openOffice: null,
      health: null,
      panes: [],
    });
    const step = steps.find((candidate) => candidate.id === "bridge-package");
    expect(step?.status).toBe("failed");
    expect(step?.detail).toContain("404");
    expect(step?.actions.length).toBeGreaterThan(0);
  });

  it("explains a port conflict", () => {
    const steps = buildSetupChecklist({
      detection: null,
      bridge: null,
      sideload: null,
      openOffice: null,
      health: {
        ...okCheck,
        status: "not-our-bridge",
        portConflict: true,
        health: null,
        error: "Port 38617 is served by x",
      },
      panes: [],
    });
    const step = steps.find((candidate) => candidate.id === "bridge-listening");
    expect(step?.status).toBe("failed");
    expect(step?.actions.join(" ")).toContain("38617");
  });

  it("marks the pane step as waiting while Office is open", async () => {
    const steps = buildSetupChecklist({
      detection: await windowsDetection(["excel"]),
      bridge: null,
      sideload: { ok: true, verified: true, error: null, platform: "windows" },
      openOffice: {
        ok: true,
        host: "excel",
        path: "EXCEL.EXE",
        usedWebFallback: false,
        note: null,
        error: null,
      },
      health: okCheck,
      panes: [],
    });
    const step = steps.find((candidate) => candidate.id === "pane-attached");
    expect(step?.status).toBe("running");
    expect(step?.actions.join(" ")).toContain("Insert → My Add-ins");
  });

  it("fails the detection step on an unsupported platform", async () => {
    const { deps } = makeDetectDeps({ platform: "linux", env: {}, homedir: "/home/test" });
    const detection = await detectOfficeWith(deps);
    const steps = buildSetupChecklist({
      detection,
      bridge: null,
      sideload: null,
      openOffice: null,
      health: null,
      panes: [],
    });
    const step = steps.find((candidate) => candidate.id === "detect");
    expect(step?.status).toBe("failed");
    expect(step?.actions.join(" ")).toContain("office.com");
  });
});
