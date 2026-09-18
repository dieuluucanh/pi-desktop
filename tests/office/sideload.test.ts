import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryFsPort } from "../../src/main/fs-port";
import { planSideload, sideloadAddIn, unsideloadAddIn } from "../../src/main/office/sideload";
import { normalizeRegistryPath } from "../../src/main/office/registry";
import { PI_FOR_OFFICE } from "../../src/shared/office";
import { detectDepsFromFsPort, fixtureText } from "./helpers";
import { createStatefulRegistryFake } from "./registry-fake";

/** The real vendored manifest, exactly what the app ships. */
const MANIFEST = readFileSync(
  new URL("../../resources/office/manifest.prod.xml", import.meta.url),
  "utf8",
);
const MANIFEST_LOCK = JSON.parse(
  readFileSync(new URL("../../resources/office/manifest.lock.json", import.meta.url), "utf8"),
) as { sha256: string; bytes: number };
const FOREIGN = fixtureText("manifest.foreign.xml");

const HOME = "C:\\Users\\Test";
const LOCALAPPDATA = path.join(HOME, "AppData", "Local");
const WEF_DIR = path.join(LOCALAPPDATA, "Microsoft", "Office", "16.0", "Wef");
const MANIFEST_SOURCE = path.join("C:", "app", "resources", "office", "manifest.prod.xml");
const COPIED = path.join(WEF_DIR, "manifest.prod.xml");
const EXCEL_EXE = path.join("C:\\Program Files", "Microsoft Office", "root", "Office16", "EXCEL.EXE");
const WIN_ENV = { LOCALAPPDATA, ProgramFiles: "C:\\Program Files" };
/** Windows registry paths are case-insensitive; the double stores them normalised. */
const DEVELOPER_KEY = normalizeRegistryPath(
  "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\WEF\\Developer",
);

describe("vendored manifest resource", () => {
  it("matches the recorded lock hash and is the Pi for Office add-in", () => {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    expect(createHash("sha256").update(MANIFEST).digest("hex")).toBe(MANIFEST_LOCK.sha256);
    expect(Buffer.byteLength(MANIFEST)).toBe(MANIFEST_LOCK.bytes);
    expect(MANIFEST.toLowerCase()).toContain(PI_FOR_OFFICE.addInId.toLowerCase());
    expect(MANIFEST).toContain(PI_FOR_OFFICE.sourceLocation);
  });
});

describe("planSideload", () => {
  it("plans the Windows developer catalog plus the wef copy", () => {
    const fs = createMemoryFsPort();
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, { platform: "win32", env: WIN_ENV, homedir: HOME, runner: registry });

    const plan = planSideload({ fs, detect }, { manifestPath: MANIFEST_SOURCE });

    expect(plan.supported).toBe(true);
    expect(plan.copyTargets).toEqual([WEF_DIR]);
    expect(plan.registryEntries).toEqual([
      {
        key: "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\WEF\\Developer",
        valueName: COPIED,
        manifestPath: COPIED,
      },
    ]);
    expect(plan.notes.join(" ")).toContain("no administrator rights");
    expect(plan.manualFallback).toContain("Upload My Add-in");
  });

  it("rejects an unsupported Office registry version", () => {
    const fs = createMemoryFsPort();
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, { platform: "win32", env: WIN_ENV, homedir: HOME, runner: registry });
    expect(() =>
      planSideload({ fs, detect }, { manifestPath: MANIFEST_SOURCE, registryVersions: ["14.0"] }),
    ).toThrow(/Unsupported Office registry version/);
  });

  it("plans macOS container copies only", () => {
    const fs = createMemoryFsPort();
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, { platform: "darwin", env: {}, homedir: "/Users/test", runner: registry });

    const plan = planSideload({ fs, detect }, { manifestPath: MANIFEST_SOURCE, hosts: ["excel", "word"] });

    expect(plan.copyTargets).toHaveLength(2);
    expect(plan.copyTargets[0]).toContain(path.join("Containers", "com.microsoft.Excel"));
    expect(plan.registryEntries).toEqual([]);
  });

  it("reports Linux as unsupported with a web fallback", () => {
    const fs = createMemoryFsPort();
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, { platform: "linux", env: {}, homedir: "/home/test", runner: registry });

    const plan = planSideload({ fs, detect }, { manifestPath: MANIFEST_SOURCE });
    expect(plan.supported).toBe(false);
    expect(plan.copyTargets).toEqual([]);
    expect(plan.manualFallback).toContain("Office on the web");
  });
});

