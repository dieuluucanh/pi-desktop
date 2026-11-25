/**
 * Packaged/offline acceptance for the bundled Workflow (plan step 39).
 *
 * `verify:workflow` proves the *staged* artifact matches the pin. It cannot
 * prove that the thing the user double-clicks loads that artifact — the asar
 * layout, the unpacked `out/**` tree, the bundled Node and the clean-profile
 * settings all participate. This script runs the packaged bytes:
 *
 *   node scripts/verify-packaged-workflow.mjs --dir release/win-unpacked
 *   node scripts/verify-packaged-workflow.mjs --resources /app/resources
 *   npm run verify:packaged-workflow -- --dir release/win-unpacked
 *
 * Every host and CLI it starts uses only:
 *   - the bundled Node (`resources/runtime/node/<platform>-<arch>/…`),
 *   - the packaged host bundle (`app.asar.unpacked/out/host/index.mjs`),
 *   - an empty temporary `PI_CODING_AGENT_DIR` and `HOME`, so no developer
 *     profile, installed Workflow copy or npm package is visible,
 *   - a `PATH` holding one empty directory, so a system `pi`/`node`/`npm` cannot
 *     be picked up even if the machine has one,
 *   - proxy variables pointed at a closed port, so anything that tried to dial
 *     out would fail instead of silently succeeding on a networked machine.
 *
 * Rows (each printed with PASS/FAIL and evidence):
 *
 *   artifact-integrity        staged bundle == lock + metadata, per-file sha256
 *   artifact-self-contained   no checkout reference, no runtime deps/scripts
 *   clean-profile-registration exactly one Workflow registration, pinned version
 *   offline-startup           packaged host answers with no network path
 *   refinement-capability     `/prompt`, `/prompt-model`, companion advertised
 *   parity-commands           representative Workflow command surface present
 *   child-cli-launch          packaged Pi CLI runs under the bundled Node
 *   restart                   a second start is identical (no duplication)
 *   explicit-override         PI_DESKTOP_WORKFLOW_BUNDLE_DIR wins, once
 *   disable-optout            `-builtin:workflow` leaves a re-enableable row
 *   safe-mode                 nothing third-party is read or registered
 *   broken-bundle             repair diagnostic, fail closed, no commands
 *
 * Nothing is published, installed or written into the repository. It exits
 * non-zero on the first summary with any failed row.
 *
 * Invoked as `node scripts/…`; no shebang so the Vitest module runner can import
 * it on a CRLF checkout.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  WORKFLOW_LOCK_FILE,
  checkStagedFiles,
  findCheckoutReferences,
  findForeignSpecifiers,
  findMissingPackedImports,
  unexpectedLifecycleScripts,
  validateWorkflowLock,
} from "./workflow-bundle.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, "..");
const BUNDLE_METADATA_FILE = "workflow-bundle.json";
const BUNDLE_DIR = "workflow";
const BUNDLE_ENTRY = "index.ts";

/** The refinement surface a packaged Workflow must advertise (plan steps 12–15). */
export const REQUIRED_REFINEMENT_COMMANDS = Object.freeze([
  "prompt",
  "prompt-model",
  "prompt-refine-companion",
  "prompt-refine",
]);

/** A representative slice of the full-parity surface (verification matrix). */
export const REQUIRED_PARITY_COMMANDS = Object.freeze([
  "workflow-cycle",
  "default",
  "plan",
  "build",
  "orchestrator",
  "role",
  "profile",
  "permissions",
  "read-policy",
  "write-policy",
  "folder-policy",
  "shell-guard",
  "commit-policy",
  "commit",
  "review",
  "handoff",
  "todos",
  "rewind",
  "btw",
]);

/** The tab/CLI contract the packaged CLI must satisfy for child agents. */
export const PI_CLI_RELATIVE = join(
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);

const HELP = `Verify the packaged/offline Workflow surface (plan step 39)

  node scripts/verify-packaged-workflow.mjs [flags]

  --dir <dir>        electron-builder output dir (e.g. release/win-unpacked)
  --resources <dir>  packaged resources dir (alternative to --dir)
  --root <dir>       repository root for the lock file (default: this checkout)
  --platform <p>     win32 | darwin | linux (default: this machine)
  --arch <a>         x64 | arm64 (default: this machine)
  --node <file>      override the bundled Node binary
  --timeout <ms>     per-host request timeout (default: 60000)
  --keep             keep the temporary profile/override dirs for inspection
  --json             machine-readable report
  --help             this text

The script never publishes, installs or writes into the package. It exits
non-zero when any row fails.`;

