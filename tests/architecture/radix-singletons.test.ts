import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Dependency-singleton guard (2026-11-03 editor/pointer-lock plan step 2).
 *
 * These packages coordinate through *module-level* state, so two installed
 * copies are two independent states on top of one document:
 *
 *  - `@radix-ui/react-dismissable-layer` keeps one
 *    `originalBodyPointerEvents` string and one shadow-layer set per module
 *    instance. A dialog from copy B that mounts while a context menu from copy A
 *    is closing records `"none"` as its "previous" body style and restores it on
 *    close, leaving `<body>` with `pointer-events: none` — the whole renderer
 *    ignores the mouse while still rendering. This actually shipped: the
 *    context menu pulled 1.1.11 while dialogs used 1.1.19
 *    (radix-ui/primitives#3317, #3645).
 *  - `@radix-ui/react-focus-guards` keeps a module-level guard counter.
 *  - `react-remove-scroll` / `react-remove-scroll-bar` keep the shared body
 *    scroll-lock counter and the injected scrollbar styles.
 *  - `aria-hidden` keeps the per-document marker map used by Radix's
 *    `hideOthers`.
 *
 * The fix is the `overrides` block in package.json; this test is the durable
 * guard so a future dependency bump cannot silently reintroduce a duplicate.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SINGLETON_PACKAGES = [
  "@radix-ui/react-dismissable-layer",
  "@radix-ui/react-focus-guards",
  "react-remove-scroll",
  "react-remove-scroll-bar",
  "aria-hidden",
] as const;

interface LockfilePackage {
  version?: string;
}

interface Lockfile {
  packages?: Record<string, LockfilePackage>;
}

/**
 * Every lockfile entry that installs `name`, including nested copies. The
 * hoisted entry is `node_modules/<name>`; a nested one looks like
 * `node_modules/<parent>/node_modules/<name>`.
 */
export function installedCopiesOf(packages: Record<string, unknown>, name: string): string[] {
  const hoisted = `node_modules/${name}`;
  const nestedSuffix = `/node_modules/${name}`;
  return Object.keys(packages).filter((key) => key === hoisted || key.endsWith(nestedSuffix));
}

describe("dependency singletons", () => {
  it("recognises a nested copy of a package", () => {
    const copies = installedCopiesOf(
      {
        "node_modules/react": {},
        "node_modules/@radix-ui/react-dismissable-layer": {},
        "node_modules/@radix-ui/react-context-menu/node_modules/@radix-ui/react-dismissable-layer":
          {},
      },
      "@radix-ui/react-dismissable-layer",
    );
    expect(copies).toEqual([
      "node_modules/@radix-ui/react-dismissable-layer",
      "node_modules/@radix-ui/react-context-menu/node_modules/@radix-ui/react-dismissable-layer",
    ]);
  });

  it("keeps every stateful package at exactly one hoisted copy", async () => {
    const lock = JSON.parse(
      await readFile(join(repoRoot, "package-lock.json"), "utf8"),
    ) as Lockfile;
    const packages = lock.packages ?? {};

    for (const name of SINGLETON_PACKAGES) {
      expect(installedCopiesOf(packages, name), `${name} must be installed once`).toEqual([
        `node_modules/${name}`,
      ]);
    }
  });
});
