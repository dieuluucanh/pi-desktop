import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_CONFIG_FILE,
  CheckpointConfigError,
  checkpointConfigPath,
  configFromPrefs,
  projectConfigFromPrefs,
  readConfig,
  serializeConfig,
  writeConfig,
  type CheckpointConfigFs,
} from "../../src/checkpoints/config";
import { DEFAULT_CHECKPOINT_CONFIG, DEFAULT_EXCLUDES } from "../../src/shared/checkpoints";
import { DEFAULT_PREFS, mergePrefs, sanitizePrefs } from "../../src/shared/prefs";

/**
 * The derived config file (git-checkpoint plan step 19).
 *
 * Two properties matter more than the plumbing:
 *
 *  - **One writer (D19).** Prefs are the source; this file is a projection. A
 *    prefs change rewrites exactly this file and nothing else.
 *  - **Never repair on parse failure (AGENTS rule 5).** A malformed document
 *    throws and its bytes survive.
 */

const PROFILE = "/home/ada/.pi/agent";

/** An in-memory fs that records the order of side effects. */
function memoryFs(initial: Record<string, string> = {}): CheckpointConfigFs & {
  files: Map<string, string>;
  calls: string[];
  modes: Map<string, number>;
} {
  const files = new Map(Object.entries(initial));
  const modes = new Map<string, number>();
  const calls: string[] = [];
  return {
    files,
    calls,
    modes,
    async readTextFile(target) {
      return files.get(target) ?? null;
    },
    async writeTextFile(target, contents) {
      calls.push(`write ${target}`);
      files.set(target, contents);
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      const contents = files.get(from);
      if (contents === undefined) throw new Error(`rename: missing ${from}`);
      files.delete(from);
      files.set(to, contents);
      const mode = modes.get(from);
      if (mode !== undefined) modes.set(to, mode);
    },
    async ensureDir(target) {
      calls.push(`ensureDir ${target}`);
    },
    async chmod(target, mode) {
      modes.set(target, mode);
    },
  };
}

describe("layout", () => {
  it("puts the config file inside the profile's checkpoints directory", () => {
    expect(checkpointConfigPath(PROFILE)).toBe(`${PROFILE}/checkpoints/${CHECKPOINT_CONFIG_FILE}`);
    expect(CHECKPOINT_CONFIG_FILE).toBe("config.json");
  });
});

describe("readConfig", () => {
  it("returns the defaults when the file is missing", async () => {
    const result = await readConfig({ fs: memoryFs(), profileDir: PROFILE });
    expect(result.source).toBe("missing");
    expect(result.config).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });

  it("reads and sanitises a file the projection wrote", async () => {
    const fs = memoryFs({
      [`${PROFILE}/checkpoints/config.json`]: JSON.stringify({
        enabled: false,
        maxPerSession: 12,
        exclude: ["*.psd"],
        // Not a checkpoint key: a foreign document must not smuggle state in.
        somethingElse: true,
      }),
    });
    const result = await readConfig({ fs, profileDir: PROFILE });
    expect(result.source).toBe("file");
    expect(result.config).toMatchObject({ enabled: false, maxPerSession: 12, exclude: ["*.psd"] });
    expect(result.config).not.toHaveProperty("somethingElse");
    // Untouched keys fall back to their defaults rather than to zero/undefined.
    expect(result.config.retentionDays).toBe(DEFAULT_CHECKPOINT_CONFIG.retentionDays);
  });

  it("clamps out-of-range numbers from a hand-edited file", async () => {
    const fs = memoryFs({
      [`${PROFILE}/checkpoints/config.json`]: JSON.stringify({
        maxPerSession: 1e9,
        retentionDays: -5,
        scanIntervalMs: 1,
      }),
    });
    const { config } = await readConfig({ fs, profileDir: PROFILE });
    expect(config.maxPerSession).toBe(1000);
    expect(config.retentionDays).toBe(1);
    // The idle-scan floor: a scan every millisecond is never useful.
    expect(config.scanIntervalMs).toBe(60_000);
  });

  it("throws on malformed JSON and keeps the file exactly as it was", async () => {
    const broken = '{ "enabled": true, ';
    const target = `${PROFILE}/checkpoints/config.json`;
    const fs = memoryFs({ [target]: broken });
    await expect(readConfig({ fs, profileDir: PROFILE })).rejects.toBeInstanceOf(
      CheckpointConfigError,
    );
    // The whole point: the bytes survive, and nothing was written or renamed.
    expect(fs.files.get(target)).toBe(broken);
    expect(fs.calls).toEqual([]);
  });

  it("rejects a document that parses but is not an object", async () => {
    const fs = memoryFs({ [`${PROFILE}/checkpoints/config.json`]: '"nope"' });
    const { config } = await readConfig({ fs, profileDir: PROFILE });
    // A JSON string is not a config; the sanitizer supplies the defaults.
    expect(config).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });
});

