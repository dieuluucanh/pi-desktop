import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Packaging guard (plan step 26).
 *
 * Packaging is the one deliverable no unit test can exercise end to end (it
 * needs a clean machine and a real installer), so this test pins the parts that
 * *are* checkable in-repo and are easy to break silently: the target set, the
 * runtime/manifest resources the app reads by path, the asar unpack list the
 * SDK's dynamic loading needs, the GitHub update feed, and the pinned runtime
 * artifacts the target platforms require.
 *
 * `electron-builder.yml` is read as text: no YAML parser is a dependency, and
 * the assertions below are about presence of the named entries, not about YAML
 * semantics.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const builderYaml = readFileSync(join(repoRoot, "electron-builder.yml"), "utf8");
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  main: string;
  scripts: Record<string, string>;
  repository?: { type?: string; url?: string };
  dependencies: Record<string, string>;
};
const lock = JSON.parse(
  readFileSync(join(repoRoot, "resources", "runtime", "node.lock.json"), "utf8"),
) as { node: { version: string; artifacts: Record<string, unknown> } };

describe("electron-builder config (plan step 26)", () => {
  it("declares Windows NSIS + portable, macOS dmg/zip on both arches, and Linux AppImage/deb", () => {
    expect(builderYaml).toMatch(/target:\s*nsis/);
    expect(builderYaml).toMatch(/target:\s*portable/);
    expect(builderYaml).toMatch(/target:\s*dmg/);
    expect(builderYaml).toMatch(/target:\s*zip/);
    expect(builderYaml).toMatch(/arch:\s*\[arm64,\s*x64\]/);
    expect(builderYaml).toMatch(/target:\s*\[AppImage,\s*deb\]/);
  });

  it("ships the bundled runtime and the Office manifest outside the asar", () => {
    // Both are read by absolute path at runtime, so they cannot live in the asar.
    expect(builderYaml).toMatch(/from:\s*resources\/runtime/);
    expect(builderYaml).toMatch(/from:\s*resources\/office/);
    expect(builderYaml).toMatch(/to:\s*runtime/);
    expect(builderYaml).toMatch(/to:\s*office/);
  });

  it("names a brand icon for every platform it targets, and ships them to the app", () => {
    // Without these keys electron-builder silently falls back to its bundled
    // Electron icon, so an installer can ship unbranded without any error.
    expect(builderYaml).toMatch(/win:\n(?:.*\n)*?\s+icon:\s*assets\/icon\.ico/);
    expect(builderYaml).toMatch(/mac:\n(?:.*\n)*?\s+icon:\s*assets\/icon-512\.png/);
    expect(builderYaml).toMatch(/linux:\n(?:.*\n)*?\s+icon:\s*assets\/icon-512\.png/);
    // The runtime reads the window/dock icons by path, so they travel outside
    // the asar. Only these two do — the Office-branded SVGs stay behind.
    expect(builderYaml).toMatch(/from:\s*assets/);
    expect(builderYaml).toMatch(/to:\s*branding/);
    expect(builderYaml).toMatch(/"icon\.ico"/);
    expect(builderYaml).toMatch(/"icon-512\.png"/);
  });

  it("points those icon keys at files that exist", () => {
    // A typo'd path is another way to get the default icon with no error.
    const declared = [...builderYaml.matchAll(/icon:\s*(assets\/[^\s"']+)/g)].map(
      (match) => match[1] ?? "",
    );
    expect(declared.length).toBeGreaterThanOrEqual(3);
    for (const file of declared) expect(() => statSync(join(repoRoot, file)), file).not.toThrow();
  });

  it("unpacks the SDK, jiti, typebox and the runtime", () => {
    // Extensions are loaded from real files on disk (plan D2); an asar-packed
    // `@earendil-works/*` breaks dynamic TypeScript/extension resolution.
    expect(builderYaml).toContain('"**/node_modules/@earendil-works/**"');
    expect(builderYaml).toContain('"**/node_modules/jiti/**"');
    expect(builderYaml).toContain('"**/node_modules/typebox/**"');
    expect(builderYaml).toContain("resources/runtime/**");
  });

  it("uses URL-safe, target-distinct artifact names and a GitHub update feed", () => {
    // A space is expanded unsanitized on disk but sanitized in `latest.yml`, so
    // `${productName}` must never appear in an artifact name (plan step 27).
    expect(builderYaml).not.toMatch(/artifactName:.*\$\{productName\}/);
    const names = [...builderYaml.matchAll(/artifactName:\s*"([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) expect(name, name).not.toContain(" ");
    // NSIS and portable are both `.exe`: they must not share one name.
    expect(new Set(names).size).toBe(names.length);
    expect(builderYaml).toMatch(/nsis:\s*\n\s+artifactName:\s*"[^"]*-setup\.\$\{ext\}"/);
    expect(builderYaml).toMatch(/portable:\s*\n\s+artifactName:\s*"[^"]*-portable\.\$\{ext\}"/);
    expect(builderYaml).toMatch(
      /artifactName:\s*"Pi-Desktop-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}"/,
    );
    expect(builderYaml).toMatch(/provider:\s*github/);
    expect(packageJson.repository?.url).toContain("github.com");
  });

  it("keeps the package entry, dependency and scripts the updater relies on", () => {
    expect(packageJson.main).toBe("out/main/index.mjs");
    expect(packageJson.dependencies["electron-updater"]).toBeTruthy();
    for (const script of ["package:win", "package:mac", "package:linux"]) {
      expect(packageJson.scripts[script], script).toBeTruthy();
    }
    // A package script builds first and verifies the bundled runtime before
    // electron-builder runs, so an installer can never ship without one.
    expect(packageJson.scripts["package:win"]).toContain("runtime:verify");
    expect(packageJson.scripts["package:win"]).toContain("electron-builder");
  });

  it("has pinned runtime artifacts for every platform the builder targets", () => {
    const artifacts = Object.keys(lock.node.artifacts);
    for (const target of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) {
      expect(artifacts, target).toContain(target);
    }
    expect(lock.node.version).toMatch(/^24\./);
  });
});
