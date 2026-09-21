import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Release guard (plan step 27).
 *
 * The release itself cannot be tested here — it needs a clean machine, real
 * providers and a real installer. What *is* checkable, and easy to break
 * silently late in a release, is that the artefacts stay consistent: one
 * version, release notes that actually carry the known limitations, an explicit
 * backlog, a traceability table whose rows point at files that exist, and an
 * `ExtensionUIContext` parity table that still covers every SDK member.
 *
 * `electron-builder.yml` and the SDK type file are read as text; the assertions
 * are about the named entries, not about YAML/TS semantics.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");
const exists = (relative: string): boolean => existsSync(join(repoRoot, relative));

const packageJson = JSON.parse(read("package.json")) as {
  version: string;
  repository?: { url?: string };
};
const releaseNotes = read("docs/releases/v0.1.0.md");
const backlog = read("docs/product/backlog.md");
const traceability = read("docs/product/traceability.md");
const extensionUi = read("docs/architecture/extension-ui.md");
const troubleshooting = read("docs/guide/troubleshooting.md");
const docsIndex = read("docs/README.md");
const readme = read("README.md");

describe("release guard (plan step 27)", () => {
  it("pins one version across the package, the release notes and the docs", () => {
    expect(packageJson.version).toBe("0.1.0");
    expect(exists(`docs/releases/v${packageJson.version}.md`), "release notes exist").toBe(true);
    for (const doc of [readme, docsIndex, releaseNotes]) {
      expect(doc).toContain(`v${packageJson.version}`);
    }
    // The updater feed and the builder agree on the repository.
    expect(packageJson.repository?.url).toContain("github.com");
  });

  it("ships release notes with a known-limitations list covering every platform", () => {
    expect(releaseNotes).toMatch(/## Known limitations/);
    for (const phrase of [
      "Unsigned builds",
      "macOS and Linux are beta",
      "Upstream",
      "Verified structurally, not on a live machine",
    ]) {
      expect(releaseNotes, phrase).toContain(phrase);
    }
    for (const platform of ["Windows", "macOS", "Linux"]) {
      expect(releaseNotes, platform).toContain(platform);
    }
  });

  it("documents the limitations in troubleshooting and links the backlog", () => {
    expect(troubleshooting).toMatch(/Known limitations/);
    expect(troubleshooting).toContain("releases/v0.1.0.md");
    expect(troubleshooting).toContain("product/backlog.md");
  });

  it("records the deferred backlog explicitly", () => {
    for (const item of [
      "In-app terminal tab",
      "Native Plan/Review workspace",
      "SQLite session index",
      "i18n",
      "Git worktrees",
      "MCP bridge",
      "Multi-window",
    ]) {
      expect(backlog, item).toContain(item);
    }
    // Items the MVP deferred during the plan, not only the post-MVP table.
    for (const item of [
      "Code signing",
      "External-editor launcher",
      "files.read",
      "resolveInsideRoot",
    ]) {
      expect(backlog, item).toContain(item);
    }
  });

  it("keeps every requirement row on a step range and an existing file", () => {
    const rows = traceability
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith("|") && !line.includes("---") && !line.startsWith("| Requirement"),
      );
    expect(rows.length).toBeGreaterThanOrEqual(14);
    for (const row of rows) {
      const cells = row
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0);
      expect(cells.length, row).toBeGreaterThanOrEqual(3);
      const steps = cells[1] ?? "";
      const evidence = cells[2] ?? "";
      expect(steps, row).toMatch(/^[0-9][0-9,\s–-]*$/);
      const paths = [...evidence.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
      expect(paths.length, row).toBeGreaterThan(0);
      for (const path of paths) {
        expect(exists(path), `${row} → ${path}`).toBe(true);
      }
    }
  });

  it("covers every ExtensionUIContext member in the parity doc, with real tests", () => {
    const typesPath =
      "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts";
    const source = read(typesPath);
    const start = source.indexOf("export interface ExtensionUIContext");
    expect(start, typesPath).toBeGreaterThan(-1);
    const end = source.indexOf("\n}", start);
    const block = source.slice(start, end + 2);
    const members = [
      ...new Set(
        [
          ...block.matchAll(/^ {4}(?:readonly\s+)?([A-Za-z][A-Za-z0-9]*)\s*(?:<[^>]*>)?\s*[(:]/gm),
        ].map((match) => match[1] ?? ""),
      ),
    ];
    // The pinned SDK's surface: 28 members. A new member must be documented.
    expect(members.length).toBe(28);
    for (const member of members) {
      expect(extensionUi, `missing ${member} in extension-ui.md`).toContain(member);
    }
    // The doc's Tests table must name files that exist (the "covered by a test" row).
    const testPaths = [...extensionUi.matchAll(/`(tests\/[^`]+\.(?:ts|tsx))`/g)].map(
      (match) => match[1] ?? "",
    );
    expect(testPaths.length).toBeGreaterThan(0);
    for (const path of testPaths) {
      expect(exists(path), path).toBe(true);
    }
  });
});