describe("writeConfig", () => {
  it("writes atomically through a temp file in the same directory", async () => {
    const fs = memoryFs();
    const written = await writeConfig(
      { fs, profileDir: PROFILE, token: () => "abc" },
      { ...DEFAULT_CHECKPOINT_CONFIG, maxPerSession: 7 },
    );
    const target = checkpointConfigPath(PROFILE);
    expect(written.maxPerSession).toBe(7);
    expect(fs.calls).toEqual([
      `ensureDir ${PROFILE}/checkpoints`,
      `write ${target}.abc.tmp`,
      `rename ${target}.abc.tmp -> ${target}`,
    ]);
    expect(fs.files.get(target)).toContain('"maxPerSession": 7');
    // No temp file survives the rename.
    expect([...fs.files.keys()]).toEqual([target]);
  });

  it("marks the file 0600 where the platform has modes", async () => {
    const fs = memoryFs();
    await writeConfig({ fs, profileDir: PROFILE, token: () => "t" }, DEFAULT_CHECKPOINT_CONFIG);
    expect(fs.modes.get(checkpointConfigPath(PROFILE))).toBe(0o600);
  });

  it("sanitises before writing, so a hand-built object cannot escape the clamps", async () => {
    const fs = memoryFs();
    const written = await writeConfig({ fs, profileDir: PROFILE }, {
      ...DEFAULT_CHECKPOINT_CONFIG,
      retentionDays: 0,
      maxPerSession: Number.NaN,
    } as never);
    expect(written.retentionDays).toBe(1);
    expect(written.maxPerSession).toBe(DEFAULT_CHECKPOINT_CONFIG.maxPerSession);
  });

  it("round-trips through readConfig without a lossy field", async () => {
    const fs = memoryFs();
    const original = {
      ...DEFAULT_CHECKPOINT_CONFIG,
      exclude: [...DEFAULT_EXCLUDES.slice(0, 2), "*.iso"],
      enabled: false,
    };
    await writeConfig({ fs, profileDir: PROFILE }, original);
    const { config } = await readConfig({ fs, profileDir: PROFILE });
    expect(config).toEqual(original);
  });

  it("serialises with a stable key order and one trailing newline", () => {
    const text = serializeConfig(DEFAULT_CHECKPOINT_CONFIG);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(Object.keys(DEFAULT_CHECKPOINT_CONFIG));
  });
});

describe("configFromPrefs", () => {
  it("accepts a full prefs.checkpoints object", () => {
    const config = configFromPrefs({ ...DEFAULT_CHECKPOINT_CONFIG, maxPerSession: 42 });
    expect(config.maxPerSession).toBe(42);
  });

  it("treats anything else as the defaults", () => {
    expect(configFromPrefs(undefined)).toEqual(DEFAULT_CHECKPOINT_CONFIG);
    expect(configFromPrefs(null)).toEqual(DEFAULT_CHECKPOINT_CONFIG);
    expect(configFromPrefs([1, 2, 3])).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });
});

