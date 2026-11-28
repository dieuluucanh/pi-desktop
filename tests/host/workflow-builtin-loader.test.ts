import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import { buildResourcesSnapshot } from "../../src/host/resources";
import { SAFE_MODE_RESOURCE_LOADER_OPTIONS } from "../../src/host/safe-mode";
import { workflowBuiltinLoaderOptions } from "../../src/host/sdk/workflow-builtin";
import {
  WORKFLOW_BUILTIN_PATH,
  resolveWorkflowBuiltin,
  type WorkflowBuiltinResolution,
} from "../../src/host/workflow-builtin";
import { WORKFLOW_BUNDLE_METADATA } from "../../src/shared/workflow-bundle";

/**
 * `builtin:workflow` through Pi's **real** resource loader (plan step 27).
 *
 * Everything above this file tests the decision or the shape; this suite runs
 * `DefaultResourceLoader` itself so the user-facing promises are proven against
 * the SDK that will load the app:
 *
 *  - a fresh profile loads the staged artifact as `builtin:workflow`;
 *  - `-builtin:workflow` is a real opt-out (no load, no error);
 *  - an installed profile copy replaces the builtin instead of both loading;
 *  - safe mode loads neither;
 *  - the Extensions hub describes the same copy the loader reports;
 *  - the bundled checkpoint extension coexists.
 *
 * The staged artifact used here is the real one when it is present; the
 * replacement/opt-out cases use a tiny fixture extension so a test never
 * depends on `@dieulc/workflow`'s command surface.
 */

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Workspace {
  root: string;
  agentDir: string;
  cwd: string;
  bundleDir: string;
}

function workspace(): Workspace {
  const root = mkdtempSync(join(tmpdir(), "wf-builtin-loader-"));
  temporary.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bundleDir = join(root, "bundle");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, WORKFLOW_BUNDLE_METADATA),
    JSON.stringify({
      schema: 1,
      package: "@dieulc/workflow",
      version: "0.13.0",
      entry: "index.ts",
      license: "MIT",
      integrity: "sha512-abc=",
      hostPeers: ["@earendil-works/pi-coding-agent", "typebox"],
      files: [{ path: "index.ts", sha256: "a".repeat(64) }],
    }),
  );
  writeFileSync(join(bundleDir, "index.ts"), "export default function workflow() {}\n");
  return { root, agentDir, cwd, bundleDir };
}

function resolution(space: Workspace): WorkflowBuiltinResolution {
  return resolveWorkflowBuiltin({
    bundleDir: space.bundleDir,
    exists: existsSync,
    readFile: (target) => readFileSync(target, "utf8"),
  });
}

/** A staged-artifact stand-in that registers the command Workflow owns. */
const fakeArtifact = async () => ({
  default: (pi: {
    registerCommand(name: string, options: { description?: string; handler(): void }): void;
  }) => {
    pi.registerCommand("workflow", { description: "Workflow modes", handler: () => undefined });
  },
});

/** A profile copy an older Workflow install could have left behind. */
function installProfileExtension(space: Workspace, name = "workflow"): string {
  const dir = join(space.agentDir, "extensions", name);
  mkdirSync(dir, { recursive: true });
  const entry = join(dir, "index.ts");
  writeFileSync(
    entry,
    [
      "export default function installedWorkflow(pi) {",
      '  pi.registerCommand("workflow", { description: "installed copy", handler: () => {} });',
      "}",
      "",
    ].join("\n"),
  );
  return entry;
}

/** Writes global settings the way a user would (never through the app). */
function writeGlobalSettings(space: Workspace, settings: Record<string, unknown>): void {
  writeFileSync(join(space.agentDir, "settings.json"), JSON.stringify(settings));
}