describe("sideloadAddIn — Windows", () => {
  function windowsDeps() {
    const fs = createMemoryFsPort({
      files: { [MANIFEST_SOURCE]: MANIFEST, [EXCEL_EXE]: "MZ" },
      dirs: [LOCALAPPDATA],
    });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, {
      platform: "win32",
      env: WIN_ENV,
      homedir: HOME,
      runner: registry,
    });
    return { fs, registry, deps: { fs, detect } };
  }

  it("writes the registry entry and the wef copy, then verifies by detection", async () => {
    const { fs, registry, deps } = windowsDeps();

    const result = await sideloadAddIn(deps, { manifestPath: MANIFEST_SOURCE });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.manifestId?.toLowerCase()).toBe(PI_FOR_OFFICE.addInId.toLowerCase());
    expect(result.actions.map((action) => [action.kind, action.ok])).toEqual([
      ["file-copy", true],
      ["registry", true],
    ]);

    // The manifest copy is byte-identical to the bundled resource.
    expect(await fs.readTextFile(COPIED)).toBe(MANIFEST);

    // The developer catalog entry exists and points at the copy.
    expect([...registry.keys.keys()]).toEqual([DEVELOPER_KEY]);
    expect([...(registry.keys.get(DEVELOPER_KEY)?.keys() ?? [])]).toEqual([COPIED]);
    // Verification is the real detector, not a guess.
    expect(result.verified).toBe(true);
    expect(result.verification?.sideload.installed).toBe(true);
    const entries = result.verification?.sideload.entries ?? [];
    expect(entries.filter((entry) => entry.channel === "registry")).toHaveLength(1);
    expect(entries.filter((entry) => entry.channel === "wef-folder")).toHaveLength(1);
    expect(entries.every((entry) => entry.matchesPiForOffice)).toBe(true);
    expect(entries.every((entry) => entry.matchesProdSource)).toBe(true);

    expect(result.nextSteps.join(" ")).toContain("My Add-ins");
  });

  it("can sideload with the wef copy only", async () => {
    const { fs, registry, deps } = windowsDeps();

    const result = await sideloadAddIn(deps, { manifestPath: MANIFEST_SOURCE, useRegistry: false });

    expect(result.ok).toBe(true);
    expect(result.actions.map((action) => action.kind)).toEqual(["file-copy"]);
    expect(registry.keys.size).toBe(0);
    // Still detected, because Office reads the wef folder too.
    expect(result.verification?.sideload.installed).toBe(true);
  });

  it("can sideload with the registry entry only", async () => {
    const { fs, registry, deps } = windowsDeps();

    const result = await sideloadAddIn(deps, { manifestPath: MANIFEST_SOURCE, copyToWefFolder: false });

    expect(result.ok).toBe(true);
    expect(result.actions.map((action) => action.kind)).toEqual(["registry"]);
    // With no copy the entry points at the bundled resource path.
    expect([...(registry.keys.get(DEVELOPER_KEY)?.keys() ?? [])]).toEqual([MANIFEST_SOURCE]);
    // Office still reads the developer catalog, so detection succeeds.
    expect(result.verification?.sideload.installed).toBe(true);
    expect(await fs.readTextFile(COPIED)).toBeNull();
  });

  it("fails cleanly when the manifest file is missing", async () => {
    const { registry, deps } = windowsDeps();
    const result = await sideloadAddIn(deps, { manifestPath: path.join("C:", "nope.xml") });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Manifest not found");
    expect(result.actions).toEqual([]);
    expect(registry.keys.size).toBe(0);
  });

  it("refuses to sideload an unrelated add-in manifest", async () => {
    const foreignPath = path.join("C:", "downloads", "contoso.xml");
    const fs = createMemoryFsPort({ files: { [foreignPath]: FOREIGN }, dirs: [LOCALAPPDATA] });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, {
      platform: "win32",
      env: WIN_ENV,
      homedir: HOME,
      runner: registry,
    });

    const result = await sideloadAddIn({ fs, detect }, { manifestPath: foreignPath });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unrelated manifest");
    expect(result.actions).toEqual([]);
    expect(registry.keys.size).toBe(0);
    expect(await fs.readTextFile(COPIED)).toBeNull();
  });

  it("reports failure when a write leaves the add-in undetectable", async () => {
    const { deps } = windowsDeps();
    // Verify against a manifest whose source no longer matches prod, so the
    // detector deliberately does not count it as installed.
    const devManifest = MANIFEST.replaceAll(PI_FOR_OFFICE.sourceLocation, "https://localhost:3141/pi-for-office/taskpane.html");
    const fs = createMemoryFsPort({
      files: { [MANIFEST_SOURCE]: devManifest },
      dirs: [LOCALAPPDATA],
    });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, {
      platform: "win32",
      env: WIN_ENV,
      homedir: HOME,
      runner: registry,
    });

    const result = await sideloadAddIn({ fs, detect }, { manifestPath: MANIFEST_SOURCE });

    // The id still matches, so it is installed, but the prod-source note fires.
    expect(result.ok).toBe(true);
    expect(result.verification?.notes.join(" ")).toContain("does not point at the current hosted task pane");
    expect(deps.detect.platform).toBe("win32");
  });
});

