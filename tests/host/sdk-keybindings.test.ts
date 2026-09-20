import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createNodeModelsFileIo } from "../../src/host/file-io";
import { createSdkKeybindingPort } from "../../src/host/sdk/keybindings";

let root: string;
let agentDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-desktop-keybindings-"));
  agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createSdkKeybindingPort", () => {
  it("points at the profile's keybindings.json and round-trips atomically", async () => {
    const port = createSdkKeybindingPort({ agentDir, io: createNodeModelsFileIo() });
    expect(port.path()).toBe(join(agentDir, "keybindings.json"));
    expect(await port.read()).toBeNull();
    await port.write('{"app.exit": ["ctrl+q"]}\n');
    expect(JSON.parse(await readFile(port.path(), "utf8"))).toEqual({ "app.exit": ["ctrl+q"] });
    expect(await port.read()).toMatch(/ctrl\+q/);
    await port.remove();
    expect(await port.read()).toBeNull();
    // Removing twice is not an error (reset on a fresh profile).
    await port.remove();
  });

  it("never touches the session cwd", async () => {
    const projectDir = join(root, "project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "keybindings.json"), "{}", "utf8");
    const port = createSdkKeybindingPort({ agentDir, io: createNodeModelsFileIo() });
    expect(port.path()).not.toContain(projectDir);
  });
});
