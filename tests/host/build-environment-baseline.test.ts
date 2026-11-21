import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  EMPTY_EXTENSION_UI,
  type ExtensionUiSnapshot,
} from "../../src/shared/extension-ui";
import { HOST_METHODS } from "../../src/shared/host-protocol";
import {
  checkpointExtensionLoaderOptions,
  safeModeResourceLoaderOptions,
} from "../../src/host/safe-mode";

/**
 * Build-environment baseline (2026-11-21 orchestrator plan, step 1).
 *
 * The orchestrator reaches Desktop in two phases: first a generic extension
 * host (steps 7-13), then a child-session adapter (step 26). Both depend on
 * facts that are easy to change by accident:
 *
 *   - which resource-loader options define an ordinary (non-safe-mode) Build,
 *   - which host methods the extension UI/commands/shortcuts already use,
 *   - the shape of the extension-UI snapshot,
 *   - the SDK this app builds against.
 *
 * The fixture is the record. A deliberate change updates it; drift fails here.
 */

interface Baseline {
  version: number;
  sdk: { package: string; version: string };
  safeModeLoaderOptions: Record<string, boolean>;
  checkpointLoader: {
    safeModeOn: Record<string, boolean>;
    safeModeOffWithPath: { additionalExtensionPaths: string[] };
    safeModeOffWithoutPath: Record<string, never>;
  };
  extensionUiSnapshotKeys: string[];
  requiredHostMethods: string[];
}

const FIXTURE = join(__dirname, "fixtures", "build-environment-baseline.json");

function readBaseline(): Baseline {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as Baseline;
}

function sdkVersion(): string {
  const packageJson = join(
    __dirname,
    "../../node_modules/@earendil-works/pi-coding-agent/package.json",
  );
  return (JSON.parse(readFileSync(packageJson, "utf8")) as { version: string }).version;
}

describe("build environment baseline", () => {
  it("pins the SDK the host compiles against", () => {
    const baseline = readBaseline();
    expect(baseline.version).toBe(1);
    expect(baseline.sdk.package).toBe("@earendil-works/pi-coding-agent");
    expect(sdkVersion()).toBe(baseline.sdk.version);
  });

  it("pins the safe-mode resource loader", () => {
    const baseline = readBaseline();
    expect(safeModeResourceLoaderOptions(true)).toEqual(baseline.safeModeLoaderOptions);
    expect(safeModeResourceLoaderOptions(false)).toBeUndefined();
    expect(safeModeResourceLoaderOptions(undefined)).toBeUndefined();
  });

  it("pins the checkpoint loader in ordinary and safe modes", () => {
    const baseline = readBaseline();
    const path = "<checkpoint-extension>";

    // Safe mode wins over an explicit path: `noExtensions` does not gate
    // `additionalExtensionPaths`, so the loader options must be exclusive.
    expect(checkpointExtensionLoaderOptions({ safeMode: true, extensionPath: path })).toEqual(
      baseline.checkpointLoader.safeModeOn,
    );

    expect(checkpointExtensionLoaderOptions({ safeMode: false, extensionPath: path })).toEqual({
      additionalExtensionPaths: [path],
    });

    expect(checkpointExtensionLoaderOptions({ safeMode: false, extensionPath: null })).toEqual(
      baseline.checkpointLoader.safeModeOffWithoutPath,
    );
  });

  it("pins the extension-UI snapshot shape the renderer consumes", () => {
    const baseline = readBaseline();
    const snapshot: ExtensionUiSnapshot = EMPTY_EXTENSION_UI;
    expect(Object.keys(snapshot).sort()).toEqual(baseline.extensionUiSnapshotKeys);
  });

  it("pins the host methods extensions already rely on", () => {
    const baseline = readBaseline();
    const methods = new Set<string>(HOST_METHODS as readonly string[]);
    for (const method of baseline.requiredHostMethods) {
      expect(methods.has(method), `missing host method ${method}`).toBe(true);
    }
  });

  it("keeps the host protocol free of Workflow/review-specific methods", () => {
    // The whole point of the desktop migration is that a third-party extension
    // is served by generic methods. A method named after one extension would be
    // the hardcoding this plan removes, so the baseline forbids the pattern.
    const suspicious = (HOST_METHODS as readonly string[]).filter((method) =>
      /workflow|orchestrator|plannotator|review|todos?/i.test(method),
    );
    expect(suspicious).toEqual([]);
  });
});
