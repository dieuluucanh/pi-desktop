import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSettingsFileIo } from "../../src/host/file-io";
import {
  createSdkSettingsPort,
  parseSettingsFile,
  serializeSettingsFile,
  type SdkSettingsOptions,
} from "../../src/host/sdk/settings";

/**
 * The real `SettingsPort` over a temp profile (plan step 12). These tests use a
 * real `SettingsManager` and real files, so they pin what the pure handler tests
 * cannot: named setters, nested document edits, trust refusal, malformed-file
 * refusal, backups and reload visibility.
 */

let root: string;
let agentDir: string;
let projectDir: string;
let backupDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-desktop-settings-"));
  agentDir = join(root, "agent");
  projectDir = join(root, "project");
  backupDir = join(root, "backups");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makePort(overrides: Partial<SdkSettingsOptions> = {}) {
  return createSdkSettingsPort({
    agentDir,
    cwd: projectDir,
    io: createNodeSettingsFileIo(),
    backupDir,
    isProjectTrusted: () => true,
    now: () => Date.parse("2026-09-20T10:00:00.000Z"),
    ...overrides,
  });
}

const globalPath = (): string => join(agentDir, "settings.json");
const projectPath = (): string => join(projectDir, ".pi", "settings.json");

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("createSdkSettingsPort", () => {
  it("reads both scopes and reports file status", async () => {
    await writeFile(globalPath(), JSON.stringify({ theme: "dark" }), "utf8");
    await mkdir(join(projectDir, ".pi"), { recursive: true });
    await writeFile(projectPath(), JSON.stringify({ theme: "light" }), "utf8");

    const port = makePort();
    const scopes = await port.read(null);
    expect(scopes.global).toMatchObject({ theme: "dark" });
    expect(scopes.project).toMatchObject({ theme: "light" });

    const files = await port.files(null);
    expect(files.global.path).toBe(globalPath());
    expect(files.global.exists).toBe(true);
    expect(files.global.mtimeMs).toBeGreaterThan(0);
    expect(files.project.exists).toBe(true);
  });

  it("writes a global key through a named setter and persists it", async () => {
    const port = makePort();
    await port.write(null, "theme", "light", "global");
    expect((await port.read(null)).global.theme).toBe("light");
    expect(await readJson(globalPath())).toMatchObject({ theme: "light" });
  });

  it("writes and deletes a nested key through the document editor", async () => {
    const port = makePort();
    await port.write(null, "compaction.reserveTokens", 8192, "global");
    const written = await readJson(globalPath());
    expect(written).toMatchObject({ compaction: { reserveTokens: 8192 } });
    // The manager was reloaded, so the read sees the new value.
    expect((await port.read(null)).global).toMatchObject({
      compaction: { reserveTokens: 8192 },
    });

    await port.write(null, "compaction.reserveTokens", undefined, "global");
    expect(await readJson(globalPath())).toEqual({});
  });

  it("writes the model scope through Pi's own setter and deletes it on undefined", async () => {
    const port = makePort();
    const patterns = ["fake/fake-2", "fake/fake-3:high"];

    await port.write(null, "enabledModels", patterns, "global");
    expect((await port.read(null)).global.enabledModels).toEqual(patterns);
    expect(await readJson(globalPath())).toMatchObject({ enabledModels: patterns });

    // `undefined` removes the key (Pi's "no scope" state), not an empty list.
    await port.write(null, "enabledModels", undefined, "global");
    expect((await port.read(null)).global.enabledModels).toBeUndefined();
    expect(await readJson(globalPath())).not.toHaveProperty("enabledModels");
  });

  it("writes a project model scope through the document editor", async () => {
    const port = makePort();
    await port.write(projectDir, "enabledModels", ["fake/fake-2"], "project");
    expect((await port.read(projectDir)).project.enabledModels).toEqual(["fake/fake-2"]);
    expect(await readJson(projectPath())).toMatchObject({ enabledModels: ["fake/fake-2"] });
  });

  it("writes project settings when the project is trusted", async () => {
    const port = makePort();
    await port.write(projectDir, "theme", "light", "project");
    expect(await readJson(projectPath())).toMatchObject({ theme: "light" });
  });

  it("refuses project writes when the project is not trusted", async () => {
    const port = makePort({ isProjectTrusted: () => false });
    await expect(port.write(projectDir, "theme", "light", "project")).rejects.toThrow(
      /not trusted/i,
    );
  });

  it("never overwrites a malformed settings file", async () => {
    await writeFile(globalPath(), "{ this is not json", "utf8");
    const port = makePort();
    await expect(port.write(null, "theme", "light", "global")).rejects.toThrow(/not valid JSON/i);
    expect(await readFile(globalPath(), "utf8")).toBe("{ this is not json");
  });

  it("backs up a file once, before the first write", async () => {
    await writeFile(globalPath(), JSON.stringify({ theme: "dark" }), "utf8");
    const port = makePort();
    await port.write(null, "theme", "light", "global");
    await port.write(null, "theme", "dark", "global");

    const backups = await readdir(backupDir);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^settings\.json\..*\.bak$/);
    expect(JSON.parse(await readFile(join(backupDir, backups[0] ?? ""), "utf8"))).toMatchObject({
      theme: "dark",
    });
  });

  it("replaces a whole scope with the raw editor", async () => {
    const port = makePort();
    await port.writeScope(null, "global", { theme: "light", unknownKey: 1 });
    expect(await readJson(globalPath())).toEqual({ theme: "light", unknownKey: 1 });
  });

  it("parses and serialises settings files", () => {
    expect(parseSettingsFile(null, "x")).toEqual({});
    expect(parseSettingsFile("", "x")).toEqual({});
    expect(() => parseSettingsFile("[1]", "x")).toThrow(/JSON object/i);
    expect(serializeSettingsFile({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
