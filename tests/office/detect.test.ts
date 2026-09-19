import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectOfficeWith,
  formatDetectionReport,
  isManifestFileName,
  manifestPathFromRegistryValue,
  productsAllowHost,
} from "../../src/main/office/detect";
import type { RegistryValue } from "../../src/main/office/registry";
import { fixtureText, makeDetectDeps } from "./helpers";

const PI_MANIFEST = fixtureText("manifest.pi-for-office.xml");
const FOREIGN_MANIFEST = fixtureText("manifest.foreign.xml");

const PF = "C:\\Program Files";
const PF86 = "C:\\Program Files (x86)";
const HOME = "C:\\Users\\Test";
const LOCALAPPDATA = path.join(HOME, "AppData", "Local");
const APPDATA = path.join(HOME, "AppData", "Roaming");

const EXCEL_EXE = path.join(PF, "Microsoft Office", "root", "Office16", "EXCEL.EXE");
const WINWORD_EXE = path.join(PF, "Microsoft Office", "root", "Office16", "WINWORD.EXE");
const INSTALL_ROOT = path.join(PF, "Microsoft Office", "root", "Office16");
const MANIFEST_DIR = path.join(LOCALAPPDATA, "PiDesktop");
const MANIFEST_PATH = path.join(MANIFEST_DIR, "manifest.pi-for-office.xml");
const WEF_DIR_16 = path.join(LOCALAPPDATA, "Microsoft", "Office", "16.0", "Wef");

const CTR_KEY = "HKLM\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration";
const CTR_KEY_X86 = "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office\\ClickToRun\\Configuration";
const INSTALL_ROOT_KEY = "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\Common\\InstallRoot";
const DEVELOPER_KEY_16 = "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\WEF\\Developer";
const DEVELOPER_KEY_15 = "HKCU\\SOFTWARE\\Microsoft\\Office\\15.0\\WEF\\Developer";

function ctrOutput(products: string): string {
  return [
    CTR_KEY,
    "    ClientCulture    REG_SZ    en-US",
    "    Platform    REG_SZ    x64",
    `    ProductReleaseIds    REG_SZ    ${products}`,
    "    VersionToReport    REG_SZ    16.0.17928.20216",
    "",
  ].join("\r\n");
}

function installRootOutput(): string {
  return [INSTALL_ROOT_KEY, `    Path    REG_SZ    ${INSTALL_ROOT}\\`, ""].join("\r\n");
}

function developerOutput(manifestPath: string): string {
  return [DEVELOPER_KEY_16, `    ${manifestPath}    REG_SZ    ${manifestPath}`, ""].join("\r\n");
}

const WINDOWS_ENV = {
  ProgramFiles: PF,
  "ProgramFiles(x86)": PF86,
  LOCALAPPDATA,
  APPDATA,
};

