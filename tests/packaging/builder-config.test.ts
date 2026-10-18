import { existsSync, readFileSync, statSync } from "node:fs";
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
// Normalise line endings: the config is checked in with CRLF on Windows, and the
// block-shaped assertions below anchor on `\n`.
const builderYaml = readFileSync(join(repoRoot, "electron-builder.yml"), "utf8").replace(
  /\r\n/g,
  "\n",
);
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  name: string;
  main: string;
  author?: { name?: string; email?: string };
  scripts: Record<string, string>;
  repository?: { type?: string; url?: string };
  dependencies: Record<string, string>;
};
const lock = JSON.parse(
  readFileSync(join(repoRoot, "resources", "runtime", "node.lock.json"), "utf8"),
) as {
  node: {
    version: string;
    artifacts: Record<string, unknown>;
    npmPayload?: Record<string, { path?: string; sha256?: string }>;
  };
};

/** Text of a top-level `key:` block, up to the next top-level key. */
function block(key: string): string {
  return (
    new RegExp(`(?:^|\\n)${key}:(\\n[\\s\\S]*?)(?=\\n[a-zA-Z]|$)`).exec(builderYaml)?.[1] ?? ""
  );
}

describe("electron-builder config (plan step 26)", () => {
  it("declares Windows NSIS + portable, macOS dmg/zip on both arches, and Linux AppImage/deb", () => {
    expect(builderYaml).toMatch(/target:\s*nsis/);
    expect(builderYaml).toMatch(/target:\s*portable/);
    expect(builderYaml).toMatch(/target:\s*dmg/);
    expect(builderYaml).toMatch(/target:\s*zip/);
    expect(builderYaml).toMatch(/arch:\s*\[arm64,\s*x64\]/);
    expect(builderYaml).toMatch(/target:\s*AppImage/);
    expect(builderYaml).toMatch(/target:\s*deb/);
    // Linux is the one platform that also ships arm64, so its targets carry
    // their own arch lists (the beta artefacts are built per arch in CI).
    expect(builderYaml).toMatch(/target:\s*AppImage\s*\n\s+arch:\s*\[x64,\s*arm64\]/);
    expect(builderYaml).toMatch(/target:\s*deb\s*\n\s+arch:\s*\[x64,\s*arm64\]/);
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

  it("unpacks every node_modules package the bundled-Node host loads", () => {
    // The host runs under the bundled Node, which has no asar support, so a
    // dependency left inside the asar is a runtime `ERR_MODULE_NOT_FOUND` on the
    // first session (this is exactly how `highlight.js` was lost while only the
    // SDK, jiti and typebox were unpacked). A blanket entry is the only pattern
    // that cannot fall behind the SDK's dependency tree.
    const unpacked = block("asarUnpack");
    expect(unpacked).toContain('"**/node_modules/**"');
    expect(unpacked).toContain("resources/runtime/**");
    // A narrower list must not creep back in as a replacement.
    expect(unpacked).not.toContain('"**/node_modules/@earendil-works/**"');
  });

  it("unpacks out/** so the packaged app can spawn its host", () => {
    // Without its own `asarUnpack` entry every packaged session fails with
    // "Cannot find module …app.asar.unpacked\out\host\index.mjs": the app launches
    // and then can never reach a Pi host. The unpacked location is what both the
    // supervisor and the shims use, so it has to ship.
    expect(block("asarUnpack")).toMatch(/\n\s+- out\/\*\*/);
    expect(
      readFileSync(join(repoRoot, "src", "main", "runtime", "resolve-runtime.ts"), "utf8"),
      "resolve-runtime.ts must still resolve the host inside app.asar.unpacked",
    ).toContain("app.asar.unpacked");
  });

  it("regenerates the runtime shims for the packaged layout", () => {
    // The shims are written at fetch time with dev paths that point back into the
    // build machine's repo, and `extraResources` only exist by `afterPack`, so the
    // hook is the only place that can fix them. Both halves are pinned.
    const afterPack = /afterPack:\s*(\S+)/.exec(builderYaml)?.[1] ?? "";
    expect(afterPack).toBe("scripts/electron-builder-after-pack.mjs");
    expect(existsSync(join(repoRoot, afterPack)), afterPack).toBe(true);
    const hook = readFileSync(join(repoRoot, afterPack), "utf8");
    expect(hook).toContain("--mode");
    expect(hook).toContain("packaged");
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

  it("fills in the Linux metadata fpm and the desktop entry require", () => {
    // fpm refuses a deb without a maintainer, and electron-builder refuses to
    // guess an author email: both must be present, in the config or package.json.
    expect(packageJson.author?.email, "author email").toBeTruthy();
    const linux = block("linux");
    expect(linux).toMatch(/\n\s+maintainer:\s*\S/);
    expect(linux).toMatch(/\n\s+vendor:\s*\S/);
    // `productName` has a space: the binary, the `.desktop` filename and the
    // `StartupWMClass` all come from executableName, so it must be set.
    expect(packageJson.name).not.toContain(" ");
    expect(linux).toMatch(/\n\s+executableName:\s*pi-desktop/);
    // deb data files are under /opt (start-prefix), not /usr/bin.
    expect(linux).toMatch(/\n\s+category:\s*Development/);
  });

  it("keeps the deb dependency list resolvable on current Ubuntu", () => {
    // electron-builder's defaults name `libgtk-3-0`, which Ubuntu 24.04+ no longer
    // provides (it is `libgtk-3-0t64`); an own depends list is the only way the
    // package stays installable, so the shape of it is pinned here.
    const deb = block("deb");
    expect(deb, "deb: block").not.toBe("");
    expect(deb).toMatch(/\n\s+depends:/);
    for (const dependency of ["libgtk-3-0", "libnss3", "libnotify4", "xdg-utils"]) {
      expect(deb, dependency).toContain(dependency);
    }
    // The 24.04 t64 rename: the alternative keeps older releases installable.
    expect(deb).toContain("libasound2t64 | libasound2");
  });

  it("names the Linux artefacts so the updater feed can tell them apart", () => {
    // AppImage and deb are both built, both write into `latest-linux.yml`, and
    // neither extension is unique enough to imply the other: the updater resolves
    // a download by the name in that file, so the two must not collide.
    const appImage = block("appImage");
    const deb = block("deb");
    expect(appImage).toMatch(/\n\s+artifactName:\s*"Pi-Desktop-\$\{version\}-linux-/);
    expect(deb).toMatch(/\n\s+artifactName:\s*"Pi-Desktop-\$\{version\}-linux-/);
    const appImageName = /artifactName:\s*"([^"]+)"/.exec(appImage)?.[1];
    const debName = /artifactName:\s*"([^"]+)"/.exec(deb)?.[1];
    expect(appImageName, "appImage artifactName").toBeTruthy();
    expect(debName, "deb artifactName").toBeTruthy();
    expect(appImageName).not.toBe(debName);
    for (const name of [appImageName ?? "", debName ?? ""]) {
      expect(name).toContain("${version}");
      expect(name).toContain("${arch}");
      expect(name).toContain("${ext}");
    }
  });

  it("keeps the package entry, dependency and scripts the updater relies on", () => {
    expect(packageJson.main).toBe("out/main/index.mjs");
    expect(packageJson.dependencies["electron-updater"]).toBeTruthy();
    for (const script of ["package:win", "package:mac", "package:linux"]) {
      expect(packageJson.scripts[script], script).toBeTruthy();
      // A package script builds and verifies the bundled runtime before
      // electron-builder runs, so an installer can never ship without one.
      expect(packageJson.scripts[script], script).toContain("runtime:fetch");
      expect(packageJson.scripts[script], script).toContain("electron-builder");
    }
    expect(packageJson.scripts["package:win"]).toContain("runtime:verify");
  });

  it("has pinned runtime artifacts for every platform the builder targets", () => {
    const artifacts = Object.keys(lock.node.artifacts);
    for (const target of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) {
      expect(artifacts, target).toContain(target);
    }
    expect(lock.node.version).toMatch(/^24\./);
  });

  it("pins the npm payload digest used to verify a foreign-platform runtime", () => {
    // A runtime for another platform can never be executed on this host, so the
    // install step verifies it against this digest instead — without it,
    // `--all` (and therefore a Linux build from Windows) fails outright.
    for (const platform of ["win32", "linux", "darwin"]) {
      const entry = lock.node.npmPayload?.[platform];
      expect(entry, platform).toBeTruthy();
      expect(entry?.sha256, platform).toMatch(/^[0-9a-f]{64}$/);
      expect(entry?.path, platform).toBeTruthy();
    }
    // Windows ships the same npm with CRLF, so the digest must be computed over
    // line-ending-normalised content or the platforms would disagree.
    expect(
      new Set(Object.values(lock.node.npmPayload ?? {}).map((entry) => entry.sha256)).size,
    ).toBe(1);
  });
});
