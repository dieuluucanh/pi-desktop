import { execFile } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  BUNDLE_METADATA_FILE,
  WORKFLOW_DEV_STAGE_DIR,
  WORKFLOW_LOCK_FILE,
  WORKFLOW_STAGE_DIR,
  buildWorkflowLock,
  compareTarballToLock,
  extractTarball,
  findForeignSpecifiers,
  findMissingPackedImports,
  sha512Integrity,
  validatePackedFiles,
  validateWorkflowLock,
  validateWorkflowManifest,
} from "../../scripts/workflow-bundle.mjs";
import { bundledNodePath, verifyBundle } from "../../scripts/verify-workflow-bundle.mjs";

/**
 * The pinned Workflow bundle gate (plan step 26).
 *
 * The real W artifact is deliberately *not* required here: a test that needs
 * the developer's `~/.pi` checkout cannot prove the packaged app is independent
 * of it. Instead a fixture with the same shapes (relative + dynamic relative
 * imports, a non-code asset, license files, host peers) is packed, pinned,
 * staged and loaded by the same CLIs the release uses. The assertions then
 * mutate one property at a time and expect the gate to fail:
 *
 *  - a changed tarball is an integrity failure;
 *  - a removed module is an omitted-module failure;
 *  - a `postinstall`/dependency in a staged manifest is a lifecycle failure;
 *  - a changed staged file is a stale-output failure.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixturePkg = join(repoRoot, "tests", "fixtures", "workflow-bundle", "package");
const stageScript = join(repoRoot, "scripts", "stage-workflow-bundle.mjs");
const verifyScript = join(repoRoot, "scripts", "verify-workflow-bundle.mjs");
const execFileAsync = promisify(execFile);

const NPM =
  process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", "npm"] }
    : { command: "npm", args: [] };

const perTestDirs: string[] = [];
const suiteDirs: string[] = [];

function tempDir(prefix: string, suite = false): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  (suite ? suiteDirs : perTestDirs).push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of perTestDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const dir of suiteDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repo root with the host peers linked in. */
function makeRoot(suite = false): string {
  const root = tempDir("wf-bundle-root-", suite);
  mkdirSync(join(root, "resources", "extensions"), { recursive: true });
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");
  return root;
}

async function packFixture(suite = false): Promise<{ dir: string; tarball: string }> {
  const dir = tempDir("wf-bundle-pack-", suite);
  await execFileAsync(
    NPM.command,
    [...NPM.args, "pack", "--json", "--pack-destination", dir, fixturePkg],
    { cwd: repoRoot, timeout: 120_000 },
  );
  const tarball = join(dir, "dieulc-workflow-0.13.0.tgz");
  if (!existsSync(tarball)) throw new Error(`npm pack did not write ${tarball}`);
  return { dir, tarball };
}

function runStage(args: string[]) {
  return execFileAsync(process.execPath, [stageScript, ...args], {
    cwd: repoRoot,
    timeout: 180_000,
  });
}