describe("sideloadAddIn — macOS and Linux", () => {
  it("copies the manifest into the selected containers without touching the registry", async () => {
    const home = "/Users/test";
    const excelDir = path.join(home, "Library", "Containers", "com.microsoft.Excel", "Data", "Documents", "wef");
    const wordDir = path.join(home, "Library", "Containers", "com.microsoft.Word", "Data", "Documents", "wef");
    const fs = createMemoryFsPort({ files: { [MANIFEST_SOURCE]: MANIFEST } });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, { platform: "darwin", env: {}, homedir: home, runner: registry });

    const result = await sideloadAddIn({ fs, detect }, { manifestPath: MANIFEST_SOURCE, hosts: ["excel"] });

    expect(result.ok).toBe(true);
    expect(result.actions.map((action) => action.kind)).toEqual(["file-copy"]);
    expect(await fs.readTextFile(path.join(excelDir, "manifest.prod.xml"))).toBe(MANIFEST);
    expect(await fs.readTextFile(path.join(wordDir, "manifest.prod.xml"))).toBeNull();
    expect(registry.calls).toEqual([]);
    expect(result.verification?.sideload.installed).toBe(true);
    expect(result.nextSteps.join(" ")).toContain("Cmd+Q");
  });

  it("explains that Linux has nothing to sideload into", async () => {
    const fs = createMemoryFsPort({ files: { [MANIFEST_SOURCE]: MANIFEST } });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, { platform: "linux", env: {}, homedir: "/home/test", runner: registry });

    const result = await sideloadAddIn({ fs, detect }, { manifestPath: MANIFEST_SOURCE });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no desktop Office");
    expect(result.manualFallback).toContain("Office on the web");
  });
});

describe("unsideloadAddIn", () => {
  it("removes the registry entry and the copied manifest", async () => {
    const fs = createMemoryFsPort({
      files: { [MANIFEST_SOURCE]: MANIFEST, [EXCEL_EXE]: "MZ" },
      dirs: [LOCALAPPDATA],
    });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, {
      platform: "win32",
      env: WIN_ENV,
      homedir: HOME,
      runner: registry,
    });

    await sideloadAddIn({ fs, detect }, { manifestPath: MANIFEST_SOURCE });
    const result = await unsideloadAddIn({ fs, detect });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.verified).toBe(true);
    expect(result.verification?.sideload.installed).toBe(false);
    // `reg delete /v` removes the value; the (now empty) key may remain.
    expect([...(registry.keys.get(DEVELOPER_KEY)?.keys() ?? [])]).toEqual([]);
    expect(await fs.readTextFile(COPIED)).toBeNull();
    expect(result.actions.every((action) => action.ok)).toBe(true);
  });

  it("never touches unrelated sideloaded add-ins", async () => {
    const foreignPath = path.join(WEF_DIR, "contoso.xml");
    const fs = createMemoryFsPort({
      files: { [MANIFEST_SOURCE]: MANIFEST, [foreignPath]: FOREIGN, [EXCEL_EXE]: "MZ" },
      dirs: [LOCALAPPDATA],
    });
    const registry = createStatefulRegistryFake({
      "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\WEF\\Developer": { [foreignPath]: foreignPath },
    });
    const detect = detectDepsFromFsPort(fs, {
      platform: "win32",
      env: WIN_ENV,
      homedir: HOME,
      runner: registry,
    });

    await sideloadAddIn({ fs, detect }, { manifestPath: MANIFEST_SOURCE });
    const result = await unsideloadAddIn({ fs, detect });

    expect(result.verification?.sideload.installed).toBe(false);
    expect([...(registry.keys.get(DEVELOPER_KEY)?.keys() ?? [])]).toEqual([foreignPath]);
    expect(await fs.readTextFile(foreignPath)).toBe(FOREIGN);
  });

  it("is a no-op on a machine with no Pi for Office sideload", async () => {
    const fs = createMemoryFsPort({ dirs: [LOCALAPPDATA] });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, {
      platform: "win32",
      env: WIN_ENV,
      homedir: HOME,
      runner: registry,
    });

    const result = await unsideloadAddIn({ fs, detect });
    expect(result.ok).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.verification?.sideload.installed).toBe(false);
  });
});

/** Read-after-write through the stateful fake keeps the detector honest. */
describe("detection after sideload (integration)", () => {
  it("sees the add-in exactly as Office would", async () => {
    const fs = createMemoryFsPort({
      files: { [MANIFEST_SOURCE]: MANIFEST, [EXCEL_EXE]: "MZ" },
      dirs: [LOCALAPPDATA],
    });
    const registry = createStatefulRegistryFake();
    const detect = detectDepsFromFsPort(fs, {
      platform: "win32",
      env: WIN_ENV,
      homedir: HOME,
      runner: registry,
    });

    expect((await detectOfficeWithCompat(detect)).sideload.installed).toBe(false);
    await sideloadAddIn({ fs, detect }, { manifestPath: MANIFEST_SOURCE });
    const after = await detectOfficeWithCompat(detect);
    expect(after.sideload.installed).toBe(true);
    expect(after.notes).toContain("Pi for Office is already sideloaded.");
  });
});

async function detectOfficeWithCompat(detect: Parameters<typeof sideloadAddIn>[0]["detect"]) {
  const { detectOfficeWith } = await import("../../src/main/office/detect");
  return detectOfficeWith(detect);
}