async function loadExtensions(
  space: Workspace,
  options: {
    resolution?: WorkflowBuiltinResolution | null;
    settings?: Record<string, unknown>;
    safeMode?: boolean;
    additionalExtensionPaths?: string[];
    /** How the loader answers the project-trust question (default: trusted). */
    projectTrusted?: boolean;
    /** `null` = use the real staged artifact import; absent = the fixture. */
    load?: typeof fakeArtifact | null;
  } = {},
): Promise<DefaultResourceLoader> {
  if (options.settings) writeGlobalSettings(space, options.settings);
  const settingsManager = SettingsManager.create(space.cwd, space.agentDir);
  const loader = new DefaultResourceLoader({
    cwd: space.cwd,
    agentDir: space.agentDir,
    settingsManager,
    ...(options.safeMode ? SAFE_MODE_RESOURCE_LOADER_OPTIONS : {}),
    ...workflowBuiltinLoaderOptions(
      options.resolution ?? null,
      options.load === null ? undefined : (options.load ?? fakeArtifact),
    ),
    ...(options.additionalExtensionPaths
      ? { additionalExtensionPaths: options.additionalExtensionPaths }
      : {}),
  });
  await loader.reload({ resolveProjectTrust: async () => options.projectTrusted ?? true });
  return loader;
}