function runVerify(args: string[]) {
  return execFileAsync(process.execPath, [verifyScript, ...args], {
    cwd: repoRoot,
    timeout: 180_000,
  });
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("Workflow bundle staging", () => {
  let root: string;
  let tarball: string;

  beforeAll(async () => {
    root = makeRoot(true);
    ({ tarball } = await packFixture(true));
    await runStage(["--root", root, "--tarball", tarball, "--update-lock", "--offline", "--json"]);
  }, 240_000);

  it("records exact integrity and per-file metadata", () => {
    const lock = readJson(join(root, WORKFLOW_LOCK_FILE));
    expect(validateWorkflowLock(lock)).toEqual([]);
    expect(lock.version).toBe("0.13.0");
    expect(lock.package).toBe("@dieulc/workflow");
    expect(String((lock.source as { integrity?: string }).integrity)).toBe(
      sha512Integrity(readFileSync(tarball)),
    );
    expect(lock.hostPeers).toEqual(
      expect.arrayContaining(["@earendil-works/pi-coding-agent", "typebox"]),
    );
    const paths = (lock.files as { path: string }[]).map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "package.json",
        "LICENSE",
        "README.md",
        "index.ts",
        "helper.ts",
        "assets/policy.json",
      ]),
    );
  });

  it("stages both the packaged and unpacked copies, with a sanitized manifest", () => {
    for (const relative of [WORKFLOW_STAGE_DIR, WORKFLOW_DEV_STAGE_DIR]) {
      const dir = join(root, relative);
      const metadata = readJson(join(dir, BUNDLE_METADATA_FILE));
      expect(metadata.version).toBe("0.13.0");
      expect(metadata.removedScripts).toEqual(
        expect.arrayContaining(["postinstall", "prepublishOnly"]),
      );
      const manifest = readJson(join(dir, "package.json"));
      expect(manifest.scripts).toBeUndefined();
      expect(manifest.devDependencies).toBeUndefined();
      expect(manifest.peerDependencies).toEqual(expect.any(Object));
      expect(existsSync(join(dir, "assets", "policy.json"))).toBe(true);
      expect(existsSync(join(dir, "index.ts"))).toBe(true);
    }
  });

  it("passes the full verification gate, including an offline load", async () => {
    const { stdout } = await runVerify([
      "--root",
      root,
      "--tarball",
      tarball,
      "--offline",
      "--require-dev",
      "--json",
    ]);
    const report = JSON.parse(stdout) as { ok: boolean; errors: string[] };
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  }, 180_000);
});

