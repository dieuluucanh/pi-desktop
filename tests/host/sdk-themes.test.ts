import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createNodeFileListingIo, createNodeModelsFileIo } from "../../src/host/file-io";
import { createSdkThemePort } from "../../src/host/sdk/themes";
import { COMPLETE_THEME_COLORS } from "./theme-colors";

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-desktop-themes-"));
  agentDir = join(root, "agent");
  projectDir = join(root, "project");
  await mkdir(join(agentDir, "themes"), { recursive: true });
  await mkdir(join(projectDir, ".pi", "themes"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const themeDoc = (name: string): string =>
  JSON.stringify({ name, vars: {}, colors: COMPLETE_THEME_COLORS });

function port(
  manager: { getTheme?: () => string | undefined; getThemePaths?: () => string[] } | null = null,
) {
  return createSdkThemePort({
    agentDir,
    cwd: projectDir,
    manager,
    io: createNodeModelsFileIo(),
    listing: createNodeFileListingIo(),
  });
}

describe("createSdkThemePort", () => {
  it("lists user and project themes from the conventional directories", async () => {
    await writeFile(join(agentDir, "themes", "mine.json"), themeDoc("mine"), "utf8");
    await writeFile(join(projectDir, ".pi", "themes", "work.json"), themeDoc("work"), "utf8");
    await writeFile(join(agentDir, "themes", "notes.txt"), "not a theme", "utf8");
    const loaded = await port().listLoaded();
    expect(loaded).toEqual([
      { name: "mine", path: join(agentDir, "themes", "mine.json"), scope: "user" },
      { name: "work", path: join(projectDir, ".pi", "themes", "work.json"), scope: "project" },
    ]);
  });

  it("reads the active theme from the settings manager", async () => {
    expect(await port().getActive()).toBeUndefined();
    const manager = SettingsManager.create(projectDir, agentDir);
    expect(await port(manager).getActive()).toBeUndefined();
  });

  it("imports into the profile themes directory", async () => {
    const path = await port().importFile("mine.json", themeDoc("mine"));
    expect(path).toBe(join(agentDir, "themes", "mine.json"));
    expect(JSON.parse(await readFile(path, "utf8")).name).toBe("mine");
    expect((await port().listLoaded()).map((entry) => entry.name)).toContain("mine");
  });

  it("surfaces loader themes with their own scope", async () => {
    const loaderThemes = {
      themes: [
        {
          name: "pkg-theme",
          sourcePath: join(agentDir, "themes", "pkg-theme.json"),
          sourceInfo: { scope: "user" },
        },
      ],
    };
    await writeFile(join(agentDir, "themes", "pkg-theme.json"), themeDoc("pkg-theme"), "utf8");
    const withLoader = createSdkThemePort({
      agentDir,
      cwd: projectDir,
      loaderThemes,
      io: createNodeModelsFileIo(),
      listing: createNodeFileListingIo(),
    });
    expect(await withLoader.listLoaded()).toEqual([
      { name: "pkg-theme", path: join(agentDir, "themes", "pkg-theme.json"), scope: "user" },
    ]);
  });
});