describe("projectConfigFromPrefs (D19: one writer)", () => {
  it("writes the file when prefs change", async () => {
    const fs = memoryFs();
    const result = await projectConfigFromPrefs(
      { fs, profileDir: PROFILE, token: () => "t" },
      { ...DEFAULT_CHECKPOINT_CONFIG, retentionDays: 3 },
    );
    expect(result.wrote).toBe(true);
    expect(result.config.retentionDays).toBe(3);
    expect(fs.files.get(checkpointConfigPath(PROFILE))).toContain('"retentionDays": 3');
  });

  it("does not touch the file when the projected document is unchanged", async () => {
    const fs = memoryFs();
    await projectConfigFromPrefs(
      { fs, profileDir: PROFILE, token: () => "a" },
      DEFAULT_PREFS.checkpoints,
    );
    fs.calls.length = 0;
    // A rail-width drag fires `prefs.set` repeatedly; none of them may rewrite
    // the checkpoint config.
    const again = await projectConfigFromPrefs(
      { fs, profileDir: PROFILE, token: () => "b" },
      { ...DEFAULT_PREFS.checkpoints },
    );
    expect(again.wrote).toBe(false);
    expect(fs.calls).toEqual([]);
  });

  it("replaces a malformed file only on a real prefs change", async () => {
    const target = checkpointConfigPath(PROFILE);
    const fs = memoryFs({ [target]: "{ not json" });
    // Reading it is the extension's problem, and it reports failure; a prefs
    // write is the explicit signal that the user changed a checkpoint value, so
    // that write is what replaces the broken document.
    const result = await projectConfigFromPrefs(
      { fs, profileDir: PROFILE, token: () => "t" },
      { ...DEFAULT_CHECKPOINT_CONFIG, enabled: false },
    );
    expect(result.wrote).toBe(true);
    expect(JSON.parse(fs.files.get(target) ?? "{}")).toMatchObject({ enabled: false });
  });

  it("writes exactly one file (the projection, never app-state.json)", async () => {
    const fs = memoryFs();
    await projectConfigFromPrefs({ fs, profileDir: PROFILE }, DEFAULT_PREFS.checkpoints);
    const written = [...fs.files.keys()];
    expect(written).toEqual([checkpointConfigPath(PROFILE)]);
  });
});

describe("prefs plumbing", () => {
  it("defaults checkpoints on, with every cap", () => {
    expect(DEFAULT_PREFS.checkpoints).toEqual(DEFAULT_CHECKPOINT_CONFIG);
    // A fresh object: mutating the prefs value must not mutate the shared config.
    expect(DEFAULT_PREFS.checkpoints).not.toBe(DEFAULT_CHECKPOINT_CONFIG);
  });

  it("survives a missing key in an older app-state.json", () => {
    expect(sanitizePrefs({ theme: "light" }).checkpoints).toEqual(DEFAULT_CHECKPOINT_CONFIG);
  });

  it("drops an unknown key and clamps a known one", () => {
    const result = sanitizePrefs({
      checkpoints: { enabled: false, maxPerSession: -1, bogus: true },
    });
    expect(result.checkpoints.enabled).toBe(false);
    expect(result.checkpoints.maxPerSession).toBe(1);
    expect(result.checkpoints).not.toHaveProperty("bogus");
  });

  it("merges a partial patch without losing the other values", () => {
    const current = sanitizePrefs({
      checkpoints: { ...DEFAULT_CHECKPOINT_CONFIG, retentionDays: 9, exclude: ["*.psd"] },
    });
    const next = mergePrefs(current, { checkpoints: { enabled: false } });
    expect(next.checkpoints).toMatchObject({
      enabled: false,
      retentionDays: 9,
      exclude: ["*.psd"],
    });
  });
});
