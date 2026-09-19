import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryFsPort, type MemoryFsPort } from "../../src/main/fs-port";
import { bridgePackageDir } from "../../src/main/office/bridge-install";
import { OfficeSetupController } from "../../src/main/office/setup-controller";
import {
  buildDiagnosticsBundle,
  buildTroubleshooting,
  redactSecrets,
  type DiagnosticsInput,
} from "../../src/main/office/troubleshoot";
import type { InstallResult, PackageInstaller } from "../../src/main/packages/installer";
import type { FetchLike, VerifyDeps } from "../../src/main/office/verify";
import { PI_FOR_OFFICE, PI_OFFICE_BRIDGE } from "../../src/shared/office";
import { detectDepsFromFsPort } from "./helpers";
import { createStatefulRegistryFake } from "./registry-fake";

const MANIFEST = readFileSync(
  new URL("../../resources/office/manifest.prod.xml", import.meta.url),
  "utf8",
);

const HOME = "C:\\Users\\Test";
const LOCALAPPDATA = path.join(HOME, "AppData", "Local");
const WEF_DIR = path.join(LOCALAPPDATA, "Microsoft", "Office", "16.0", "Wef");
const EXCEL_EXE = path.join(
  "C:\\Program Files",
  "Microsoft Office",
  "root",
  "Office16",
  "EXCEL.EXE",
);
const AGENT_DIR = path.join("C:", "agent");
const CWD = path.join("C:", "work", "proj");
const MANIFEST_SOURCE = path.join("C:", "app", "resources", "office", "manifest.prod.xml");
const NPM_ROOT = path.join(AGENT_DIR, "npm");
const BRIDGE_PKG_JSON = path.join(
  bridgePackageDir(NPM_ROOT, PI_OFFICE_BRIDGE.packageName),
  "package.json",
);
const BRIDGE_ENTRY = path.join(
  bridgePackageDir(NPM_ROOT, PI_OFFICE_BRIDGE.packageName),
  "src",
  "index.ts",
);
const WIN_ENV = { LOCALAPPDATA, ProgramFiles: "C:\\Program Files" };

const EMPTY_HEALTH = {
  serverName: "pi-office-bridge",
  serverVersion: "0.5.0",
  piVersion: "0.85.1",
  protocolVersion: 2,
  catalogVersion: 3,
  capabilities: ["http-health"],
  panes: [],
};

const PANE_HEALTH = {
  ...EMPTY_HEALTH,
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
    },
  ],
};

interface FetchStep {
  body?: string;
  status?: number;
  throw?: Error;
}

function fakeVerify(steps: readonly FetchStep[]): VerifyDeps {
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
  return { fetch: fetchImpl, now: () => clock, sleep: async (ms) => void (clock += ms) };
}

interface InstallerOptions {
  ok?: boolean;
  stderr?: string;
  installVersion?: string | null;
}

function fakeInstaller(fs: MemoryFsPort, options: InstallerOptions = {}): PackageInstaller {
  return {
    description: "fake npm",
    async installAll(root): Promise<InstallResult> {
      const ok = options.ok ?? true;
      const version = options.installVersion ?? "0.5.0";
      if (ok && version !== null) {
        await fs.writeTextFile(
          BRIDGE_PKG_JSON,
          `${JSON.stringify(
            {
              name: PI_OFFICE_BRIDGE.packageName,
              version,
              type: "module",
              pi: { extensions: ["./src/index.ts"] },
            },
            null,
            2,
          )}\n`,
        );
        await fs.writeTextFile(BRIDGE_ENTRY, "export default function () {}\n");
      }
      return {
        ok,
        code: ok ? 0 : 1,
        command: "node",
        args: ["npm-cli.js", "install"],
        cwd: root,
        stdout: "added 1 package",
        stderr: options.stderr ?? "",
        missingRuntime: false,
        durationMs: 4,
      };
    },
  };
}

interface Harness {
  controller: OfficeSetupController;
  fs: MemoryFsPort;
  states: string[];
}

