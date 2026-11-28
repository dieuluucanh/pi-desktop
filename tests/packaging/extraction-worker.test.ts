import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Packaging contract for the document-extraction worker (plan step 18). */
describe("document extraction worker packaging", () => {
  it("is a dedicated host build entry and ships unpacked beside the other hosts", async () => {
    const vite = await readFile(join(repoRoot, "vite.host.config.ts"), "utf8");
    expect(vite).toContain('"extraction-worker": resolve("./src/extraction/worker.ts")');
    const builder = await readFile(join(repoRoot, "electron-builder.yml"), "utf8");
    // The worker runs under the bundled Node, so it must remain a real file.
    expect(builder).toMatch(/asarUnpack:\s*[\s\S]*out\/\*\*/);
  });

  it("resolves the packaged worker beside the Pi and terminal hosts", async () => {
    const { resolveRuntime } = await import("../../src/main/runtime/resolve-runtime");
    const resolution = resolveRuntime({
      isPackaged: true,
      appRoot: "/app",
      resourcesPath: "/resources",
      env: {},
      exists: () => true,
      probeVersion: () => "v24.22.2",
    } as never);
    expect(resolution.extractionWorkerPath).toBe(
      join("/resources", "app.asar.unpacked", "out", "host", "extraction-worker.mjs"),
    );
  });

  it("imports no Electron, Pi SDK, terminal or Office module", async () => {
    const entries = await readdir(join(repoRoot, "src", "extraction"), {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries.filter((item) => item.isFile())) {
      const source = await readFile(join(entry.parentPath, entry.name), "utf8");
      for (const forbidden of [
        'from "electron"',
        "@earendil-works",
        "node-pty",
        "src/host",
        "src/main/office",
        "src/host/terminal",
      ]) {
        expect(source, `${entry.name} imports ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
