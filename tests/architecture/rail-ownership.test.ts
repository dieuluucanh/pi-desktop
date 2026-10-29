import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rail ownership guard (git-checkpoint plan step 30).
 *
 * The rail replaced a single-purpose `<aside>` with one host plus section bodies.
 * Two invariants keep that true, and neither can be enforced by a single module:
 *
 *  1. **Exactly one rail host.** A second right-hand column would re-create the
 *     competing-panel problem the refactor removed, so `<aside>` may only appear
 *     in `layout/Sidebar.tsx` and `layout/RightRail.tsx` (the rail) among the
 *     session's columns — and `rail/` section bodies must never render one.
 *  2. **The old ephemeral toggle is gone.** `documentsPanelOpen` was an
 *     update-time flag that duplicated what `prefs.rail.open` now owns. Leaving a
 *     reference behind would mean two sources of truth for whether the column
 *     exists.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;

async function rendererFiles(): Promise<string[]> {
  const entries = await readdir(join(repoRoot, "src", "renderer", "src"), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * Files allowed to render an `<aside>`: the two columns of the frame. The rail
 * host lives beside its section bodies (`rail/RightRail.tsx`) rather than in
 * `layout/`, so that adding a section never means touching the chrome directory —
 * see the assertion below, which pins that choice.
 */
const ASIDE_OWNERS = new Set([
  "src/renderer/src/layout/Sidebar.tsx",
  "src/renderer/src/rail/RightRail.tsx",
]);

describe("rail ownership", () => {
  it("has exactly one right-hand rail host", async () => {
    const files = await rendererFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (!/<aside[\s>]/.test(text)) continue;
      const relativePath = relative(repoRoot, file).replace(/\\/g, "/");
      if (!ASIDE_OWNERS.has(relativePath)) offenders.push(relativePath);
    }
    expect(offenders).toEqual([]);
  });

  it("never renders a section body as its own column", async () => {
    const dir = join(repoRoot, "src", "renderer", "src", "rail");
    const entries = await readdir(dir, { withFileTypes: true });
    const sections = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) => entry.name)
      // The host itself is the one `<aside>`, by definition.
      .filter((name) => name !== "RightRail.tsx");
    expect(sections.length).toBeGreaterThan(3);
    for (const name of sections) {
      const text = await readFile(join(dir, name), "utf8");
      expect(/<aside[\s>]/.test(text), name).toBe(false);
      // A fixed width would make a section fight the rail's resizable column.
      expect(/shrink-0[^\n]*\bw-\d/.test(text), name).toBe(false);
    }
  });

  it("keeps the rail host next to its sections, and only one of it", async () => {
    // One host, and it is the file the sections live beside: a second
    // `layout/RightRail.tsx` would be a competing column.
    const layout = await readdir(join(repoRoot, "src", "renderer", "src", "layout"));
    expect(layout).not.toContain("RightRail.tsx");
    const rail = await readdir(join(repoRoot, "src", "renderer", "src", "rail"));
    expect(rail.filter((name) => name === "RightRail.tsx")).toHaveLength(1);
  });

  it("keeps one test id for the rail's document surface", async () => {
    // The section body owns `documents-section`; nothing should still be
    // rendering the removed `documents-panel` id.
    const files = await rendererFiles();
    const offenders: string[] = [];
    for (const file of files) {
      if ((await readFile(file, "utf8")).includes('"documents-panel"')) {
        offenders.push(relative(repoRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no surviving documentsPanelOpen reference in src or tests", async () => {
    const offenders: string[] = [];
    const roots = [join(repoRoot, "src"), join(repoRoot, "tests")];
    for (const root of roots) {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
        const file = join(entry.parentPath, entry.name);
        const text = await readFile(file, "utf8");
        // A comment naming it as history is fine; a *reference* is not. Match an
        // identifier use, not prose.
        if (/\bdocumentsPanelOpen\s*[:,}=)]/.test(text)) {
          offenders.push(relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("mounts the rail from the session view, not from a view of its own", async () => {
    const sessionView = await readFile(
      join(repoRoot, "src", "renderer", "src", "views", "SessionView.tsx"),
      "utf8",
    );
    expect(sessionView).toContain("<RightRail");
    // Every rail section is registered there, so an unmounted section cannot
    // silently exist.
    for (const id of ["git", "changes", "history", "checkpoints"]) {
      expect(sessionView).toContain(`id: "${id}"`);
    }
  });
});
