import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkExitCode, parseArgs } from "../../scripts/pi-agent.mjs";

/**
 * `scripts/pi-agent.mjs` (2026-11-15 update-channels plan, step 10).
 *
 * Every case runs in a throwaway project root with a registry fixture, so the
 * suite never touches the real tree or the network. The CLI is the thing the
 * scheduled workflow and the release preflight both call, so its exit codes are
 * the contract: 0 fine, 1 behind (actionable), 2 registry unknown.
 */

const SCRIPT = fileURLToPath(new URL("../../scripts/pi-agent.mjs", import.meta.url));
const SDK = "@earendil-works/pi-coding-agent";
const FAMILY = [
  SDK,
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function versionsDoc(version: string, typebox: string): string {
  return [
    "| Component | Pin | Why |",
    "| --------- | --- | --- |",
    `| \`${SDK}\`                  | \`${version}\` (exact)      | the SDK |`,
    "| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` | `" +
      version +
      "` (exact)      | family  |",
    `| \`typebox\`                                          | \`${typebox}\` (exact)     | types   |`,
    "| `electron`                                         | `44.4.3`             | chrome  |",
    "",
  ].join("\n");
}

interface FixtureOptions {
  appVersion?: string;
  typebox?: string;
  nodeVersion?: string | null;
  registry: Record<string, unknown>;
}

function fixture(options: FixtureOptions): { root: string; registry: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-agent-cli-"));
  roots.push(root);
  const appVersion = options.appVersion ?? "1.5.0";
  const typebox = options.typebox ?? "1.3.27";
  const dependencies: Record<string, string> = { react: "19.3.0", typebox };
  for (const name of FAMILY) dependencies[name] = appVersion;
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", dependencies }, null, 2)}\n`,
    "utf8",
  );
  mkdirSync(join(root, "docs", "architecture"), { recursive: true });
  writeFileSync(
    join(root, "docs", "architecture", "versions.md"),
    versionsDoc(appVersion, typebox),
    "utf8",
  );
  if (options.nodeVersion !== null) {
    mkdirSync(join(root, "resources", "runtime"), { recursive: true });
    writeFileSync(
      join(root, "resources", "runtime", "node.lock.json"),
      `${JSON.stringify({ node: { version: options.nodeVersion ?? "24.22.2" } }, null, 2)}\n`,
      "utf8",
    );
  }
  const registry = join(root, "registry.json");
  writeFileSync(registry, `${JSON.stringify(options.registry, null, 2)}\n`, "utf8");
  return { root, registry };
}

function registryFor(latest: string, typebox = "1.3.30", node = ">=22.19.0") {
  return {
    latest,
    engines: { node },
    dependencies: {
      "@earendil-works/pi-agent-core": latest,
      "@earendil-works/pi-ai": latest,
      "@earendil-works/pi-tui": latest,
      typebox,
    },
  };
}

function run(root: string, registry: string, args: string[] = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args, "--root", root, "--registry", registry], {
    cwd: root,
    encoding: "utf8",
  });
}

function git(root: string, args: string[]) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

