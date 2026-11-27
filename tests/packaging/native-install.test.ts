import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Native install policy (2026-11-08 linux-terminal plan, step 8).
 *
 * npm 12 defaults `allowScripts` to off and blocks dependency install scripts —
 * including implicit `node-gyp` builds for packages with a `binding.gyp`. Node
 * 24.22.2 still ships npm 11.19.1, so releases compile today, but any move to a
 * newer Node/npm would silently produce a Linux package with no `pty.node`,
 * exactly the v0.8.0 symptom with a different cause.
 *
 * These assertions pin the approval to the locked version: bumping node-pty
 * without reviewing the new tarball fails here instead of at first terminal use.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  allowScripts?: Record<string, boolean>;
};
const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string; hasInstallScript?: boolean }>;
};

const lockedNodePty = lock.packages["node_modules/node-pty"]?.version;

describe("npm install scripts", () => {
  it("approves node-pty's install script at exactly the locked version", () => {
    expect(lockedNodePty).toBeTypeOf("string");
    expect(lock.packages["node_modules/node-pty"]?.hasInstallScript).toBe(true);
    expect(pkg.allowScripts).toMatchObject({ [`node-pty@${lockedNodePty}`]: true });
    // A name-only entry would approve every future version without review.
    expect(pkg.allowScripts?.["node-pty"]).toBeUndefined();
  });

  it("never blanket-approves every dependency", () => {
    expect(pkg.allowScripts?.["*"]).toBeUndefined();
    expect(pkg.allowScripts?.["*@*"]).toBeUndefined();
    for (const [name, allowed] of Object.entries(pkg.allowScripts ?? {})) {
      expect(allowed, name).toBe(true);
      // Every approval is a version pin, so a bumped tarball is re-reviewed.
      expect(name, name).toMatch(/^@?[^@]+@\d+\.\d+\.\d+/);
    }
  });
});
