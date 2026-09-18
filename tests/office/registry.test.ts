import { describe, expect, it } from "vitest";

import { parseRegQueryOutput, queryRegistryKey, queryRegistryTree, readRegistryValue } from "../../src/main/office/registry";
import { createFakeCommandRunner } from "../../src/main/office/exec";

const DEVELOPER_KEY = "HKCU\\SOFTWARE\\Microsoft\\Office\\16.0\\WEF\\Developer";

const SAMPLE = [
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
  "    ClientCulture    REG_SZ    en-US",
  "    Platform    REG_SZ    x64",
  "    ProductReleaseIds    REG_SZ    ProPlus2021Volume,Excel2021Volume",
  "    VersionToReport    REG_SZ    16.0.17928.20216",
  "    (Default)    REG_SZ    (value not set)",
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration\\Updates",
  "    Enabled    REG_DWORD    0x1",
  "",
].join("\r\n");

describe("parseRegQueryOutput", () => {
  it("parses keys, values and subkey headers", () => {
    const keys = parseRegQueryOutput(SAMPLE);
    expect(keys).toHaveLength(2);
    expect(keys[0]?.path).toBe(
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
    );
    expect(readRegistryValue(keys[0] ?? null, "Platform")).toBe("x64");
    expect(readRegistryValue(keys[0] ?? null, "ProductReleaseIds")).toBe(
      "ProPlus2021Volume,Excel2021Volume",
    );
    expect(keys[1]?.values[0]).toEqual({ name: "Enabled", type: "REG_DWORD", data: "0x1" });
  });

  it("treats (value not set) as absent", () => {
    const keys = parseRegQueryOutput(SAMPLE);
    expect(readRegistryValue(keys[0] ?? null, "(Default)")).toBeNull();
    expect(readRegistryValue(keys[0] ?? null, "Nope")).toBeNull();
  });

  it("handles values with an empty data column (real Click-to-Run output)", () => {
    // `reg query HKLM\SOFTWARE\Microsoft\Office\ClickToRun\Configuration`
    // emits lines like `    ScenarioCulture    REG_SZ` with nothing after the
    // type. These must not be swallowed as wrapped continuation lines.
    const keys = parseRegQueryOutput(
      [
        "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
        "    VersionToReport    REG_SZ    16.0.20326.20144",
        "    ScenarioCulture    REG_SZ",
        "    Platform    REG_SZ    x64",
        "    ProductReleaseIds    REG_SZ    O365HomePremRetail",
      ].join("\r\n"),
    );
    const key = keys[0] ?? null;
    expect(readRegistryValue(key, "VersionToReport")).toBe("16.0.20326.20144");
    expect(readRegistryValue(key, "Platform")).toBe("x64");
    expect(readRegistryValue(key, "ProductReleaseIds")).toBe("O365HomePremRetail");
    expect(key?.values.map((value) => value.name)).toEqual([
      "VersionToReport",
      "ScenarioCulture",
      "Platform",
      "ProductReleaseIds",
    ]);
    expect(key?.values[1]).toEqual({ name: "ScenarioCulture", type: "REG_SZ", data: "" });
  });

  it("joins wrapped continuation lines", () => {
    const keys = parseRegQueryOutput(
      [
        "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Office\\16.0\\WEF\\Developer",
        "    C:\\very\\long\\path\\to\\manifest.pi-for-office.xml    REG_SZ    C:\\very\\long\\path\\to",
        "    \\manifest.pi-for-office.xml",
      ].join("\n"),
    );
    expect(readRegistryValue(keys[0] ?? null, "C:\\very\\long\\path\\to\\manifest.pi-for-office.xml")).toBe(
      "C:\\very\\long\\path\\to\\manifest.pi-for-office.xml",
    );
  });

  it("ignores empty input", () => {
    expect(parseRegQueryOutput("")).toEqual([]);
  });
});

describe("registry queries", () => {
  it("returns null when the key does not exist", async () => {
    const runner = createFakeCommandRunner([
      { command: "reg.exe", args: ["query", "HKCU\\Missing"], code: 1, stderr: "ERROR: not found" },
    ]);
    expect(await queryRegistryKey(runner, "HKCU\\Missing")).toBeNull();
    expect(await queryRegistryTree(runner, "HKCU\\Missing")).toEqual([]);
  });

  it("selects the requested key from a recursive listing", async () => {
    const runner = createFakeCommandRunner([
      { command: "reg.exe", args: ["query", DEVELOPER_KEY, "/s"], stdout: SAMPLE },
    ]);
    const keys = await queryRegistryTree(runner, DEVELOPER_KEY);
    expect(keys.map((key) => key.path)).toContain(
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
    );
    expect(runner.calls[0]).toEqual({
      command: "reg.exe",
      args: ["query", DEVELOPER_KEY, "/s"],
    });
  });

  it("returns the exact key even when the listing contains others", async () => {
    const runner = createFakeCommandRunner([
      { command: "reg.exe", args: ["query", "HKLM\\A"], stdout: SAMPLE },
    ]);
    const key = await queryRegistryKey(runner, "HKLM\\A");
    expect(key?.path).toBe(
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
    );
  });
});
