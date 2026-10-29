import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Panel-rail ownership guard.
 *
 * The rail replaced a single-purpose `<aside>` with one host plus menu bodies,
 * and then replaced the five stacked sections with a docked strip of three
 * menus. Four invariants keep that true, and none of them can be enforced by a
 * single module:
 *
 *  1. **Exactly one rail host.** A second right-hand column would re-create the
 *     competing-panel problem the refactor removed, so `<aside>` may only appear
 *     in `layout/Sidebar.tsx` and `rail/RightRail.tsx` — and the menu bodies must
 *     never render one.
 *  2. **The strip is never unmounted.** The old host returned `null` while
 *     closed, so a closed rail had no affordance at all; that is what made the
 *     header button's disappearance fatal. A body-only early return is the
 *     regression this pins.
 *  3. **One source of truth for the layout.** `prefs.rail` has one writer (the
 *     store) and one shape (menus, order, active menu). A surviving
 *     `rail.sections`/`toggleRailSection`/`RailSectionId` reference would mean a
 *     second, stale vocabulary still steering the UI.
 *  4. **No resurrected header toggle.** The session header no longer owns a
 *     Panel button; the strip is the entry point.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;

async function filesUnder(...segments: string[]): Promise<string[]> {
  const entries = await readdir(join(repoRoot, ...segments), {
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

async function rendererFiles(): Promise<string[]> {
  return filesUnder("src", "renderer", "src");
}

/**
 * Files allowed to render an `<aside>`: the two columns of the frame. The rail
 * host lives beside its menu bodies (`rail/RightRail.tsx`) rather than in
 * `layout/`, so that adding a body never means touching the chrome directory.
 */
const ASIDE_OWNERS = new Set([
  "src/renderer/src/layout/Sidebar.tsx",
  "src/renderer/src/rail/RightRail.tsx",
]);

describe("panel rail ownership", () => {
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

  it("never renders a menu body as its own column", async () => {
    const dir = join(repoRoot, "src", "renderer", "src", "rail");
    const entries = await readdir(dir, { withFileTypes: true });
    const bodies = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) => entry.name)
      // The host itself is the one `<aside>`, by definition.
      .filter((name) => name !== "RightRail.tsx");
    // The three menu bodies plus their dialogs and the git pieces.
    expect(bodies.length).toBeGreaterThan(6);
    for (const name of bodies) {
      const text = await readFile(join(dir, name), "utf8");
      expect(/<aside[\s>]/.test(text), name).toBe(false);
      // A fixed width would make a body fight the rail's resizable column.
      expect(/shrink-0[^\n]*\bw-\d/.test(text), name).toBe(false);
    }
  });

  it("keeps the rail host next to its bodies, and only one of it", async () => {
    const layout = await readdir(join(repoRoot, "src", "renderer", "src", "layout"));
    expect(layout).not.toContain("RightRail.tsx");
    const rail = await readdir(join(repoRoot, "src", "renderer", "src", "rail"));
    expect(rail.filter((name) => name === "RightRail.tsx")).toHaveLength(1);
    expect(rail.filter((name) => name === "RailStrip.tsx")).toHaveLength(1);
  });

  it("keeps the strip mounted while the panel is closed", async () => {
    const host = await readFile(
      join(repoRoot, "src", "renderer", "src", "rail", "RightRail.tsx"),
      "utf8",
    );
    // The strip is rendered unconditionally: only the panel body is conditional.
    expect(host).toContain("<RailStrip");
    // The regression: an early `return null` on `!rail.open` unmounted the whole
    // column, which is why a closed rail had no way back in.
    expect(host).not.toMatch(/if\s*\(!rail\.open\)\s*return\s+null/);
    const strip = await readFile(
      join(repoRoot, "src", "renderer", "src", "rail", "RailStrip.tsx"),
      "utf8",
    );
    expect(strip).toContain('data-testid="rail-strip"');
  });

  const GUARD_FILE = "tests/architecture/rail-ownership.test.ts";

  it("has one source of truth for the panel layout", async () => {
    // The previous shape (`sections`) and its store action must be gone: a
    // surviving reference would mean a second, stale vocabulary still steering
    // the UI. Only identifier *uses* are matched, so migration comments are fine.
    const offenders: string[] = [];
    const roots = [join(repoRoot, "src"), join(repoRoot, "tests")];
    for (const root of roots) {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
        const file = join(entry.parentPath, entry.name);
        // This file names the identifiers and the pattern; it is not a use.
        if (relative(repoRoot, file).replace(/\\/g, "/") === GUARD_FILE) continue;
        const text = await readFile(file, "utf8");
        if (
          /\bRailSectionId\b/.test(text) ||
          /\bRAIL_SECTION_IDS\b/.test(text) ||
          /\btoggleRailSection\b/.test(text) ||
          /\brail\??\.sections\b/.test(text)
        ) {
          offenders.push(relative(repoRoot, file).replace(/\\/g, "/"));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has no Panel button in the app chrome", async () => {
    const files = await rendererFiles();
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (/aria-label="Panel"/.test(text) || />\s*Panel\s*</.test(text)) {
        offenders.push(relative(repoRoot, file).replace(/\\/g, "/"));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps one test id for the rail's document surface", async () => {
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
        // A comment naming it as history is fine; a *reference* is not.
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
    // Every menu is registered there, so an unmounted menu cannot silently exist.
    for (const id of ["source-control", "checkpoints"]) {
      expect(sessionView).toContain(`id: "${id}"`);
    }
    // Documents stays conditional on the Office bridge (plan D-A10).
    expect(sessionView).toContain('id: "documents"');
  });
});
