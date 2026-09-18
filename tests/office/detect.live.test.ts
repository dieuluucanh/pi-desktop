/**
 * Live environment probe.
 *
 * This is the real "doctor" run: it executes the actual detection code against
 * this machine (registry, filesystem, app bundles) and prints the diagnostics
 * report. It asserts only invariants that must hold on every platform, so it is
 * safe in CI, and it is the manual acceptance check for step 1.
 *
 *   npx vitest run tests/office/detect.live.test.ts --disable-console-intercept
 */

import { describe, expect, it } from "vitest";

import { detectOfficeEnvironment, formatDetectionReport } from "../../src/main/office/detect";
import { checkBridgeHealth, createDefaultVerifyDeps } from "../../src/main/office/verify";

describe("live environment probe", () => {
  it("detects this machine without throwing and prints a report", async () => {
    const result = await detectOfficeEnvironment();

    const expectedOs =
      process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
    expect(result.os).toBe(expectedOs);
    expect(result.supported).toBe(expectedOs !== "linux");
    expect(result.apps).toHaveLength(3);
    expect(result.apps.map((app) => app.host)).toEqual(["excel", "word", "powerpoint"]);
    expect(new Date(result.checkedAt).toString()).not.toBe("Invalid Date");

    if (expectedOs === "windows") {
      // The registry probe must have run, whether or not Office is installed.
      expect(result.sideload.searched.some((entry) => entry.includes("WEF\\Developer"))).toBe(true);
      expect(result.sideload.searched.some((entry) => /[\\/]Wef$/.test(entry))).toBe(true);
    }

    if (result.sideload.installed) {
      const ours = result.sideload.entries.filter((entry) => entry.matchesPiForOffice);
      expect(ours.length).toBeGreaterThan(0);
      expect(ours.every((entry) => entry.manifestExists)).toBe(true);
    }

    // eslint-disable-next-line no-console
    console.log(`\n${formatDetectionReport(result)}\n`);
  }, 30_000);

  it("probes the local bridge health endpoint without throwing", async () => {
    const check = await checkBridgeHealth(createDefaultVerifyDeps(), { timeoutMs: 2_000 });

    // Either a Pi session is hosting the bridge on this machine, or nothing
    // listens yet — both are valid outcomes; a crash or a false positive is not.
    expect(["ok", "unreachable", "not-our-bridge", "invalid-response"]).toContain(check.status);
    if (check.status === "ok") {
      expect(check.health?.serverName).toBe("pi-office-bridge");
      expect(check.health?.protocolVersion).toBeGreaterThanOrEqual(2);
    } else {
      expect(check.health).toBeNull();
    }

    // eslint-disable-next-line no-console
    console.log(
      `\nbridge ${check.url}\n  status: ${check.status}\n  portConflict: ${check.portConflict}\n  panes: ${
        check.health?.panes.length ?? 0
      }\n  error: ${check.error ?? "(none)"}\n`,
    );
  }, 30_000);
});