/** Parses the CLI (mirrors the other packaged scripts). */
export function parseVerifyArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      dir: { type: "string" },
      resources: { type: "string" },
      root: { type: "string" },
      platform: { type: "string" },
      arch: { type: "string" },
      node: { type: "string" },
      timeout: { type: "string" },
      keep: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };
  if (!values.resources && !values.dir) {
    throw new Error("verify:packaged-workflow: pass --dir <app-out-dir> or --resources <dir>");
  }
  if (
    values.platform !== undefined &&
    values.platform !== "win32" &&
    values.platform !== "darwin" &&
    values.platform !== "linux"
  ) {
    throw new Error(`verify:packaged-workflow: unsupported --platform "${values.platform}"`);
  }
  if (values.arch !== undefined && values.arch !== "x64" && values.arch !== "arm64") {
    throw new Error(`verify:packaged-workflow: unsupported --arch "${values.arch}"`);
  }
  const timeout = values.timeout === undefined ? 60_000 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("verify:packaged-workflow: --timeout must be a positive integer (ms)");
  }
  return {
    help: false,
    resources: values.resources ?? null,
    dir: values.dir ?? null,
    root: resolve(values.root ?? DEFAULT_ROOT),
    platform: values.platform ?? process.platform,
    arch: values.arch ?? process.arch,
    node: values.node ? resolve(values.node) : null,
    timeoutMs: timeout,
    keep: values.keep === true,
    json: values.json === true,
  };
}

/** Accepts either the `resources` dir or electron-builder's `<app>-unpacked`. */
export function resourcesDirFor(target) {
  const absolute = resolve(target);
  const nested = join(absolute, "resources");
  return existsSync(nested) ? nested : absolute;
}

/** The packaged paths every check below uses. Pure. */
export function packagedPaths(resourcesDir, platform = process.platform, arch = process.arch) {
  return {
    resourcesDir,
    hostBundle: join(resourcesDir, "app.asar.unpacked", "out", "host", "index.mjs"),
    nodePath: join(
      resourcesDir,
      "runtime",
      "node",
      `${platform}-${arch}`,
      platform === "win32" ? "node.exe" : join("bin", "node"),
    ),
    piCliPath: join(resourcesDir, "app.asar.unpacked", PI_CLI_RELATIVE),
    extensionsDir: join(resourcesDir, "extensions", "workflow"),
    // The copy main prefers: it can resolve the extension's host peers through
    // `app.asar.unpacked/node_modules` on an installed machine.
    unpackedExtensionsDir: join(resourcesDir, "app.asar.unpacked", "out", "extensions", "workflow"),
  };
}

/**
 * The staged directory a packaged main would hand the host.
 *
 * Mirrors `resolveWorkflowBundle` (packaged): the unpacked host-build copy wins
 * over the `extraResources` copy, because only it can resolve `@earendil-works/*`
 * and `typebox` from `app.asar.unpacked/node_modules` outside a developer
 * checkout. The harness must resolve the same way or it tests a layout the app
 * never uses.
 */
export function packagedBundleDir(paths) {
  return existsSync(paths.unpackedExtensionsDir)
    ? paths.unpackedExtensionsDir
    : paths.extensionsDir;
}