describe("argument parsing", () => {
  it("defaults to status and refuses an unknown flag", () => {
    expect(parseArgs([]).command).toBe("status");
    expect(parseArgs(["--check", "--major"]).command).toBe("check");
    expect(parseArgs(["--update", "--no-install"]).install).toBe(false);
    expect(() => parseArgs(["--wat"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--root"])).toThrow(/needs a value/);
  });

  it("maps a report to the documented exit codes", () => {
    const report = (status: string) => ({ status });
    expect(checkExitCode(report("in-sync"), { major: false })).toBe(0);
    expect(checkExitCode(report("local-ahead"), { major: false })).toBe(0);
    expect(checkExitCode(report("behind"), { major: false })).toBe(1);
    expect(checkExitCode(report("major-behind"), { major: false })).toBe(0);
    expect(checkExitCode(report("major-behind"), { major: true })).toBe(1);
    expect(checkExitCode(report("registry-error"), { major: false })).toBe(2);
  });
});

describe("--status / --check", () => {
  it("reports the pinned and latest versions as JSON", () => {
    const { root, registry } = fixture({ registry: registryFor("1.6.0") });
    const result = run(root, registry, ["--status", "--json"]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      current: "1.5.0",
      latest: "1.6.0",
      status: "behind",
      typebox: { current: "1.3.27", latest: "1.3.30" },
      bundledNode: "24.22.2",
      enginesOk: true,
    });
  });

  it("exits 1 when behind", () => {
    const { root, registry } = fixture({ registry: registryFor("1.6.0") });
    expect(run(root, registry, ["--check"]).status).toBe(1);
  });

  it("exits 0 when in sync", () => {
    const { root, registry } = fixture({
      registry: registryFor("1.5.0", "1.3.27"),
    });
    expect(run(root, registry, ["--check"]).status).toBe(0);
  });

  it("exits 2 when the registry answer is unusable", () => {
    const { root, registry } = fixture({ registry: { latest: "not-a-version" } });
    expect(run(root, registry, ["--check"]).status).toBe(2);
  });

  it("treats a major bump as informational unless --major is asked", () => {
    const { root, registry } = fixture({ registry: registryFor("2.0.0") });
    expect(run(root, registry, ["--check"]).status).toBe(0);

    const strict = run(root, registry, ["--check", "--major"]);
    expect(strict.status).toBe(1);
    expect(JSON.parse(run(root, registry, ["--status", "--json"]).stdout)).toMatchObject({
      status: "major-behind",
    });
  });
});

describe("--update", () => {
  it("writes nothing on a dry run", () => {
    const { root, registry } = fixture({ registry: registryFor("1.6.0") });
    const before = readFileSync(join(root, "package.json"), "utf8");
    const docBefore = readFileSync(join(root, "docs", "architecture", "versions.md"), "utf8");

    const result = run(root, registry, ["--update", "--dry-run"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/1\.5\.0 -> 1\.6\.0/);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(readFileSync(join(root, "docs", "architecture", "versions.md"), "utf8")).toBe(docBefore);
  });

  it("bumps the family, typebox and the versions document", () => {
    const { root, registry } = fixture({ registry: registryFor("1.6.0") });
    const result = run(root, registry, ["--update", "--no-install"]);

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies[SDK]).toBe("1.6.0");
    expect(manifest.dependencies["@earendil-works/pi-tui"]).toBe("1.6.0");
    expect(manifest.dependencies.typebox).toBe("1.3.30");
    expect(manifest.dependencies.react).toBe("19.3.0");

    const doc = readFileSync(join(root, "docs", "architecture", "versions.md"), "utf8");
    expect(doc).toContain("`1.6.0` (exact)");
    expect(doc).toContain("`1.3.30` (exact)");
    // And the result now passes the gate it was bumped for.
    expect(run(root, registry, ["--check"]).status).toBe(0);
  });

  it("refuses a major bump without --major and takes it with it", () => {
    const { root, registry } = fixture({ registry: registryFor("2.0.0") });
    const refused = run(root, registry, ["--update", "--no-install"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/--major/);

    const accepted = run(root, registry, ["--update", "--major", "--no-install"]);
    expect(accepted.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies[SDK]).toBe("2.0.0");
  });

  it("refuses a family that does not move together", () => {
    const { root, registry } = fixture({
      registry: {
        latest: "1.6.0",
        engines: { node: ">=22.19.0" },
        dependencies: {
          "@earendil-works/pi-agent-core": "1.6.0",
          "@earendil-works/pi-ai": "1.5.0",
          "@earendil-works/pi-tui": "1.6.0",
          typebox: "1.3.30",
        },
      },
    });
    const result = run(root, registry, ["--update", "--no-install"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/move together/);
    // Nothing was written.
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies[SDK]).toBe("1.5.0");
  });

  it("refuses a target the bundled Node cannot run", () => {
    const { root, registry } = fixture({
      nodeVersion: "22.0.0",
      registry: registryFor("1.6.0"),
    });
    const result = run(root, registry, ["--update", "--no-install"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/needs Node/);
  });

  it("refuses a dirty git tree unless forced", () => {
    const { root, registry } = fixture({ registry: registryFor("1.6.0") });
    const init = git(root, ["init"]);
    if (init.status !== 0) return; // git is not installed on this machine
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    ]);
    writeFileSync(join(root, "scratch.txt"), "dirty\n", "utf8");

    const refused = run(root, registry, ["--update", "--no-install"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/uncommitted changes/);

    const forced = run(root, registry, ["--update", "--no-install", "--force"]);
    expect(forced.status).toBe(0);
  });

  it("says so when there is nothing to do", () => {
    const { root, registry } = fixture({ registry: registryFor("1.5.0", "1.3.27") });
    const result = run(root, registry, ["--update", "--no-install"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/already the latest/);
  });
});