function harness(
  overrides: {
    platform?: NodeJS.Platform;
    fetchSteps?: readonly FetchStep[];
    installer?: InstallerOptions;
    hosts?: readonly ("excel" | "word" | "powerpoint")[];
    openPath?: (target: string) => Promise<string>;
    waitForPane?: { pollIntervalMs?: number; timeoutMs?: number };
    openOfficeApp?: boolean;
    onChange?: (state: ReturnType<OfficeSetupController["getState"]>) => void;
  } = {},
): Harness {
  const platform = overrides.platform ?? "win32";
  const fs = createMemoryFsPort({
    files: { [MANIFEST_SOURCE]: MANIFEST, [EXCEL_EXE]: "MZ" },
    dirs: [LOCALAPPDATA],
  });
  const registry = createStatefulRegistryFake();
  const detect = detectDepsFromFsPort(fs, {
    platform,
    env: WIN_ENV,
    homedir: HOME,
    runner: registry,
  });

  const states: string[] = [];
  const controller = new OfficeSetupController({
    fs,
    agentDir: AGENT_DIR,
    cwd: CWD,
    manifestPath: MANIFEST_SOURCE,
    detect,
    installer: fakeInstaller(fs, overrides.installer ?? {}),
    verify: fakeVerify(overrides.fetchSteps ?? [{ body: JSON.stringify(EMPTY_HEALTH) }]),
    backupDir: path.join(AGENT_DIR, "backups"),
    port: PI_OFFICE_BRIDGE.defaultPort,
    ...(overrides.hosts ? { hosts: overrides.hosts } : {}),
    openPath: overrides.openPath ?? (async () => ""),
    ...(overrides.waitForPane ? { waitForPane: overrides.waitForPane } : {}),
    ...(overrides.openOfficeApp !== undefined ? { openOfficeApp: overrides.openOfficeApp } : {}),
    now: () => new Date("2026-09-18T10:00:00.000Z"),
    env: { PI_OFFICE_BRIDGE_PORT: String(PI_OFFICE_BRIDGE.defaultPort) },
    appInfo: {
      name: "Pi Desktop",
      version: "0.0.1-test",
      electron: "44.4.0",
      node: "24.16.0",
      platform,
      arch: "x64",
      osRelease: "10.0.26100",
    },
    onChange: (state) => {
      states.push(state.status);
      overrides.onChange?.(state);
    },
  });

  return { controller, fs, states };
}

describe("OfficeSetupController.run — happy path", () => {
  it("drives detect → install → sideload → open → verify to done", async () => {
    const { controller, fs, states } = harness({
      fetchSteps: [
        { body: JSON.stringify(EMPTY_HEALTH) }, // refreshHealth
        { body: JSON.stringify(EMPTY_HEALTH) }, // verify poll 1
        { body: JSON.stringify(PANE_HEALTH) }, // verify poll 2
      ],
      waitForPane: { pollIntervalMs: 1_000, timeoutMs: 30_000 },
    });

    const state = await controller.run();

    expect(state.status).toBe("done");
    expect(state.error).toBeNull();
    expect(state.detection?.sideload.installed).toBe(true);
    expect(state.bridge?.status).toBe("installed");
    expect(state.bridge?.state.version).toBe("0.5.0");
    expect(state.sideload?.verified).toBe(true);
    expect(state.openOffice?.ok).toBe(true);
    expect(state.panes).toHaveLength(1);
    expect(state.panes[0]?.documentName).toBe("Budget.xlsx");
    expect(state.finishedAt).toBe("2026-09-18T10:00:00.000Z");

    expect(state.checklist.map((step) => step.status)).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(state.troubleshooting.some((item) => item.id === "connected")).toBe(true);

    // Real writes: settings pinned, npm root built, manifest registered+detected.
    expect(await fs.readTextFile(path.join(AGENT_DIR, "settings.json"))).toContain(
      "npm:@dieulc/pi-office-bridge@^0.5.0",
    );
    expect(await fs.readTextFile(path.join(WEF_DIR, "manifest.prod.xml"))).toBe(MANIFEST);

    // Live updates reached the observer.
    expect(states.filter((status) => status === "running").length).toBeGreaterThan(3);
    expect(states.at(-1)).toBe("done");

    // Diagnostics are populated and redacted.
    expect(state.diagnostics).toContain("Pi Desktop — diagnostics bundle");
    expect(state.diagnostics).toContain("## Bridge health");
    expect(state.diagnostics).toContain("status: ok");
    expect(state.diagnostics).toContain("pi-office-bridge");
  });

  it("records the install log lines in the wizard log", async () => {
    const { controller } = harness({
      fetchSteps: [{ body: JSON.stringify(PANE_HEALTH) }],
      installer: { stderr: "" },
    });
    const state = await controller.run();
    expect(state.log.some((entry) => entry.message.includes("[npm] added 1 package"))).toBe(true);
    expect(state.log.some((entry) => entry.message.includes("[bridge] install"))).toBe(true);
  });
});

