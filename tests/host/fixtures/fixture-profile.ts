import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throw-away Pi profile pointed at the deterministic fake provider (plan
 * step 25).
 *
 * `settings.json` selects the fake model as the default and shortens the retry
 * backoff so a retry test does not sleep; `models.json` declares the fake
 * provider as an OpenAI-compatible gateway with a literal API key, which is what
 * makes it available without any `auth.json` (Pi only lists models with
 * configured auth).
 */

export interface FixtureProfile {
  /** The profile directory (`PI_CODING_AGENT_DIR`). */
  dir: string;
  /** A directory to open as the project/session cwd. */
  projectDir: string;
  /** Where the SDK writes session JSONL files. */
  sessionsDir: string;
  /** Absolute path of the profile's `settings.json`. */
  settingsPath: string;
  /** Absolute path of the profile's `models.json`. */
  modelsPath: string;
  /** Writes a file into the profile's `extensions/` directory. */
  writeExtension(name: string, source: string): string;
  /** Removes the temporary directories. */
  remove(): void;
}

export interface FixtureProfileOptions {
  /** Provider base URL, e.g. `http://127.0.0.1:1234/v1`. */
  baseUrl: string;
  /** Provider id (default `fake`). */
  providerId?: string;
  /** Model id (default `fake-1`). */
  modelId?: string;
  /** Extra `settings.json` keys merged last (override the defaults). */
  settings?: Record<string, unknown>;
}

export function createFixtureProfile(options: FixtureProfileOptions): FixtureProfile {
  const dir = mkdtempSync(join(tmpdir(), "pi-desktop-fixture-profile-"));
  const projectDir = mkdtempSync(join(tmpdir(), "pi-desktop-fixture-project-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const providerId = options.providerId ?? "fake";
  const modelId = options.modelId ?? "fake-1";

  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    `${JSON.stringify(
      {
        defaultProvider: providerId,
        defaultModel: modelId,
        // Keep the retry test fast: the SDK waits maxRetryDelayMs between tries.
        retry: { enabled: true, provider: { maxRetries: 3, maxRetryDelayMs: 1 } },
        // A tiny keep-recent window so a handful of scripted turns is already
        // worth compacting; otherwise the SDK refuses with "session too small".
        compaction: { keepRecentTokens: 1, reserveTokens: 1 },
        ...(options.settings ?? {}),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    `${JSON.stringify(
      {
        providers: {
          [providerId]: {
            baseUrl: options.baseUrl,
            api: "openai-completions",
            apiKey: "fake-key",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [
              {
                id: modelId,
                name: "Fake Model",
                input: ["text", "image"],
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const extensionsDir = join(dir, "extensions");
  return {
    dir,
    projectDir,
    sessionsDir,
    settingsPath,
    modelsPath,
    writeExtension(name, source) {
      mkdirSync(extensionsDir, { recursive: true });
      const path = join(extensionsDir, name);
      writeFileSync(path, source, "utf8");
      return path;
    },
    remove() {
      for (const target of [dir, projectDir]) {
        try {
          rmSync(target, { recursive: true, force: true });
        } catch {
          // Windows can hold a handle briefly after the runtime disposes.
        }
      }
    },
  };
}
