import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeProvider, type FakeProvider } from "../../host/fixtures/fake-provider";
import { launchApp, type LaunchedApp, type LaunchOptions } from "./app";

/**
 * A launched app wired to the deterministic fake provider (plan step 25).
 *
 * The profile gets `settings.json` (default model) and `models.json` (a custom
 * OpenAI-compatible provider pointed at the in-process fake server), and
 * `app-state.json` remembers one project so the shell opens on it without a
 * native folder picker.
 */

export interface FakeApp extends LaunchedApp {
  provider: FakeProvider;
  /** The temp project the seeded session runs in. */
  projectDir: string;
  /** Closes the app, the provider and the temp project. */
  shutdown(): Promise<number | null>;
  /** Closes the window and launches again against the same state/profile. */
  relaunch(): Promise<void>;
  /** Clicks an Electron menu item by its command id (e.g. `open-web-url`). */
  menuCommand(id: string): Promise<void>;
}

export interface FakeAppOptions {
  /** Extra app-state keys (tabs, view preferences, …). */
  appState?: Record<string, unknown>;
  /** Extra settings keys merged over the defaults. */
  settings?: Record<string, unknown>;
  /** Launch the app on the welcome view instead of the seeded project. */
  noProject?: boolean;
  /** Reuse an existing project dir (for a restart against the same profile). */
  projectDir?: string;
  /** Extra launch options, e.g. explicit `prefs`. */
  launch?: LaunchOptions;
}

/** Creates a temp project directory for an E2E session. */
export function seedFakeProviderProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-e2e-project-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# E2E project\n", "utf8");
  return dir;
}

export function fakeProviderSettings(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    defaultProvider: "fake",
    defaultModel: "fake-1",
    retry: { enabled: true, provider: { maxRetries: 3, maxRetryDelayMs: 1 } },
    compaction: { keepRecentTokens: 1, reserveTokens: 1 },
    ...overrides,
  };
}

export function fakeProviderModels(baseUrl: string): Record<string, unknown> {
  return {
    providers: {
      fake: {
        baseUrl,
        api: "openai-completions",
        apiKey: "fake-key",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [
          { id: "fake-1", name: "Fake Model", input: ["text", "image"], contextWindow: 200000 },
        ],
      },
    },
  };
}

export async function launchFakeApp(options: FakeAppOptions = {}): Promise<FakeApp> {
  const provider = await createFakeProvider();
  const projectDir = options.projectDir ?? seedFakeProviderProject();
  const ownProject = options.projectDir === undefined;

  const appState: Record<string, unknown> = {
    ...(options.noProject
      ? {}
      : {
          projects: [{ path: projectDir, name: "E2E project", addedAt: 1, lastOpenedAt: 1 }],
          activeProject: projectDir,
        }),
    ...(options.appState ?? {}),
  };

  const launched = await launchApp({
    settings: fakeProviderSettings(options.settings),
    models: fakeProviderModels(provider.baseUrl),
    appState,
    ...(options.launch ?? {}),
  });

  let current = launched;
  const result: FakeApp = {
    ...launched,
    provider,
    projectDir,
    async shutdown() {
      const code = await current.close();
      await provider.close();
      if (ownProject) {
        try {
          rmSync(projectDir, { recursive: true, force: true });
        } catch {
          // Windows can hold the directory briefly after the app exits.
        }
      }
      return code;
    },
    async relaunch() {
      // Restart against the *same* app-state and profile, so the test observes
      // what the app persisted rather than a fresh seed.
      await current.close();
      current = await launchApp({
        userDataDir: current.paths.userDataDir,
        profileDir: current.paths.profileDir,
        noSeed: true,
        ...(options.launch ?? {}),
      });
      result.app = current.app;
      result.window = current.window;
      result.paths = current.paths;
      result.close = current.close;
    },
    async menuCommand(id) {
      await current.app.evaluate(({ Menu }, commandId) => {
        Menu.getApplicationMenu()?.getMenuItemById(commandId)?.click();
      }, id);
    },
  };
  return result;
}