/** sha256 of a file's bytes, in the lock file's format. */
export function sha256Of(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The environment every spawned packaged binary gets.
 *
 * The point is the *absence* of things: no developer profile (HOME and
 * `PI_CODING_AGENT_DIR` are fresh), no system toolchain (PATH is one empty
 * directory), and no working proxy (so a network attempt fails loudly instead
 * of passing because the machine happened to be online).
 */
export function packagedEnv(options) {
  const {
    tempDir,
    agentDir,
    blobDir,
    bundleDir,
    safeMode = false,
    platform = process.platform,
  } = options;
  const emptyPath = join(tempDir, "empty-path");
  const home = join(tempDir, "home");
  mkdirSync(emptyPath, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(blobDir, { recursive: true });

  const env = {
    // Only what an OS needs to start a process at all.
    PATH: emptyPath,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: join(tempDir, "tmp"),
    TEMP: join(tempDir, "tmp"),
    TMP: join(tempDir, "tmp"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_DESKTOP_BLOB_DIR: blobDir,
    PI_DESKTOP_HOST_ROLE: "control",
    PI_DESKTOP_SAFE_MODE: safeMode ? "1" : "0",
    PI_DESKTOP_SERVICE: "service",
    // Offline by construction: a closed port, never a real proxy.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    // No telemetry/update traffic even if a module ignored the proxies.
    PI_DESKTOP_OFFLINE: "1",
    DO_NOT_TRACK: "1",
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  if (bundleDir) env.PI_DESKTOP_WORKFLOW_BUNDLE_DIR = bundleDir;
  if (platform === "win32") {
    for (const key of ["SystemRoot", "windir", "PATHEXT", "ComSpec"]) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
  }
  return env;
}

/** Minimal JSONL driver for the packaged host protocol. */
export function startHost({ nodePath, hostBundle, cwd, env, timeoutMs = 60_000 }) {
  const child = spawn(
    nodePath,
    [hostBundle, "--service", "--session", "acceptance", "--cwd", cwd, "--port", "0"],
    {
      cwd,
      env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const pending = new Map();
  const stderr = [];
  let stdout = "";
  let nextId = 1;
  let failure = null;

  const settleAll = (error) => {
    failure = error;
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    let index = stdout.indexOf("\n");
    while (index !== -1) {
      const line = stdout.slice(0, index);
      stdout = stdout.slice(index + 1);
      index = stdout.indexOf("\n");
      if (line.trim().length === 0) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        continue;
      }
      if (frame.event) continue;
      const waiter = pending.get(frame.id);
      if (!waiter) continue;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.ok) waiter.resolve(frame.result);
      else
        waiter.reject(
          new Error(`${frame.error?.code ?? "error"}: ${frame.error?.message ?? "unknown"}`),
        );
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 200) stderr.shift();
  });
  child.on("error", (error) => settleAll(error));
  child.on("exit", (code, signal) =>
    settleAll(new Error(`the packaged host exited (${code ?? signal ?? "unknown"})`)),
  );

  const request = (method, params) =>
    new Promise((res, rej) => {
      if (failure) {
        rej(failure);
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error(`timed out after ${timeoutMs} ms waiting for ${method}`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          res(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rej(error);
        },
        timer,
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });

  return {
    request,
    async close() {
      try {
        child.stdin.end();
      } catch {
        // Already closed; the exit below is what matters.
      }
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((res) => child.once("exit", res));
        child.kill();
        await exited;
      }
      return stderr.join("");
    },
  };
}

/**
 * The one Workflow registration a packaged host must show.
 *
 * A `builtin:workflow` row is the expected shape; an installed copy would be a
 * different row, which is legal only in the explicit override scenarios and is
 * never counted silently as "the builtin loaded".
 */
export function workflowRegistrations(snapshot) {
  const rows = Array.isArray(snapshot?.resources) ? snapshot.resources : [];
  return rows.filter((row) => {
    if (row?.kind !== "extensions") return false;
    const path = String(row.overridePath ?? row.path ?? "");
    if (path === "builtin:workflow") return true;
    if (!row.builtin && row.name === "workflow") return true;
    return path.includes(`${sep}extensions${sep}workflow`) || path.includes("/extensions/workflow");
  });
}

/** Command names a resource row advertises, sorted and bounded. */
export function contributedCommands(row) {
  const contributions = Array.isArray(row?.contributed) ? row.contributed : [];
  return contributions
    .filter((entry) => entry?.kind === "command")
    .map((entry) => String(entry.name ?? ""))
    .filter((name) => name.length > 0);
}

/** Deterministic lock comparison for the staged packaged copy. */
export function checkPackagedArtifact({ extensionsDir, lock, metadata }) {
  const problems = [];
  if (!existsSync(extensionsDir)) return [`no staged Workflow bundle at ${extensionsDir}`];
  const metadataPath = join(extensionsDir, BUNDLE_METADATA_FILE);
  if (!existsSync(metadataPath)) {
    return [`the staged bundle has no ${BUNDLE_METADATA_FILE}`];
  }
  const lockProblems = validateWorkflowLock(lock);
  if (lockProblems.length > 0) return lockProblems.map((problem) => `lock: ${problem}`);

  const parsed = metadata ?? JSON.parse(readFileSync(metadataPath, "utf8"));
  const entry = join(extensionsDir, BUNDLE_ENTRY);
  if (!existsSync(entry)) problems.push(`the staged bundle has no ${BUNDLE_ENTRY}`);

  problems.push(
    ...checkStagedFiles({
      lock,
      metadata: parsed,
      exists: (target) => existsSync(join(extensionsDir, target)),
      read: (target) => readFileSync(join(extensionsDir, target)),
      list: () => readdirSync(extensionsDir),
    }),
  );

  const files = readdirSync(extensionsDir).filter((name) => name !== BUNDLE_METADATA_FILE);
  const read = (name) => readFileSync(join(extensionsDir, name), "utf8");
  problems.push(
    ...findMissingPackedImports(files, read).map(
      (miss) => `missing import: ${miss.from} -> ${miss.specifier}`,
    ),
  );
  problems.push(
    ...findForeignSpecifiers(files, read).map(
      (foreign) => `foreign import: ${foreign.from} -> ${foreign.specifier}`,
    ),
  );
  problems.push(
    ...findCheckoutReferences(files, read).map(
      (reference) => `checkout reference in ${reference.file}: ${reference.needle}`,
    ),
  );
  if (parsed?.manifest) {
    problems.push(
      ...unexpectedLifecycleScripts(parsed.manifest).map((script) => `lifecycle: ${script}`),
    );
  }
  return problems;
}

async function startScenario(context, options = {}) {
  const { paths, timeoutMs } = context;
  const scenarioRoot = options.tempDir ?? context.tempDir;
  const agentDir =
    options.agentDir ?? join(scenarioRoot, `agent-${Math.random().toString(36).slice(2)}`);
  const blobDir = join(scenarioRoot, `blobs-${Math.random().toString(36).slice(2)}`);
  const env = packagedEnv({
    tempDir: scenarioRoot,
    agentDir,
    blobDir,
    // What main resolves and hands every host: without this the host would be
    // testing its own "missing bundle" fallback, not the packaged artifact.
    bundleDir: options.bundleDir ?? packagedBundleDir(paths),
    ...(options.safeMode ? { safeMode: true } : {}),
    platform: context.platform,
  });
  if (options.before) options.before({ agentDir, env });
  const host = startHost({
    nodePath: paths.nodePath,
    hostBundle: paths.hostBundle,
    cwd: options.cwd ?? scenarioRoot,
    env,
    timeoutMs,
  });
  try {
    const hello = await host.request("host.hello");
    const snapshot = await host.request("resources.list", { cwd: options.cwd ?? scenarioRoot });
    const stderr = await host.close();
    return { hello, snapshot, stderr, env };
  } catch (error) {
    const stderr = await host.close();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`, {
      cause: error,
    });
  }
}

function expect(condition, message, failures) {
  if (!condition) failures.push(message);
}

/**
 * Runs every row and returns the report. Pure enough for a Vitest test to call
 * the checks with injected spawn functions; the CLI path uses the real one.
 */
export async function runChecks(options) {
  const {
    root = DEFAULT_ROOT,
    resourcesDir,
    platform = process.platform,
    arch = process.arch,
    timeoutMs = 60_000,
  } = options;
  const paths = packagedPaths(resourcesDir, platform, arch);
  if (options.nodePath) paths.nodePath = options.nodePath;
  const lockPath = join(root, WORKFLOW_LOCK_FILE);
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const tempDir = mkdtempSync(join(tmpdir(), "pi-packaged-workflow-"));
  const rows = [];

  const record = async (id, title, run) => {
    const failures = [];
    let detail = null;
    try {
      detail = await run(failures);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    rows.push({ id, title, ok: failures.length === 0, failures, detail });
    return failures.length === 0;
  };

  const context = { paths, tempDir, platform, arch, timeoutMs, lock };

  try {
    await record(
      "artifact-integrity",
      "staged bundle matches the lock and metadata",
      (failures) => {
        const copies = [packagedBundleDir(paths)];
        if (paths.extensionsDir !== copies[0] && existsSync(paths.extensionsDir)) {
          copies.push(paths.extensionsDir);
        }
        let files = 0;
        for (const dir of copies) {
          if (!existsSync(dir)) {
            failures.push(`no staged bundle at ${dir}`);
            continue;
          }
          const metadata = JSON.parse(readFileSync(join(dir, BUNDLE_METADATA_FILE), "utf8"));
          files = (metadata.files ?? []).length;
          for (const problem of checkPackagedArtifact({ extensionsDir: dir, lock, metadata })) {
            failures.push(`${dir}: ${problem}`);
          }
        }
        return { files, copies: copies.length, resolved: copies[0] };
      },
    );

    await record(
      "artifact-self-contained",
      "no checkout reference or runtime install",
      (failures) => {
        const files = readdirSync(paths.extensionsDir).filter(
          (name) => name !== BUNDLE_METADATA_FILE,
        );
        const read = (name) => readFileSync(join(paths.extensionsDir, name), "utf8");
        const references = findCheckoutReferences(files, read);
        expect(references.length === 0, `checkout references: ${references.join(", ")}`, failures);
        const packageJson = join(paths.extensionsDir, "package.json");
        if (existsSync(packageJson)) {
          const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
          expect(
            unexpectedLifecycleScripts(manifest).length === 0,
            "the staged manifest has lifecycle scripts",
            failures,
          );
        }
        return { files: files.length };
      },
    );

    let baseline = null;
    await record(
      "clean-profile-registration",
      "a fresh profile loads exactly one pinned Workflow",
      async (failures) => {
        baseline = await startScenario(context);
        const capability = baseline.hello?.capabilities?.workflowBuiltin;
        expect(
          capability?.registered === true,
          `host.hello did not report a registered builtin: ${JSON.stringify(capability)}`,
          failures,
        );
        expect(
          capability?.version === lock.version,
          `version ${capability?.version} != pin`,
          failures,
        );
        expect(
          capability?.source === "bundled",
          `source ${capability?.source} != bundled`,
          failures,
        );
        expect(capability?.path === "builtin:workflow", `path ${capability?.path}`, failures);
        const registrations = workflowRegistrations(baseline.snapshot);
        expect(
          registrations.length === 1,
          `expected exactly one Workflow registration, found ${registrations.length}`,
          failures,
        );
        const row = registrations[0];
        expect(
          row?.builtin?.version === lock.version,
          "the hub row has no pinned version",
          failures,
        );
        expect(row?.enabled !== false, "the builtin row is disabled", failures);
        const workflowErrors = (baseline.snapshot.diagnostics ?? []).filter((entry) =>
          String(entry.message ?? "").includes("Workflow"),
        );
        expect(
          workflowErrors.length === 0,
          `unexpected diagnostics: ${JSON.stringify(workflowErrors)}`,
          failures,
        );
        return { registrations: registrations.length, path: row?.path ?? null };
      },
    );

    await record(
      "offline-startup",
      "the packaged host answers with no network path",
      async (failures) => {
        const offline = baseline ?? (await startScenario(context));
        expect(offline.hello?.nodeVersion !== undefined, "host.hello has no nodeVersion", failures);
        expect(
          offline.hello?.capabilities?.workflowBuiltin?.source === "bundled",
          "the offline host did not load the staged copy",
          failures,
        );
        expect(
          offline.stderr.trim().length === 0,
          `host stderr: ${offline.stderr.slice(0, 500)}`,
          failures,
        );
        return {
          nodeVersion: offline.hello?.nodeVersion ?? null,
          piVersion: offline.hello?.piVersion ?? null,
        };
      },
    );

    await record(
      "refinement-capability",
      "the refinement surface is advertised",
      async (failures) => {
        const snapshot = baseline?.snapshot ?? (await startScenario(context)).snapshot;
        const row = workflowRegistrations(snapshot)[0];
        const commands = contributedCommands(row);
        const missing = REQUIRED_REFINEMENT_COMMANDS.filter((name) => !commands.includes(name));
        expect(
          missing.length === 0,
          `missing refinement commands: ${missing.join(", ")}`,
          failures,
        );
        return { commands: commands.filter((name) => REQUIRED_REFINEMENT_COMMANDS.includes(name)) };
      },
    );

    await record(
      "parity-commands",
      "representative full-parity commands are present",
      async (failures) => {
        const snapshot = baseline?.snapshot ?? (await startScenario(context)).snapshot;
        const commands = contributedCommands(workflowRegistrations(snapshot)[0]);
        const missing = REQUIRED_PARITY_COMMANDS.filter((name) => !commands.includes(name));
        expect(missing.length === 0, `missing parity commands: ${missing.join(", ")}`, failures);
        return { advertised: commands.length };
      },
    );

    await record(
      "child-cli-launch",
      "the packaged Pi CLI runs under the bundled Node",
      async (failures) => {
        expect(existsSync(paths.piCliPath), `no packaged Pi CLI at ${paths.piCliPath}`, failures);
        if (failures.length > 0) return null;
        const env = packagedEnv({
          tempDir,
          agentDir: join(tempDir, "cli-agent"),
          blobDir: join(tempDir, "cli-blobs"),
          platform,
        });
        const run = (args) =>
          new Promise((res) => {
            const child = spawn(paths.nodePath, [paths.piCliPath, ...args], {
              cwd: tempDir,
              env,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
            const out = [];
            child.stdout.on("data", (chunk) => out.push(String(chunk)));
            child.stderr.on("data", (chunk) => out.push(String(chunk)));
            child.on("exit", (code) => res({ code, output: out.join("") }));
          });
        const version = await run(["--version"]);
        expect(
          version.code === 0,
          `--version exited ${version.code}: ${version.output.slice(0, 400)}`,
          failures,
        );
        expect(
          /1\.5\.\d+/.test(version.output),
          `unexpected --version output: ${version.output.trim()}`,
          failures,
        );
        const help = await run(["--help"]);
        expect(help.code === 0, `--help exited ${help.code}`, failures);
        expect(/Usage:/i.test(help.output), "the CLI printed no usage", failures);
        return { version: version.output.trim().split("\n").pop() ?? null };
      },
    );

    await record("restart", "a second start is identical and adds nothing", async (failures) => {
      const again = await startScenario(context, { tempDir: join(tempDir, "restart") });
      const capability = again.hello?.capabilities?.workflowBuiltin;
      expect(
        capability?.registered === true,
        "the restarted host did not register the builtin",
        failures,
      );
      expect(capability?.version === lock.version, "the restarted version differs", failures);
      expect(
        workflowRegistrations(again.snapshot).length === 1,
        "the restarted hub shows duplicate registrations",
        failures,
      );
      return { registrations: workflowRegistrations(again.snapshot).length };
    });

    await record(
      "explicit-override",
      "an explicit bundle override wins, once",
      async (failures) => {
        // A complete, valid copy outside the package, with the packaged
        // `node_modules` reachable above it exactly as the unpacked layout does.
        // `broken-bundle` below proves the override also wins over the working
        // default (a corrupt override is reported instead of the good copy loading).
        const overrideRoot = join(tempDir, "override");
        const overrideDir = join(overrideRoot, "extensions", BUNDLE_DIR);
        mkdirSync(overrideDir, { recursive: true });
        const staged = packagedBundleDir(paths);
        for (const name of readdirSync(staged)) {
          writeFileSync(join(overrideDir, name), readFileSync(join(staged, name)));
        }
        const peerModules = join(paths.resourcesDir, "app.asar.unpacked", "node_modules");
        if (existsSync(peerModules)) {
          symlinkSync(peerModules, join(overrideRoot, "node_modules"), "junction");
        }
        const result = await startScenario(context, {
          tempDir: overrideRoot,
          bundleDir: overrideDir,
        });
        const capability = result.hello?.capabilities?.workflowBuiltin;
        expect(capability?.registered === true, "the override did not register", failures);
        expect(capability?.version === lock.version, "the override version differs", failures);
        const registrations = workflowRegistrations(result.snapshot);
        expect(
          registrations.length === 1,
          "the override produced duplicate registrations",
          failures,
        );
        expect(
          registrations[0]?.enabled !== false &&
            registrations[0]?.builtin?.version === lock.version,
          "the override row is not the pinned builtin",
          failures,
        );
        return { source: capability?.source ?? null, rows: registrations.length };
      },
    );

    await record(
      "disable-optout",
      "-builtin:workflow disables it and stays re-enableable",
      async (failures) => {
        const result = await startScenario(context, {
          tempDir: join(tempDir, "disabled"),
          before: ({ agentDir }) => {
            writeFileSync(
              join(agentDir, "settings.json"),
              `${JSON.stringify({ extensions: ["-builtin:workflow"] }, null, 2)}\n`,
            );
          },
        });
        const registrations = workflowRegistrations(result.snapshot);
        const loaded = registrations.filter((row) => row.enabled !== false);
        expect(loaded.length === 0, "the disabled builtin still loaded", failures);
        expect(
          registrations.some((row) => row.enabled === false && row.builtin),
          "the hub has no re-enableable builtin row",
          failures,
        );
        const commands = registrations.flatMap((row) => contributedCommands(row));
        expect(commands.length === 0, "a disabled builtin advertised commands", failures);
        return { rows: registrations.length };
      },
    );

    await record(
      "safe-mode",
      "safe mode registers and reads nothing third-party",
      async (failures) => {
        const result = await startScenario(context, {
          tempDir: join(tempDir, "safe"),
          safeMode: true,
        });
        const capability = result.hello?.capabilities?.workflowBuiltin;
        expect(capability?.registered !== true, "safe mode still registered the builtin", failures);
        expect(
          capability?.disabledBy === "safe-mode",
          `disabledBy ${capability?.disabledBy}`,
          failures,
        );
        const extensions = (result.snapshot.resources ?? []).filter(
          (row) => row.kind === "extensions",
        );
        expect(
          extensions.length === 0,
          `safe mode listed extensions: ${extensions.length}`,
          failures,
        );
        return { disabledBy: capability?.disabledBy ?? null };
      },
    );

    await record(
      "broken-bundle",
      "a corrupt bundle fails closed with repair diagnostics",
      async (failures) => {
        const brokenDir = join(tempDir, "broken", "workflow");
        mkdirSync(brokenDir, { recursive: true });
        writeFileSync(join(brokenDir, BUNDLE_METADATA_FILE), "{ truncated");
        writeFileSync(join(brokenDir, BUNDLE_ENTRY), "export default function broken() {}\n");
        const result = await startScenario(context, {
          tempDir: join(tempDir, "broken"),
          bundleDir: brokenDir,
        });
        const capability = result.hello?.capabilities?.workflowBuiltin;
        expect(capability?.registered === false, "the corrupt bundle was registered", failures);
        expect(
          capability?.disabledBy === "invalid-bundle",
          `disabledBy ${capability?.disabledBy}`,
          failures,
        );
        expect(
          workflowRegistrations(result.snapshot).length === 0,
          "the corrupt bundle produced a registration",
          failures,
        );
        const diagnostics = result.snapshot.diagnostics ?? [];
        const messages = diagnostics.map((entry) => String(entry.message ?? ""));
        expect(
          messages.some((message) => message.includes("bundled Workflow is not loaded")),
          `no repair error in the hub: ${JSON.stringify(messages.slice(0, 4))}`,
          failures,
        );
        expect(
          messages.some((message) => message.startsWith("repair:")),
          "no repair hint in the hub",
          failures,
        );
        // Fail closed: with no Workflow registration there is no `/prompt` handler,
        // so a typed refinement cannot be executed as the original request.
        const commands = (result.snapshot.resources ?? [])
          .filter((row) => row.kind === "extensions")
          .flatMap((row) => contributedCommands(row));
        expect(!commands.includes("prompt"), "a broken bundle still advertised /prompt", failures);
        return {
          diagnostics: messages.filter(
            (message) => message.includes("Workflow") || message.startsWith("repair:"),
          ),
        };
      },
    );
  } finally {
    if (!options.keep) {
      try {
        rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // Windows can hold a directory briefly; the report is already complete.
      }
    }
  }

  return { ok: rows.every((row) => row.ok), rows, paths, platform, arch, tempDir };
}

async function main(argv) {
  const options = parseVerifyArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const resourcesDir = resourcesDirFor(options.resources ?? options.dir);
  const report = await runChecks({
    root: options.root,
    resourcesDir,
    platform: options.platform,
    arch: options.arch,
    timeoutMs: options.timeoutMs,
    keep: options.keep,
    ...(options.node ? { nodePath: options.node } : {}),
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`packaged resources: ${report.paths.resourcesDir}\n`);
    for (const row of report.rows) {
      process.stdout.write(`${row.ok ? "PASS" : "FAIL"}  ${row.id} — ${row.title}\n`);
      if (!row.ok) for (const failure of row.failures) process.stdout.write(`        ${failure}\n`);
    }
    const passed = report.rows.filter((row) => row.ok).length;
    process.stdout.write(`\n${passed}/${report.rows.length} rows passed\n`);
    if (options.keep) process.stdout.write(`temporary evidence kept at ${report.tempDir}\n`);
  }
  return report.ok ? 0 : 1;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `verify:packaged-workflow failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}

export { main, sep };