describe("OfficeSetupController.run — failure and attention paths", () => {
  it("reports attention when another program owns the bridge port", async () => {
    const { controller } = harness({
      fetchSteps: [{ body: JSON.stringify({ serverName: "some-other-app" }) }],
      waitForPane: { pollIntervalMs: 1_000, timeoutMs: 3_000 },
    });

    const state = await controller.run();

    expect(state.status).toBe("attention");
    expect(state.error).toContain("instead of the Pi Office bridge");
    const item = state.troubleshooting.find((candidate) => candidate.id === "port-in-use");
    expect(item?.severity).toBe("error");
    expect(item?.actions.join(" ")).toContain("findstr");
    expect(state.checklist.find((step) => step.id === "bridge-listening")?.status).toBe("failed");
  });

  it("fails when the bridge package cannot be installed", async () => {
    const { controller } = harness({
      installer: { ok: false, stderr: "npm ERR! 404 Not Found" },
      fetchSteps: [{ body: JSON.stringify(EMPTY_HEALTH) }],
    });

    const state = await controller.run();

    expect(state.status).toBe("failed");
    expect(state.bridge?.status).toBe("failed");
    expect(state.sideload).toBeNull();
    expect(state.troubleshooting.some((item) => item.id === "bridge-install-failed")).toBe(true);
    expect(state.diagnostics).toContain("404 Not Found");
  });

  it("needs attention on an unsupported platform without installing anything", async () => {
    const { controller } = harness({
      platform: "linux",
      fetchSteps: [{ body: JSON.stringify(EMPTY_HEALTH) }],
    });

    const state = await controller.run();

    expect(state.status).toBe("attention");
    expect(state.detection?.supported).toBe(false);
    expect(state.bridge).toBeNull();
    expect(state.sideload).toBeNull();
    expect(state.troubleshooting.some((item) => item.id === "platform-unsupported")).toBe(true);
    expect(state.diagnostics).toContain("office.com");
  });

  it("can be cancelled while waiting for the task pane", async () => {
    const { controller } = harness({
      fetchSteps: [{ body: JSON.stringify(EMPTY_HEALTH) }],
      waitForPane: { pollIntervalMs: 1_000, timeoutMs: 60_000 },
      onChange: (state) => {
        if (state.currentStep === "verify") controller.cancel();
      },
    });

    const state = await controller.run();

    expect(state.status).toBe("cancelled");
    expect(state.log.some((entry) => entry.message.includes("cancelled"))).toBe(true);
  });

  it("recovers the sideload step individually after a failure", async () => {
    const { controller, fs } = harness({ fetchSteps: [{ body: JSON.stringify(PANE_HEALTH) }] });
    await controller.detect();
    // Break the sideload by removing the manifest the wizard points at.
    await fs.remove(MANIFEST_SOURCE);
    const failed = await controller.sideload();
    expect(failed.sideload?.ok).toBe(false);

    // Restore it and re-run just that step (idempotent).
    await fs.writeTextFile(MANIFEST_SOURCE, MANIFEST);
    const recovered = await controller.sideload();
    expect(recovered.sideload?.ok).toBe(true);
    expect(recovered.sideload?.verified).toBe(true);
  });
});