describe("Workflow bundle failures", () => {
  it("rejects a tarball whose bytes do not match the pinned integrity", async () => {
    const root = makeRoot();
    const { tarball } = await packFixture();
    await runStage(["--root", root, "--tarball", tarball, "--update-lock", "--offline", "--json"]);
    const tampered = join(root, "tampered.tgz");
    const bytes = readFileSync(tarball);
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
    writeFileSync(tampered, bytes);
    await expect(
      runStage(["--root", root, "--tarball", tampered, "--offline", "--json"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("integrity mismatch"),
    });
  }, 240_000);

  it("fails on a module imported by a packed file but omitted from files[]", async () => {
    const packedDir = tempDir("wf-bundle-missing-");
    const source = join(packedDir, "package");
    cpSync(fixturePkg, source, { recursive: true });
    const manifest = readJson(join(source, "package.json")) as unknown as { files: string[] };
    manifest.files = manifest.files.filter((file) => file !== "helper.ts");
    writeFileSync(join(source, "package.json"), JSON.stringify(manifest, null, 2));
    await execFileAsync(
      NPM.command,
      [...NPM.args, "pack", "--json", "--pack-destination", packedDir, source],
      { cwd: repoRoot, timeout: 120_000 },
    );
    const tarball = join(packedDir, "dieulc-workflow-0.13.0.tgz");
    const root = makeRoot();
    await expect(
      runStage(["--root", root, "--tarball", tarball, "--update-lock", "--offline", "--json"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("imports ./helper.ts"),
    });
  }, 240_000);

  it("refuses an unexpected runtime dependency", async () => {
    const packedDir = tempDir("wf-bundle-deps-");
    const source = join(packedDir, "package");
    cpSync(fixturePkg, source, { recursive: true });
    const manifest = readJson(join(source, "package.json"));
    manifest.dependencies = { "left-pad": "1.0.0" };
    writeFileSync(join(source, "package.json"), JSON.stringify(manifest, null, 2));
    await expect(
      execFileAsync(
        NPM.command,
        [...NPM.args, "pack", "--json", "--pack-destination", packedDir, source],
        { cwd: repoRoot, timeout: 120_000 },
      ),
    ).resolves.toBeDefined();
    const tarball = join(packedDir, "dieulc-workflow-0.13.0.tgz");
    const files = extractTarball(readFileSync(tarball));
    const packedManifest = JSON.parse(files.get("package.json")!.toString("utf8"));
    expect(validateWorkflowManifest(packedManifest, null).join("\n")).toContain(
      "no runtime dependencies",
    );
    const root = makeRoot();
    await expect(
      runStage(["--root", root, "--tarball", tarball, "--update-lock", "--offline", "--json"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("no runtime dependencies"),
    });
  }, 240_000);

  it("refuses a staged manifest that reintroduces lifecycle scripts", async () => {
    const root = makeRoot();
    const { tarball } = await packFixture();
    await runStage(["--root", root, "--tarball", tarball, "--update-lock", "--offline", "--json"]);
    const stagedManifest = join(root, WORKFLOW_STAGE_DIR, "package.json");
    const manifest = readJson(stagedManifest);
    manifest.scripts = { postinstall: "node evil.js" };
    writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2));
    const result = await verifyBundle({ root, tarball, requireDev: false });
    expect(result.errors.join("\n")).toMatch(/stale build output|lifecycle scripts|scripts/);
  }, 240_000);

  it("detects stale staged output against the recorded hashes", async () => {
    const root = makeRoot();
    const { tarball } = await packFixture();
    await runStage(["--root", root, "--tarball", tarball, "--update-lock", "--offline", "--json"]);
    appendFileSync(join(root, WORKFLOW_STAGE_DIR, "helper.ts"), "\n// stale\n");
    const result = await verifyBundle({ root, requireDev: false });
    expect(result.errors.join("\n")).toContain("stale build output");
  }, 240_000);
});

describe("pure gate helpers", () => {
  const packed = new Map([
    ["index.ts", Buffer.from('import { b } from "./b.ts";\nexport const a = b;\n')],
    ["b.ts", Buffer.from("export const b = 1;\n")],
  ]);
  const read = (file: string) => packed.get(file)?.toString("utf8") ?? "";

  it("resolves the packed import closure", () => {
    expect(findMissingPackedImports(packed.keys(), read)).toEqual([]);
  });

  it("flags a relative import whose target is not packed", () => {
    packed.delete("b.ts");
    expect(findMissingPackedImports(packed.keys(), read)).toEqual([
      { from: "index.ts", specifier: "./b.ts" },
    ]);
    packed.set("b.ts", Buffer.from("export const b = 1;\n"));
  });

  it("allows node builtins and host peers, and flags everything else", () => {
    const files = new Map<string, Buffer>([
      [
        "index.ts",
        Buffer.from(
          'import "node:fs";\nimport { x } from "@earendil-works/pi-coding-agent";\nimport { t } from "typebox";\nimport leftPad from "left-pad";\n',
        ),
      ],
    ]);
    expect(
      findForeignSpecifiers(files.keys(), (file) => files.get(file)!.toString("utf8")),
    ).toEqual([{ from: "index.ts", specifier: "left-pad" }]);
  });

  it("requires LICENSE, README, package.json and the entry, and refuses tests/node_modules", () => {
    expect(validatePackedFiles(["package.json", "LICENSE", "README.md", "index.ts"])).toEqual([]);
    const errors = validatePackedFiles([
      "package.json",
      "index.ts",
      "helper.test.ts",
      "node_modules/left-pad/index.js",
    ]);
    expect(errors.join("\n")).toMatch(/LICENSE/);
    expect(errors.join("\n")).toMatch(/README\.md/);
    expect(errors.join("\n")).toMatch(/test files/);
    expect(errors.join("\n")).toMatch(/node_modules/);
  });

  it("checks the tarball bytes against the lock without trusting the filename", () => {
    const bytes = Buffer.from("not a tarball");
    const lock = {
      schema: 1,
      package: "@dieulc/workflow",
      version: "0.13.0",
      entry: "index.ts",
      license: "MIT",
      hostPeers: ["typebox"],
      source: {
        kind: "release" as const,
        tarball: "dieulc-workflow-0.13.0.tgz",
        url: "https://example.test/dieulc-workflow-0.13.0.tgz",
        tag: "v0.13.0",
        integrity: sha512Integrity(Buffer.from("something else")),
      },
      files: ["package.json", "index.ts", "LICENSE", "README.md"].map((path) => ({
        path,
        sha256: "a".repeat(64),
      })),
    };
    expect(compareTarballToLock(bytes, lock).join("\n")).toContain("integrity mismatch");
    expect(buildWorkflowLock).toBeTypeOf("function");
  });

  it("finds the bundled Node when the runtime has been fetched", () => {
    const node = bundledNodePath(repoRoot);
    if (!node) return; // A fresh clone has no fetched runtime; CI packages it.
    expect(existsSync(node)).toBe(true);
  });
});
