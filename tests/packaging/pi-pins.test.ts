import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PI_AGENT_FAMILY,
  PI_AGENT_PACKAGE,
  TYPEBOX_PACKAGE,
  isExactVersion,
  satisfiesFloor,
} from "../../scripts/pi-agent-package.mjs";

/**
 * The Pi agent pin invariant (2026-11-15 update-channels plan, step 13).
 *
 * "The four pins must match" was prose in `docs/architecture/versions.md` and
 * nothing enforced it. This suite is what makes an automated bump safe: the app,
 * the lockfile, the SDK's own manifest, the versions document and the bundled
 * Node have to agree, or the bump PR fails before review.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

interface Manifest {
  dependencies?: Record<string, string>;
  engines?: { node?: string };
}

interface LockFile {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
}

const app = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as Manifest;
const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as LockFile;
const sdk = JSON.parse(
  readFileSync(join(repoRoot, "node_modules", PI_AGENT_PACKAGE, "package.json"), "utf8"),
) as Manifest;
const nodeLock = JSON.parse(
  readFileSync(join(repoRoot, "resources", "runtime", "node.lock.json"), "utf8"),
) as { node: { version: string } };
const versionsDoc = readFileSync(join(repoRoot, "docs", "architecture", "versions.md"), "utf8");

const appVersion = app.dependencies?.[PI_AGENT_PACKAGE];
const appTypebox = app.dependencies?.[TYPEBOX_PACKAGE];

describe("Pi agent pins", () => {
  it("pins the SDK family exactly and in lockstep", () => {
    expect(appVersion).toBeTruthy();
    expect(isExactVersion(appVersion)).toBe(true);
    for (const name of PI_AGENT_FAMILY) {
      expect(app.dependencies?.[name], `${name} must match the SDK`).toBe(appVersion);
    }
  });

  it("resolves the same versions in the lockfile", () => {
    const root = lock.packages?.[""];
    expect(root?.dependencies).toBeTruthy();
    for (const name of PI_AGENT_FAMILY) {
      expect(root?.dependencies?.[name], `root ${name}`).toBe(appVersion);
      expect(lock.packages?.[`node_modules/${name}`]?.version, `lock ${name}`).toBe(appVersion);
    }
    expect(lock.packages?.[`node_modules/${TYPEBOX_PACKAGE}`]?.version).toBe(appTypebox);
  });

  it("matches the SDK's own manifest, including the packages the app does not pin", () => {
    const sdkFamily = Object.entries(sdk.dependencies ?? {}).filter(([name]) =>
      name.startsWith("@earendil-works/"),
    );
    // pi-agent-core, pi-ai, pi-codemode, pi-mcp, pi-tui.
    expect(sdkFamily.length).toBeGreaterThanOrEqual(5);
    for (const [name, range] of sdkFamily) {
      expect(isExactVersion(range), `${name} must be exact in the SDK`).toBe(true);
      expect(range, `${name} must move with the SDK`).toBe(appVersion);
    }
    expect(sdk.dependencies?.[TYPEBOX_PACKAGE]).toBe(appTypebox);
    // The two transitive family packages are pinned by the SDK, not by the app.
    expect(sdk.dependencies).toHaveProperty("@earendil-works/pi-codemode");
    expect(sdk.dependencies).toHaveProperty("@earendil-works/pi-mcp");
  });

  it("names the pins in the versions document", () => {
    const rows = versionsDoc.split("\n").filter((line) => line.startsWith("|"));
    const sdkRow = rows.find((line) => line.startsWith(`| \`${PI_AGENT_PACKAGE}\``));
    const familyRow = rows.find((line) => line.startsWith("| `@earendil-works/pi-agent-core`"));
    const typeboxRow = rows.find((line) => line.startsWith(`| \`${TYPEBOX_PACKAGE}\``));

    expect(sdkRow, "the SDK row exists").toBeTruthy();
    expect(familyRow, "the family row exists").toBeTruthy();
    expect(typeboxRow, "the typebox row exists").toBeTruthy();
    expect(sdkRow).toContain(`\`${appVersion}\``);
    expect(familyRow).toContain(`\`${appVersion}\``);
    expect(typeboxRow).toContain(`\`${appTypebox}\``);
  });

  it("bundles a Node that satisfies the SDK's engine range", () => {
    const range = sdk.engines?.node;
    expect(range, "the SDK declares engines.node").toBeTruthy();
    expect(range).not.toBe("");
    expect(satisfiesFloor(nodeLock.node.version, range)).toBe(true);
  });
});