/** Writes project settings the way a checkout would carry them. */
function writeProjectSettings(space: Workspace, settings: Record<string, unknown>): void {
  const dir = join(space.cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
}

function loadedPaths(loader: DefaultResourceLoader): string[] {
  return (loader.getExtensions().extensions ?? []).map((extension) => extension.path);
}

describe("builtin:workflow through the real loader", () => {
  it("loads the staged artifact on a fresh profile and registers its commands", async () => {
    const space = workspace();
    const builtin = resolution(space);
    const loader = await loadExtensions(space, { resolution: builtin });

    const extensions = loader.getExtensions().extensions ?? [];
    const entry = extensions.find((extension) => extension.path === WORKFLOW_BUILTIN_PATH);
    expect(entry).toBeDefined();
    // Pi gives a builtin its synthetic path and hides it from the *startup* list.
    expect(entry?.hidden).toBe(true);
    expect(entry?.replaceable).toBe(true);
    expect(entry?.commands.has("workflow")).toBe(true);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().warnings).toEqual([]);
  });

  it("honours -builtin:workflow without loading it and without an error", async () => {
    const space = workspace();
    const loader = await loadExtensions(space, {
      resolution: resolution(space),
      settings: { extensions: ["-builtin:workflow"] },
    });

    expect(loadedPaths(loader)).not.toContain(WORKFLOW_BUILTIN_PATH);
    expect(loader.getExtensions().errors).toEqual([]);
    // The hub still shows the opt-out as a re-enableable row (not a phantom).
    const snapshot = buildResourcesSnapshot({
      cwd: space.cwd,
      scope: "control",
      settings: { global: { extensions: ["-builtin:workflow"] }, project: {} },
      source: { extensions: loader.getExtensions() },
      builtin: resolution(space),
    });
    expect(
      snapshot.resources.find((entry) => entry.overridePath === WORKFLOW_BUILTIN_PATH),
    ).toMatchObject({ enabled: false, name: "workflow", builtin: { version: "0.13.0" } });
  });

  it("lets an installed profile copy replace the builtin, with Pi explaining why", async () => {
    const space = workspace();
    const installed = installProfileExtension(space);
    const loader = await loadExtensions(space, { resolution: resolution(space) });

    const paths = loadedPaths(loader);
    expect(paths, "the replacing copy loads").toContain(installed);
    expect(paths, "the builtin stepped aside").not.toContain(WORKFLOW_BUILTIN_PATH);

    const warning = (loader.getExtensions().warnings ?? []).find(
      (entry) => entry.path === WORKFLOW_BUILTIN_PATH,
    );
    expect(warning?.warning).toMatch(/built-in extension `workflow` was not loaded/);
    expect(warning?.warning).toContain(installed);

    // And the hub surfaces that sentence instead of a silent absence.
    const snapshot = buildResourcesSnapshot({
      cwd: space.cwd,
      scope: "control",
      settings: { global: {}, project: {} },
      source: { extensions: loader.getExtensions() },
      builtin: resolution(space),
    });
    expect(snapshot.diagnostics.some((entry) => entry.message.match(/built-in extension/))).toBe(
      true,
    );
    expect(snapshot.resources.some((entry) => entry.overridePath === WORKFLOW_BUILTIN_PATH)).toBe(
      false,
    );
  });

  it("loads nothing at all in safe mode", async () => {
    const space = workspace();
    installProfileExtension(space);
    const loader = await loadExtensions(space, {
      resolution: resolveWorkflowBuiltin({ safeMode: true }),
      safeMode: true,
    });
    expect(loadedPaths(loader)).toEqual([]);
  });

  it("honours a project's opt-out only when the project is trusted", async () => {
    const space = workspace();
    writeProjectSettings(space, { extensions: ["-builtin:workflow"] });

    // Trusted: `.pi/settings.json` is real configuration, so the opt-out applies
    // exactly as it does in terminal Pi.
    const trusted = await loadExtensions(space, {
      resolution: resolution(space),
      projectTrusted: true,
    });
    expect(loadedPaths(trusted)).not.toContain(WORKFLOW_BUILTIN_PATH);

    // Untrusted: Pi ignores project settings entirely, so the builtin the app
    // ships still loads. The app must not read the file itself or invent a
    // second opt-out rule.
    const untrusted = await loadExtensions(space, {
      resolution: resolution(space),
      projectTrusted: false,
    });
    expect(loadedPaths(untrusted)).toContain(WORKFLOW_BUILTIN_PATH);
  });

  it("stays consistent across a reload (no duplicate builtin, no lost opt-out)", async () => {
    const space = workspace();
    const builtin = resolution(space);
    const loader = await loadExtensions(space, { resolution: builtin });
    expect(loadedPaths(loader).filter((path) => path === WORKFLOW_BUILTIN_PATH)).toHaveLength(1);

    await loader.reload({ resolveProjectTrust: async () => true });
    expect(loadedPaths(loader).filter((path) => path === WORKFLOW_BUILTIN_PATH)).toHaveLength(1);

    // A reload picks up a settings change the user made, without the app writing
    // anything: the opt-out takes effect on the next load.
    writeGlobalSettings(space, { extensions: ["-builtin:workflow"] });
    await loader.reload({ resolveProjectTrust: async () => true });
    expect(loadedPaths(loader)).not.toContain(WORKFLOW_BUILTIN_PATH);
  });

  it("coexists with the bundled checkpoint extension", async () => {
    const space = workspace();
    const checkpoints = join(space.root, "pi-checkpoints.ts");
    writeFileSync(
      checkpoints,
      [
        "export default function checkpoints(pi) {",
        '  pi.registerCommand("checkpoint", { description: "snapshot", handler: () => {} });',
        "}",
        "",
      ].join("\n"),
    );
    const loader = await loadExtensions(space, {
      resolution: resolution(space),
      additionalExtensionPaths: [checkpoints],
    });
    const paths = loadedPaths(loader);
    expect(paths).toContain(WORKFLOW_BUILTIN_PATH);
    expect(paths).toContain(checkpoints);
    const extensions = loader.getExtensions().extensions ?? [];
    expect(extensions.find((entry) => entry.path === checkpoints)?.commands.has("checkpoint")).toBe(
      true,
    );
  });

  it("loads the real staged artifact when this checkout has one", async () => {
    // The pinned artifact is what ships. Import through the same factory the app
    // uses (no injected loader): if this fails, packaging would ship a builtin
    // that cannot register.
    const staged = join(process.cwd(), "out", "extensions", "workflow");
    const space = workspace();
    const real = resolveWorkflowBuiltin({
      bundleDir: staged,
      exists: existsSync,
      readFile: (target) => readFileSync(target, "utf8"),
    });
    if (!real.registered) {
      // A checkout that never staged the bundle: nothing to prove beyond the
      // reported absence (the layout resolver owns that message).
      expect(real.disabledBy).toBe("missing-bundle");
      return;
    }
    const loader = await loadExtensions(space, { resolution: real, load: null });
    const entry = (loader.getExtensions().extensions ?? []).find(
      (extension) => extension.path === WORKFLOW_BUILTIN_PATH,
    );
    expect(loader.getExtensions().errors).toEqual([]);
    expect(entry).toBeDefined();
    // The real Workflow registers its commands (`/workflow`, `/prompt`, …).
    expect(entry?.commands.size).toBeGreaterThan(0);
  });
});

/**
 * Step 37: the opt-out / override / safe-mode paths must be re-run against the
 * **real staged artifact**, not only against the fixture extension above.
 * A fixture proves Pi's loader mechanics; only the real bundle proves that the
 * shipped Workflow registers once, opts out cleanly and never double-loads.
 */
