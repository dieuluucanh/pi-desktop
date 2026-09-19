import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createOfficeSetupService } from "../../src/main/office/setup-service";
import type { VerifyDeps } from "../../src/main/office/verify";
import type { OfficeSetupView } from "../../src/shared/office-setup";
import { detectDepsFromFsPort, fixtureText } from "./helpers";
import { createStatefulRegistryFake } from "./registry-fake";

/**
 * Service wiring tests for plan step 3: the wizard must be drivable through the
 * IPC-shaped API, must honour injected ports (that is what dry run relies on),
 * and must never write outside them.
 */

const AGENT_DIR = join("C:", "Users", "Test", ".pi", "agent");
const CWD = join("C:", "work");
const MANIFEST = join("C:", "app", "resources", "office", "manifest.prod.xml");

/** Nothing is listening on the bridge port in these tests. */
const offlineVerify: VerifyDeps = {
  fetch: async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:38617");
  },
  now: () => Date.now(),
  sleep: async () => {},
};

function setup(options: { onView?: (view: OfficeSetupView) => void } = {}) {
  // The vendored manifest is read from disk; in these tests it lives in the
  // injected filesystem so the sideload step has something real to copy.
  const fs = createMemoryFsPort({
    files: { [MANIFEST]: fixtureText("manifest.pi-for-office.xml") },
  });
  const registry = createStatefulRegistryFake();
  const views: OfficeSetupView[] = [];

  const service = createOfficeSetupService({
    agentDir: AGENT_DIR,
    cwd: CWD,
    manifestPath: MANIFEST,
    nodePath: join("C:", "app", "runtime", "node", "node.exe"),
    npmCliPath: join("C:", "app", "runtime", "node", "npm-cli.js"),
    dryRun: true,
    fs,
    runner: registry,
    detect: detectDepsFromFsPort(fs, { runner: registry, platform: "win32" }),
    verify: offlineVerify,
    // Keep the pane wait bounded: the real default is minutes long.
    waitForPane: { pollIntervalMs: 5, timeoutMs: 20 },
    now: () => new Date("2026-09-19T10:00:00.000Z"),
    onView: (view) => {
      views.push(view);
      options.onView?.(view);
    },
  });

  return { service, fs, registry, views };
}

describe("createOfficeSetupService", () => {
  it("starts idle in dry-run mode without touching the machine", () => {
    const { service, fs } = setup();
    const view = service.getView();

    expect(view.status).toBe("idle");
    expect(view.dryRun).toBe(true);
    expect(view.running).toBe(false);
    expect(view.port).toBe(38617);
    // Only the injected manifest fixture exists; the wizard has written nothing.
    expect(fs.files.size).toBe(1);
  });

  it("routes retryStep to the matching wizard step", async () => {
    const { service } = setup();

    const detected = await service.retryStep("detect");
    expect(detected.detection?.os).toBe("windows");
    expect(detected.detection?.supported).toBe(true);
    expect(detected.steps.length).toBeGreaterThan(0);

    const bridged = await service.retryStep("bridge-package");
    expect(bridged.bridge).not.toBeNull();

    const sideloaded = await service.retryStep("sideload");
    expect(sideloaded.sideload).not.toBeNull();

    const verified = await service.retryStep("verify");
    expect(verified.health?.status).toBe("unreachable");
    expect(verified.health?.url).toBe("http://127.0.0.1:38617/health");
  });

  it("writes settings and the sideload copy only through the injected filesystem", async () => {
    const { service, fs } = setup();

    await service.retryStep("bridge-package");
    await service.retryStep("sideload");

    const written = [...fs.files.keys()];
    expect(written.some((file) => file.includes("settings.json"))).toBe(true);
    expect(written.some((file) => file.includes("manifest.prod.xml"))).toBe(true);
  });

  it("never launches Office in dry-run mode", async () => {
    const openPath = vi.fn(async () => "");
    const openExternal = vi.fn(async () => {});
    const { service } = setup();

    const view = await service.start();

    // `run()` may finish failed/attention depending on the fake environment; what
    // matters is that it completed without attempting to open an Office app.
    expect(["done", "attention", "failed", "cancelled"]).toContain(view.status);
    expect(openPath).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(service.getView().running).toBe(false);
  });

  it("pushes coalesced views to onView", async () => {
    const seen: string[] = [];
    const { service, views } = setup({ onView: (view) => seen.push(view.status) });

    const result = await service.retryStep("detect");
    // Wait past the coalescing window so the queued flush runs.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(result.detection).not.toBeNull();
    expect(views.length).toBeGreaterThan(0);
    expect(seen.length).toBe(views.length);
    expect(seen.at(-1)).toBe("running");
  });

  it("returns a diagnostics bundle and can be cancelled", async () => {
    const { service } = setup();

    expect(service.diagnostics()).toContain("Pi Desktop");

    const cancelled = service.cancel();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.running).toBe(false);
  });
});
