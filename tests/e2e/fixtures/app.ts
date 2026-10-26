import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

/**
 * Playwright ⇄ Electron fixture (plan step 2).
 *
 * Every launch is isolated: a fresh `--user-data-dir` (the app's own state) and a
 * fresh `PI_CODING_AGENT_DIR` (the Pi profile), so a test can never touch the
 * developer's real `~/.pi/agent` or app state. The profile can be seeded with
 * `settings.json` / `models.json`, which is how a deterministic fake provider
 * will be injected once sessions exist (step 3).
 */

export interface LaunchOptions {
  /** Written to `<profile>/settings.json` before launch. */
  settings?: Record<string, unknown>;
  /** Written to `<profile>/models.json` before launch (custom providers). */
  models?: Record<string, unknown>;
  /**
   * Written to `<profile>/extensions/<name>` before launch. Global/profile
   * extensions auto-load without a trust prompt, so this is how a test seeds a
   * fixture extension (e.g. one that calls `ctx.ui.setEditorComponent`).
   */
  extensions?: Record<string, string>;
  /** Extra Electron arguments. */
  args?: readonly string[];
  /**
   * App preferences written to `<userData>/app-state.json` before launch. The
   * privacy screen is acknowledged by default so the smoke tests see the shell;
   * pass `{ privacyAcknowledged: false }` to exercise first-run (plan step 23).
   */
  prefs?: Record<string, unknown>;
  /** Any other top-level app-state fields (projects, tabs, …). */
  appState?: Record<string, unknown>;
  /** Extra environment variables for the app process (and the hosts it spawns). */
  env?: Record<string, string>;
  /** Reuse an existing app-state directory (restart tests). */
  userDataDir?: string;
  /** Reuse an existing Pi profile (restart tests). */
  profileDir?: string;
  /**
   * Skip seeding `settings.json`/`models.json`/`app-state.json`. A restart must
   * keep whatever the first run persisted, not overwrite it with the seed.
   */
  noSeed?: boolean;
}

export interface LaunchPaths {
  userDataDir: string;
  profileDir: string;
  appRoot: string;
}

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  paths: LaunchPaths;
  /** Closes the app and resolves with its exit code. */
  close(): Promise<number | null>;
}

/** Repository root — Playwright runs from the project directory. */
function repoRoot(): string {
  return process.cwd();
}

function appMainPath(root: string = repoRoot()): string {
  return resolve(root, "out", "main", "index.mjs");
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const root = repoRoot();
  const main = appMainPath(root);
  if (!existsSync(main)) {
    throw new Error(`E2E needs a build first: ${main} is missing (run \`npm run build\`).`);
  }

  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), "pi-desktop-e2e-state-"));
  const profileDir = options.profileDir ?? mkdtempSync(join(tmpdir(), "pi-desktop-e2e-profile-"));
  if (!options.noSeed) {
    seedProfile(profileDir, options);
    seedAppState(userDataDir, options);
  }

  const app = await electron.launch({
    // The app *directory* (whose package.json `main` points at out/main/index.mjs)
    // rather than the entry file: that is the shape Electron's own CLI and
    // Playwright's loader agree on for an ESM main process.
    args: [root, ...(options.args ?? [])],
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: profileDir,
      // Applied with `app.setPath("userData", …)` in main before any path is
      // resolved: a `--user-data-dir` switch after the app path is rejected by
      // Electron's CLI, so the environment is the reliable channel.
      PI_DESKTOP_USER_DATA_DIR: userDataDir,
      PI_DESKTOP_E2E: "1",
      // Never let an E2E run inherit a developer's proxy/offline switches.
      PI_OFFLINE: "",
      ...(options.env ?? {}),
    },
  });

  // Keep the app's own output: when a launch dies before the window is ready, the
  // reason is almost always in these lines rather than in Playwright's error.
  // The process handle is captured now because `app.close()` invalidates it.
  const child = app.process();
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  let window: Page;
  try {
    window = await app.firstWindow({ timeout: 30_000 });
    await window.waitForLoadState("domcontentloaded", { timeout: 20_000 });
  } catch (cause) {
    const detail = output.join("").trim();
    await app.close().catch(() => undefined);
    throw new Error(
      `Electron did not reach a loaded window (${cause instanceof Error ? cause.message : String(cause)}).` +
        (detail ? `\n--- app output ---\n${detail}` : "\n(app produced no output)"),
      { cause },
    );
  }

  return {
    app,
    window,
    paths: { userDataDir, profileDir, appRoot: root },
    close: async () => {
      await app.close();
      return child.exitCode;
    },
  };
}

/**
 * Seeds `app-state.json` so a launch starts from a known state. The privacy
 * screen has been acknowledged and onboarding has been completed unless a test
 * asks for the first-run path (plan steps 23 and 26).
 */
function seedAppState(userDataDir: string, options: LaunchOptions): void {
  const prefs = {
    privacyAcknowledged: true,
    onboardingCompletedAt: 1,
    ...(options.prefs ?? {}),
  };
  const state = { version: 1, ...(options.appState ?? {}), prefs };
  writeFileSync(join(userDataDir, "app-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function seedProfile(profileDir: string, options: LaunchOptions): void {
  if (options.settings) {
    writeFileSync(
      join(profileDir, "settings.json"),
      `${JSON.stringify(options.settings, null, 2)}\n`,
      "utf8",
    );
  }
  if (options.models) {
    writeFileSync(
      join(profileDir, "models.json"),
      `${JSON.stringify(options.models, null, 2)}\n`,
      "utf8",
    );
  }
  if (options.extensions) {
    const extensionsDir = join(profileDir, "extensions");
    mkdirSync(extensionsDir, { recursive: true });
    for (const [name, source] of Object.entries(options.extensions)) {
      writeFileSync(join(extensionsDir, name), source, "utf8");
    }
  }
}

/** Removes the temp state/profile directories of a finished launch. */
export function removeTempDirs(paths: LaunchPaths): void {
  for (const dir of [paths.userDataDir, paths.profileDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle briefly after exit; a leftover temp dir is harmless.
    }
  }
}