describe("detectOfficeWith — Windows", () => {
  it("detects installed apps and a registry sideload of Pi for Office", async () => {
    const { deps } = makeDetectDeps({
      platform: "win32",
      env: WINDOWS_ENV,
      homedir: HOME,
      files: { [EXCEL_EXE]: "MZ", [MANIFEST_PATH]: PI_MANIFEST },
      paths: { [MANIFEST_PATH]: "file" },
      commands: [
        {
          command: "reg.exe",
          args: ["query", CTR_KEY],
          exact: true,
          stdout: ctrOutput("ProPlus2021Volume,Excel2021Volume"),
        },
        { command: "reg.exe", args: ["query", CTR_KEY_X86], exact: true, code: 1 },
        {
          command: "reg.exe",
          args: ["query", INSTALL_ROOT_KEY],
          exact: true,
          stdout: installRootOutput(),
        },
        {
          command: "reg.exe",
          args: ["query", DEVELOPER_KEY_16, "/s"],
          stdout: developerOutput(MANIFEST_PATH),
        },
        { command: "reg.exe", args: ["query", DEVELOPER_KEY_15, "/s"], code: 1 },
      ],
    });

    const result = await detectOfficeWith(deps);

    expect(result.os).toBe("windows");
    expect(result.supported).toBe(true);
    expect(result.isWsl).toBe(false);
    expect(result.anyAppInstalled).toBe(true);
    expect(result.office.version).toBe("16.0.17928.20216");
    expect(result.office.platform).toBe("x64");
    expect(result.office.products).toEqual(["ProPlus2021Volume", "Excel2021Volume"]);

    const excel = result.apps.find((app) => app.host === "excel");
    expect(excel?.installed).toBe(true);
    expect(excel?.executablePath).toBe(EXCEL_EXE);
    expect(excel?.evidence).toBe("install-root");

    // ProPlus implies the suite even though only EXCEL.EXE exists on disk.
    const word = result.apps.find((app) => app.host === "word");
    expect(word?.installed).toBe(true);
    expect(word?.evidence).toBe("click-to-run");
    expect(word?.executablePath).toBeUndefined();
    expect(result.apps.find((app) => app.host === "powerpoint")?.installed).toBe(true);

    expect(result.sideload.installed).toBe(true);
    expect(result.sideload.entries).toHaveLength(1);
    const entry = result.sideload.entries[0];
    expect(entry?.channel).toBe("registry");
    expect(entry?.slot).toBe(MANIFEST_PATH);
    expect(entry?.manifestExists).toBe(true);
    expect(entry?.manifestId).toBe("BC61CAF2-821A-47FD-9D6A-9D96C8F852FE");
    expect(entry?.matchesPiForOffice).toBe(true);
    expect(entry?.matchesProdSource).toBe(true);
    expect(entry?.hosts).toEqual(["excel", "word", "powerpoint"]);

    expect(result.sideload.searched).toContain(DEVELOPER_KEY_16);
    expect(result.sideload.searched).toContain(DEVELOPER_KEY_15);
    expect(result.sideload.searched).toContain(WEF_DIR_16);
    expect(result.sideload.problems).toEqual([]);
    expect(result.notes).toContain("Pi for Office is already sideloaded.");
    expect(result.officeOnTheWeb.recommended).toBe(false);
    expect(result.checkedAt).toBe("2026-09-18T00:00:00.000Z");
  });

  it("does not claim an unrelated add-in sideloaded in the Wef folder", async () => {
    const foreignPath = path.join(WEF_DIR_16, "contoso.xml");
    const { deps } = makeDetectDeps({
      platform: "win32",
      env: WINDOWS_ENV,
      homedir: HOME,
      files: { [EXCEL_EXE]: "MZ", [foreignPath]: FOREIGN_MANIFEST },
      paths: { [foreignPath]: "file" },
      dirs: { [WEF_DIR_16]: ["contoso.xml"] },
      commands: [
        { command: "reg.exe", args: ["query", CTR_KEY], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", CTR_KEY_X86], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", INSTALL_ROOT_KEY], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", DEVELOPER_KEY_16, "/s"], code: 1 },
        { command: "reg.exe", args: ["query", DEVELOPER_KEY_15, "/s"], code: 1 },
      ],
    });

    const result = await detectOfficeWith(deps);

    expect(result.sideload.installed).toBe(false);
    expect(result.sideload.entries).toHaveLength(1);
    expect(result.sideload.entries[0]?.matchesPiForOffice).toBe(false);
    expect(result.sideload.entries[0]?.manifestDisplayName).toBe("Contoso Charts");
    expect(result.notes).toContain("Pi for Office is not sideloaded yet.");
    expect(result.notes.some((note) => note.includes("other sideloaded add-in"))).toBe(true);

    // Only Excel is installed: no Click-to-Run products, no Word executable.
    expect(result.office.version).toBeNull();
    expect(result.apps.find((app) => app.host === "excel")?.installed).toBe(true);
    expect(result.apps.find((app) => app.host === "excel")?.evidence).toBe("filesystem");
    expect(result.apps.find((app) => app.host === "word")?.installed).toBe(false);
  });

  it("reports stale sideload entries whose manifest file is gone", async () => {
    const missingPath = path.join(MANIFEST_DIR, "deleted-manifest.xml");
    const { deps } = makeDetectDeps({
      platform: "win32",
      env: WINDOWS_ENV,
      homedir: HOME,
      files: { [EXCEL_EXE]: "MZ" },
      commands: [
        { command: "reg.exe", args: ["query", CTR_KEY], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", CTR_KEY_X86], exact: true, code: 1 },
        {
          command: "reg.exe",
          args: ["query", INSTALL_ROOT_KEY],
          exact: true,
          stdout: installRootOutput(),
        },
        {
          command: "reg.exe",
          args: ["query", DEVELOPER_KEY_16, "/s"],
          stdout: developerOutput(missingPath),
        },
        { command: "reg.exe", args: ["query", DEVELOPER_KEY_15, "/s"], code: 1 },
      ],
    });

    const result = await detectOfficeWith(deps);

    expect(result.sideload.installed).toBe(false);
    expect(result.sideload.problems).toEqual([
      `Sideload entry points at a missing manifest file: ${missingPath}`,
    ]);
    expect(result.notes.some((note) => note.startsWith("1 stale sideload entry"))).toBe(true);
  });

  it("flags a sideloaded Pi for Office manifest that is not the current hosted task pane", async () => {
    // A dev manifest points every task-pane URL at the local Vite server.
    const devXml = PI_MANIFEST.replaceAll(
      "https://dieuluucanh.github.io/pi-for-office/src/taskpane.html",
      "https://localhost:3141/pi-for-office/src/taskpane.html",
    );
    const { deps } = makeDetectDeps({
      platform: "win32",
      env: WINDOWS_ENV,
      homedir: HOME,
      files: { [EXCEL_EXE]: "MZ", [MANIFEST_PATH]: devXml },
      paths: { [MANIFEST_PATH]: "file" },
      commands: [
        { command: "reg.exe", args: ["query", CTR_KEY], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", CTR_KEY_X86], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", INSTALL_ROOT_KEY], exact: true, code: 1 },
        {
          command: "reg.exe",
          args: ["query", DEVELOPER_KEY_16, "/s"],
          stdout: developerOutput(MANIFEST_PATH),
        },
        { command: "reg.exe", args: ["query", DEVELOPER_KEY_15, "/s"], code: 1 },
      ],
    });

    const result = await detectOfficeWith(deps);

    expect(result.sideload.installed).toBe(true);
    expect(result.sideload.entries[0]?.matchesPiForOffice).toBe(true);
    expect(result.sideload.entries[0]?.matchesProdSource).toBe(false);
    expect(
      result.notes.some((note) => note.includes("does not point at the current hosted task pane")),
    ).toBe(true);
  });

  it("deduplicates entries present in both the registry and the Wef folder", async () => {
    const wefCopy = path.join(WEF_DIR_16, "pi-for-office.xml");
    const { deps } = makeDetectDeps({
      platform: "win32",
      env: WINDOWS_ENV,
      homedir: HOME,
      files: { [EXCEL_EXE]: "MZ", [MANIFEST_PATH]: PI_MANIFEST },
      paths: { [MANIFEST_PATH]: "file" },
      dirs: { [WEF_DIR_16]: ["pi-for-office.xml"] },
      commands: [
        { command: "reg.exe", args: ["query", CTR_KEY], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", CTR_KEY_X86], exact: true, code: 1 },
        { command: "reg.exe", args: ["query", INSTALL_ROOT_KEY], exact: true, code: 1 },
        {
          command: "reg.exe",
          args: ["query", DEVELOPER_KEY_16, "/s"],
          // Two registry slots pointing at the same manifest -> one entry.
          stdout: [
            DEVELOPER_KEY_16,
            `    ${MANIFEST_PATH}    REG_SZ    ${MANIFEST_PATH}`,
            `    pi-for-office    REG_SZ    ${MANIFEST_PATH}`,
            "",
          ].join("\r\n"),
        },
        { command: "reg.exe", args: ["query", DEVELOPER_KEY_15, "/s"], code: 1 },
      ],
    });

    const result = await detectOfficeWith(deps);

    expect(result.sideload.entries).toHaveLength(2);
    expect(result.sideload.entries.map((entry) => entry.channel)).toEqual([
      "registry",
      "wef-folder",
    ]);
    expect(result.sideload.installed).toBe(true);
    // The wef-folder copy is unreadable (not in `files`) -> reported, not fatal.
    expect(result.sideload.problems).toHaveLength(1);
    expect(wefCopy).toBe(path.join(WEF_DIR_16, "pi-for-office.xml"));
  });
});

describe("detectOfficeWith — macOS", () => {
  it("detects app bundles and wef sideloads", async () => {
    const home = "/Users/test";
    const excelBundle = path.join("/Applications", "Microsoft Excel.app");
    const wordBundle = path.join(home, "Applications", "Microsoft Word.app");
    const wefDir = path.join(
      home,
      "Library",
      "Containers",
      "com.microsoft.Excel",
      "Data",
      "Documents",
      "wef",
    );
    const manifestPath = path.join(wefDir, "manifest.pi-for-office.xml");

    const { deps } = makeDetectDeps({
      platform: "darwin",
      env: {},
      homedir: home,
      files: { [manifestPath]: PI_MANIFEST },
      paths: { [excelBundle]: "directory", [wordBundle]: "directory", [manifestPath]: "file" },
      dirs: { [wefDir]: ["manifest.pi-for-office.xml"] },
    });

    const result = await detectOfficeWith(deps);

    expect(result.os).toBe("macos");
    expect(result.supported).toBe(true);
    expect(result.anyAppInstalled).toBe(true);
    expect(result.apps.find((app) => app.host === "excel")).toMatchObject({
      installed: true,
      executablePath: excelBundle,
      evidence: "app-bundle",
    });
    expect(result.apps.find((app) => app.host === "word")?.installed).toBe(true);
    expect(result.apps.find((app) => app.host === "powerpoint")?.installed).toBe(false);

    expect(result.sideload.installed).toBe(true);
    expect(result.sideload.entries[0]).toMatchObject({
      channel: "wef-folder",
      location: wefDir,
      manifestPath,
      matchesProdSource: true,
    });
    expect(result.sideload.searched).toContain(wefDir);
  });
});

describe("detectOfficeWith — Linux and WSL", () => {
  it("reports Linux as unsupported and recommends Office on the web", async () => {
    const { deps } = makeDetectDeps({ platform: "linux", env: {}, homedir: "/home/test" });
    const result = await detectOfficeWith(deps);

    expect(result.os).toBe("linux");
    expect(result.supported).toBe(false);
    expect(result.isWsl).toBe(false);
    expect(result.apps.every((app) => !app.installed)).toBe(true);
    expect(result.officeOnTheWeb.recommended).toBe(true);
    expect(result.sideload.entries).toEqual([]);
    expect(result.notes.some((note) => note.includes("Office on the web"))).toBe(true);
  });

  it("detects WSL from the environment", async () => {
    const { deps } = makeDetectDeps({
      platform: "linux",
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      homedir: "/home/test",
    });
    const result = await detectOfficeWith(deps);
    expect(result.isWsl).toBe(true);
    expect(result.notes.some((note) => note.includes("WSL detected"))).toBe(true);
  });

  it("detects WSL from /proc/version when the env is not set", async () => {
    const { deps } = makeDetectDeps({
      platform: "linux",
      env: {},
      homedir: "/home/test",
      files: { "/proc/version": "Linux version 5.15.0 (Microsoft, WSL2)" },
    });
    const result = await detectOfficeWith(deps);
    expect(result.isWsl).toBe(true);
  });
});

describe("helpers", () => {
  it("productsAllowHost understands suites and single app products", () => {
    expect(productsAllowHost(["Excel2021Volume"], "excel")).toBe(true);
    expect(productsAllowHost(["Excel2021Volume"], "word")).toBe(false);
    expect(productsAllowHost(["PowerPoint2021Volume"], "powerpoint")).toBe(true);
    expect(productsAllowHost(["PowerPoint2021Volume"], "word")).toBe(false);
    expect(productsAllowHost(["O365ProPlusRetail"], "powerpoint")).toBe(true);
    expect(productsAllowHost([], "excel")).toBe(false);
  });

  it("manifestPathFromRegistryValue accepts either column", () => {
    expect(
      manifestPathFromRegistryValue({ name: "C:\\a\\m.xml", type: "REG_SZ", data: "C:\\a\\m.xml" }),
    ).toBe("C:\\a\\m.xml");
    expect(
      manifestPathFromRegistryValue({ name: "slot", type: "REG_SZ", data: "C:\\a\\m.xml" }),
    ).toBe("C:\\a\\m.xml");
    expect(manifestPathFromRegistryValue({ name: "slot", type: "REG_SZ", data: "1" })).toBeNull();
    const unset: RegistryValue = { name: "slot", type: "REG_SZ", data: "" };
    expect(manifestPathFromRegistryValue(unset)).toBeNull();
  });

  it("isManifestFileName only accepts manifest-looking files", () => {
    expect(isManifestFileName("manifest.xml")).toBe(true);
    expect(isManifestFileName("pi-for-office.manifest")).toBe(true);
    expect(isManifestFileName("readme.txt")).toBe(false);
  });

  it("formats a diagnostics report", () => {
    const report = formatDetectionReport({
      os: "windows",
      supported: true,
      isWsl: false,
      apps: [
        { host: "excel", label: "Excel", installed: true, executablePath: EXCEL_EXE },
        { host: "word", label: "Word", installed: false },
        { host: "powerpoint", label: "PowerPoint", installed: false },
      ],
      anyAppInstalled: true,
      office: {
        version: "16.0.1",
        platform: "x64",
        products: ["Excel2021Volume"],
        source: CTR_KEY,
      },
      sideload: {
        installed: true,
        entries: [
          {
            channel: "registry",
            location: DEVELOPER_KEY_16,
            slot: MANIFEST_PATH,
            manifestPath: MANIFEST_PATH,
            manifestExists: true,
            manifestId: "BC61CAF2-821A-47FD-9D6A-9D96C8F852FE",
            manifestDisplayName: "Pi for Office",
            manifestSourceLocations: [],
            hosts: ["excel"],
            matchesPiForOffice: true,
            matchesProdSource: true,
          },
        ],
        searched: [DEVELOPER_KEY_16],
        problems: [],
      },
      officeOnTheWeb: { url: "https://www.office.com/", recommended: false },
      notes: ["Pi for Office is already sideloaded."],
      checkedAt: "2026-09-18T00:00:00.000Z",
    });

    expect(report).toContain("os: windows");
    expect(report).toContain(`Excel=${EXCEL_EXE}`);
    expect(report).toContain("Word=no");
    expect(report).toContain("sideloaded: yes");
    expect(report).toContain("prodSource=yes");
    expect(report).toContain("notes:");
  });

  it("is stable when the fixture manifest path is used verbatim", () => {
    expect(WINWORD_EXE.endsWith("WINWORD.EXE")).toBe(true);
    expect(APPDATA).toContain("Roaming");
  });
});