describe("buildTroubleshooting", () => {
  const base = {
    platform: "windows" as const,
    isWsl: false,
    bridge: null,
    sideload: null,
    health: null,
    panes: [],
    port: PI_OFFICE_BRIDGE.defaultPort,
  };

  it("explains a missing Office install", () => {
    const items = buildTroubleshooting({
      ...base,
      detection: {
        os: "windows",
        supported: true,
        isWsl: false,
        apps: [],
        anyAppInstalled: false,
        office: { version: null, platform: null, products: [], source: null },
        sideload: { installed: false, entries: [], searched: [], problems: [] },
        officeOnTheWeb: { url: PI_FOR_OFFICE.officeOnTheWebUrl, recommended: true },
        notes: [],
        checkedAt: "2026-09-18T00:00:00.000Z",
      },
    });
    const item = items.find((candidate) => candidate.id === "office-not-installed");
    expect(item?.severity).toBe("warning");
    expect(item?.actions.join(" ")).toContain("office.com");
  });

  it("warns about WSL", () => {
    // Health/bridge/WSL diagnostics must not depend on detection having run.
    const withoutDetection = buildTroubleshooting({ ...base, isWsl: true, detection: null });
    expect(withoutDetection.some((item) => item.id === "wsl")).toBe(true);
    expect(withoutDetection.some((item) => item.id === "no-detection")).toBe(true);
    // Warnings sort ahead of the informational "not inspected yet" item.
    expect(withoutDetection[0]?.id).toBe("wsl");

    const withDetection = buildTroubleshooting({
      ...base,
      isWsl: true,
      detection: {
        os: "linux",
        supported: false,
        isWsl: true,
        apps: [],
        anyAppInstalled: false,
        office: { version: null, platform: null, products: [], source: null },
        sideload: { installed: false, entries: [], searched: [], problems: [] },
        officeOnTheWeb: { url: PI_FOR_OFFICE.officeOnTheWebUrl, recommended: true },
        notes: [],
        checkedAt: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(withDetection.some((item) => item.id === "wsl")).toBe(true);
  });

  it("surfaces a stale sideload entry and an outdated manifest", () => {
    const detection = {
      os: "windows" as const,
      supported: true,
      isWsl: false,
      apps: [],
      anyAppInstalled: true,
      office: { version: "16.0", platform: "x64", products: [], source: null },
      sideload: {
        installed: true,
        entries: [
          {
            channel: "registry" as const,
            location: "HKCU\\...\\Developer",
            slot: "C:\\gone\\manifest.xml",
            manifestPath: "C:\\gone\\manifest.xml",
            manifestExists: false,
            manifestId: null,
            manifestDisplayName: null,
            manifestSourceLocations: [],
            hosts: [],
            matchesPiForOffice: false,
            matchesProdSource: false,
          },
          {
            channel: "wef-folder" as const,
            location: "C:\\la\\Wef",
            manifestPath: "C:\\la\\Wef\\dev.xml",
            manifestExists: true,
            manifestId: "BC61CAF2-821A-47FD-9D6A-9D96C8F852FE",
            manifestDisplayName: "Pi for Office",
            manifestSourceLocations: ["https://localhost:3141/pi-for-office/taskpane.html"],
            hosts: ["excel"],
            matchesPiForOffice: true,
            matchesProdSource: false,
          },
        ],
        searched: [],
        problems: [],
      },
      officeOnTheWeb: { url: PI_FOR_OFFICE.officeOnTheWebUrl, recommended: false },
      notes: [],
      checkedAt: "2026-09-18T00:00:00.000Z",
    };

    const items = buildTroubleshooting({
      ...base,
      detection,
      sideload: {
        ok: true,
        verified: true,
        error: null,
        platform: "windows",
        manifestPath: "C:\\app\\manifest.prod.xml",
        manifestId: "BC61CAF2-821A-47FD-9D6A-9D96C8F852FE",
        manifestDisplayName: "Pi for Office",
        plan: {
          platform: "windows",
          supported: true,
          fileName: "manifest.prod.xml",
          copyTargets: [],
          registryEntries: [],
          notes: [],
          manualFallback: null,
        },
        actions: [],
        verification: detection,
        nextSteps: [],
        manualFallback: null,
      },
    });

    expect(items.some((item) => item.id === "sideload-stale")).toBe(true);
    expect(items.some((item) => item.id === "sideload-outdated")).toBe(true);
    // Errors sort before warnings.
    expect(items[0]?.severity).not.toBe("info");
  });

  it("flags bridge version skew and a missing task pane", () => {
    const health = {
      status: "ok" as const,
      url: "http://127.0.0.1:38617/health",
      httpStatus: 200,
      health: {
        serverName: "pi-office-bridge",
        serverVersion: "0.2.0",
        piVersion: "0.80.0",
        protocolVersion: 1,
        catalogVersion: 1,
        capabilities: [],
        panes: [],
        raw: {},
      },
      portConflict: false,
      error: null,
      durationMs: 1,
    };
    const items = buildTroubleshooting({
      ...base,
      detection: null,
      health,
      sideload: {
        ok: true,
        verified: true,
        error: null,
        platform: "windows",
        manifestPath: "m",
        manifestId: null,
        manifestDisplayName: null,
        plan: {
          platform: "windows",
          supported: true,
          fileName: "m",
          copyTargets: [],
          registryEntries: [],
          notes: [],
          manualFallback: null,
        },
        actions: [],
        verification: null,
        nextSteps: [],
        manualFallback: null,
      },
    });
    expect(items.some((item) => item.id === "bridge-version-skew")).toBe(true);
    expect(items.some((item) => item.id === "catalog-version-skew")).toBe(true);
    expect(items.some((item) => item.id === "pane-not-attached")).toBe(true);
  });

  it("uses platform-appropriate port diagnostics", () => {
    const health = {
      status: "not-our-bridge" as const,
      url: "http://127.0.0.1:38617/health",
      httpStatus: 200,
      health: null,
      portConflict: true,
      error: "Port 38617 is served by x",
      durationMs: 1,
    };
    const linux = buildTroubleshooting({ ...base, platform: "macos", detection: null, health });
    expect(linux.some((item) => item.id === "no-detection")).toBe(true);

    const withDetection = buildTroubleshooting({
      ...base,
      platform: "macos",
      health,
      detection: {
        os: "macos",
        supported: true,
        isWsl: false,
        apps: [
          {
            host: "excel",
            label: "Excel",
            installed: true,
            executablePath: "/Applications/Microsoft Excel.app",
          },
        ],
        anyAppInstalled: true,
        office: { version: null, platform: null, products: [], source: null },
        sideload: { installed: false, entries: [], searched: [], problems: [] },
        officeOnTheWeb: { url: PI_FOR_OFFICE.officeOnTheWebUrl, recommended: false },
        notes: [],
        checkedAt: "2026-09-18T00:00:00.000Z",
      },
    });
    const portItem = withDetection.find((item) => item.id === "port-in-use");
    expect(portItem?.actions.join(" ")).toContain("lsof");
  });
});

describe("redactSecrets", () => {
  it("redacts every supported credential shape", () => {
    const input = [
      "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "OPENAI=sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "pat github_pat_abcdefghijklmnopqrstuvwxyz012345",
      "slack xoxb-1234567890-abcdefghijkl",
      "aws AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
      '{"api_key": "abcdef1234567890", "password": "hunter2hunter2"}',
    ].join("\n");

    const result = redactSecrets(input);

    expect(result.redactions).toBeGreaterThanOrEqual(8);
    expect(result.text).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(result.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(result.text).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(result.text).not.toContain("abcdef1234567890");
    expect(result.text).not.toContain("hunter2hunter2");
    // Key names survive so the report stays useful.
    expect(result.text).toContain("api_key");
    expect(result.text).toContain("Authorization");
  });

  it("leaves ordinary text alone", () => {
    const result = redactSecrets("bridge listening on port 38617\nExcel · Budget.xlsx");
    expect(result.redactions).toBe(0);
    expect(result.text).toContain("38617");
  });
});

describe("buildDiagnosticsBundle", () => {
  const baseInput: DiagnosticsInput = {
    app: {
      name: "Pi Desktop",
      version: "0.0.1",
      electron: "44.4.0",
      node: "24.16.0",
      platform: "win32",
      arch: "x64",
      osRelease: "10.0",
      isWsl: false,
    },
    profile: {
      agentDir: "C:\\agent",
      cwd: "C:\\work",
      settingsPath: "C:\\agent\\settings.json",
      npmRoot: "C:\\agent\\npm",
    },
    port: 38617,
    detection: null,
    bridge: null,
    sideload: null,
    health: null,
    panes: [],
    checklist: [],
    troubleshooting: [],
    env: { PI_OFFICE_BRIDGE_PORT: "38617", ANTHROPIC_API_KEY: undefined },
    now: () => new Date("2026-09-18T10:00:00.000Z"),
  };

  it("includes the sections a maintainer needs", () => {
    const bundle = buildDiagnosticsBundle({
      ...baseInput,
      extra: { "bridge.installLog": "npm ERR! secret sk-ant-api03-abcdefghijklmnopqrst" },
      panes: [
        {
          clientName: "pi-for-office",
          host: "excel",
          documentId: "id",
          documentName: "Budget.xlsx",
          focused: true,
          visible: true,
          windows: 1,
          ops: 34,
          model: null,
          provider: null,
        },
      ],
      troubleshooting: [
        {
          id: "x",
          severity: "warning",
          title: "Something",
          detail: "Details",
          actions: ["Do a thing"],
        },
      ],
      checklist: [
        {
          id: "detect",
          title: "Detect Office",
          status: "ok",
          detail: "Excel detected",
          actions: [],
        },
      ],
    });

    expect(bundle.text).toContain("generated: 2026-09-18T10:00:00.000Z");
    expect(bundle.text).toContain("## Profile");
    expect(bundle.text).toContain("PI_OFFICE_BRIDGE_PORT=38617");
    expect(bundle.text).toContain("## Attached panes (1)");
    expect(bundle.text).toContain("Excel · Budget.xlsx");
    expect(bundle.text).toContain("- [ok] Detect Office: Excel detected");
    expect(bundle.text).toContain("(warning) Something: Details");
    expect(bundle.text).toContain("action: Do a thing");
    expect(bundle.redactions).toBeGreaterThan(0);
    expect(bundle.text).not.toContain("sk-ant-api03-abcdefghijklmnopqrst");
  });

  it("omits credentials that are not set", () => {
    const bundle = buildDiagnosticsBundle(baseInput);
    expect(bundle.text).not.toContain("ANTHROPIC_API_KEY");
  });
});
