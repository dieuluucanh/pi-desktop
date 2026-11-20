import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { IPC } from "../../src/shared/ipc";

/**
 * Architecture guards for the app's trust boundaries (plan step 23).
 *
 * Three static invariants that no single module can enforce by itself:
 *
 * 1. **The IPC allowlist is closed.** Every channel declared in
 *    `src/shared/ipc.ts` is reachable from the preload, every channel the
 *    preload invokes has a `ipcMain.handle`, and neither side ever passes a raw
 *    channel string.
 * 2. **The renderer HTML is inline-script-free** and carries the CSP
 *    placeholder the build plugin replaces.
 * 3. **The app's own surface is the only one with a preload** (asserted by
 *    `tests/main/security.test.ts`; the HTML rule lives here because it is a
 *    source-text invariant).
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1] ?? "").filter(Boolean);
}

async function sourceFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, dir), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("IPC allowlist", () => {
  it("keeps every declared channel reachable from the preload", async () => {
    const preload = await readFile(join(repoRoot, "src/preload/index.ts"), "utf8");
    const referenced = new Set(matchAll(preload, /IPC\.([A-Za-z0-9_]+)/g));
    const declared = Object.keys(IPC);
    const missing = declared.filter((key) => !referenced.has(key));
    expect(missing).toEqual([]);
  });

  it("registers exactly the channels the preload invokes", async () => {
    const preload = await readFile(join(repoRoot, "src/preload/index.ts"), "utf8");
    const main = await readFile(join(repoRoot, "src/main/ipc.ts"), "utf8");
    const invoked = new Set(matchAll(preload, /ipcRenderer\.invoke\(\s*IPC\.([A-Za-z0-9_]+)/g));
    const handled = new Set(matchAll(main, /ipcMain\.handle\(\s*IPC\.([A-Za-z0-9_]+)/g));
    expect([...invoked].sort()).toEqual([...handled].sort());
    expect(invoked.size).toBeGreaterThan(10);
  });

  it("sends every push channel the preload subscribes to", async () => {
    const preload = await readFile(join(repoRoot, "src/preload/index.ts"), "utf8");
    const subscribed = new Set(
      matchAll(preload, /subscribe(?:<[^(]*>)?\(\s*IPC\.([A-Za-z0-9_]+)/g),
    );
    const mainFiles = await sourceFilesUnder("src/main");
    const mainSource = (await Promise.all(mainFiles.map((file) => readFile(file, "utf8")))).join(
      "\n",
    );
    const missing = [...subscribed].filter((key) => !mainSource.includes(`IPC.${key}`));
    expect(missing).toEqual([]);
    expect(subscribed.size).toBeGreaterThan(3);
  });

  it("covers every declared channel with an invoke, a send or a subscribe", async () => {
    const preload = await readFile(join(repoRoot, "src/preload/index.ts"), "utf8");
    const invoked = new Set(matchAll(preload, /ipcRenderer\.invoke\(\s*IPC\.([A-Za-z0-9_]+)/g));
    // Fire-and-forget channels (terminal ack/focus) intentionally use `send`;
    // their `ipcMain.on` handlers are the counterpart, not an invoke.
    const sent = new Set(matchAll(preload, /ipcRenderer\.send\(\s*IPC\.([A-Za-z0-9_]+)/g));
    const subscribed = new Set(
      matchAll(preload, /subscribe(?:<[^(]*>)?\(\s*IPC\.([A-Za-z0-9_]+)/g),
    );
    const covered = new Set([...invoked, ...sent, ...subscribed]);
    const uncovered = Object.keys(IPC).filter((key) => !covered.has(key));
    expect(uncovered).toEqual([]);
  });

  it("never passes a raw channel string across the bridge", async () => {
    const preload = await readFile(join(repoRoot, "src/preload/index.ts"), "utf8");
    const main = await readFile(join(repoRoot, "src/main/ipc.ts"), "utf8");
    expect(preload).not.toMatch(/ipcRenderer\.(?:invoke|send|on)\(\s*["']/);
    expect(main).not.toMatch(/ipcMain\.handle\(\s*["']/);
  });
});

describe("renderer HTML", () => {
  it("has no inline script and carries the CSP placeholder", async () => {
    const html = await readFile(join(repoRoot, "src/renderer/index.html"), "utf8");
    // Inline script would need `'unsafe-inline'` in production; there is none.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("__PI_RENDERER_CSP__");
    // Exactly one module entry, loaded from the bundle.
    expect(html).toMatch(/<script type="module" src="\.\/src\/main\.tsx"><\/script>/);
  });

  it("resolves its module entry to a real file", async () => {
    const entry = join(repoRoot, "src/renderer/src/main.tsx");
    const text = await readFile(entry, "utf8");
    expect(text.length).toBeGreaterThan(0);
    expect(relative(repoRoot, entry).replace(/\\/g, "/")).toBe("src/renderer/src/main.tsx");
  });
});

describe("credentials never reach the renderer", () => {
  it("exposes no channel that could return credential material", () => {
    // `providers.*` returns status summaries only; a channel named for auth or
    // credentials would be the shape that hands the file over wholesale.
    const suspicious = Object.keys(IPC).filter((key) =>
      /auth|credential|secret|token|apikey/i.test(key),
    );
    expect(suspicious).toEqual([]);
  });

  it("keeps the renderer free of filesystem access", async () => {
    const files = await sourceFilesUnder("src/renderer");
    const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
    for (const [index, source] of sources.entries()) {
      // The renderer is sandboxed and has no preload Node access; an import of
      // `node:fs` here would mean the sandbox assumption is already broken.
      expect(source, files[index]).not.toMatch(/from\s+["']node:fs/);
      expect(source, files[index]).not.toMatch(/require\(\s*["']node:fs/);
    }
  });
});