describe("real staged artifact through opt-out / override / safe mode", () => {
  const staged = join(process.cwd(), "out", "extensions", "workflow");

  function realResolution(): WorkflowBuiltinResolution {
    return resolveWorkflowBuiltin({
      bundleDir: staged,
      exists: existsSync,
      readFile: (target) => readFileSync(target, "utf8"),
    });
  }

  /** Copy the real bundle into the profile, the way an npm install would. */
  function installRealCopy(space: Workspace): string {
    const target = join(space.agentDir, "extensions", "workflow");
    mkdirSync(join(space.agentDir, "extensions"), { recursive: true });
    cpSync(staged, target, { recursive: true });
    return join(target, "index.ts");
  }

  const hasRealArtifact = existsSync(join(staged, "index.ts"));

  it.skipIf(!hasRealArtifact)(
    "registers the shipped Workflow exactly once on a fresh profile",
    async () => {
      const space = workspace();
      const real = realResolution();
      expect(real.registered).toBe(true);
      const loader = await loadExtensions(space, { resolution: real, load: null });

      const extensions = loader.getExtensions().extensions ?? [];
      const builtinEntries = extensions.filter(
        (extension) => extension.path === WORKFLOW_BUILTIN_PATH,
      );
      expect(builtinEntries).toHaveLength(1);
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().warnings).toEqual([]);
      // The real refinement + mode surface is present on the shipped copy.
      expect(builtinEntries[0]?.commands.has("prompt")).toBe(true);
      expect(builtinEntries[0]?.commands.has("prompt-model")).toBe(true);
      expect(builtinEntries[0]?.commands.has("workflow-cycle")).toBe(true);
    },
  );

  it.skipIf(!hasRealArtifact)(
    "honours -builtin:workflow for the real bundle and loads no second copy",
    async () => {
      const space = workspace();
      const loader = await loadExtensions(space, {
        resolution: realResolution(),
        load: null,
        settings: { extensions: ["-builtin:workflow"] },
      });

      expect(loadedPaths(loader)).not.toContain(WORKFLOW_BUILTIN_PATH);
      expect(loader.getExtensions().errors).toEqual([]);
      expect(loader.getExtensions().extensions ?? []).toEqual([]);

      // The hub shows a re-enableable row instead of a phantom loaded bundle.
      const snapshot = buildResourcesSnapshot({
        cwd: space.cwd,
        scope: "control",
        settings: { global: { extensions: ["-builtin:workflow"] }, project: {} },
        source: { extensions: loader.getExtensions() },
        builtin: realResolution(),
      });
      expect(
        snapshot.resources.find((entry) => entry.overridePath === WORKFLOW_BUILTIN_PATH),
      ).toMatchObject({ enabled: false, name: "workflow" });
    },
  );

  it.skipIf(!hasRealArtifact)(
    "lets a real installed Workflow copy replace the builtin exactly once",
    async () => {
      const space = workspace();
      const installed = installRealCopy(space);
      const loader = await loadExtensions(space, {
        resolution: realResolution(),
        load: null,
      });

      const paths = loadedPaths(loader);
      expect(paths.filter((path) => path === installed)).toHaveLength(1);
      expect(paths).not.toContain(WORKFLOW_BUILTIN_PATH);

      const warning = (loader.getExtensions().warnings ?? []).find(
        (entry) => entry.path === WORKFLOW_BUILTIN_PATH,
      );
      expect(warning?.warning).toMatch(/built-in extension `workflow` was not loaded/);

      // One registration of the refinement command, from the installed copy.
      const promptOwners = (loader.getExtensions().extensions ?? []).filter((extension) =>
        extension.commands.has("prompt"),
      );
      expect(promptOwners).toHaveLength(1);
      expect(promptOwners[0]?.path).toBe(installed);
    },
  );

  it.skipIf(!hasRealArtifact)(
    "loads neither the real builtin nor an installed copy in safe mode",
    async () => {
      const space = workspace();
      installRealCopy(space);
      const loader = await loadExtensions(space, {
        resolution: resolveWorkflowBuiltin({ safeMode: true }),
        safeMode: true,
        load: null,
      });
      expect(loadedPaths(loader)).toEqual([]);
      expect(
        (loader.getExtensions().extensions ?? []).some((entry) => entry.commands.has("prompt")),
      ).toBe(false);
    },
  );
});
