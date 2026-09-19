import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { createMemoryFsPort } from "../../src/main/fs-port";
import {
  SettingsParseError,
  addPackageToSettings,
  backupFile,
  hasPackageSource,
  readPackageEntries,
  readSettingsDocument,
  removePackageFromSettings,
  removePackageSource,
  upsertPackageSource,
} from "../../src/main/packages/settings";

const AGENT_DIR = path.join("C:", "agent");
const SETTINGS = path.join(AGENT_DIR, "settings.json");

describe("upsertPackageSource", () => {
  it("appends a new package", () => {
    const result = upsertPackageSource(["npm:pi-lens"], "npm:@dieulc/pi-office-bridge@^0.4.1");
    expect(result.action).toBe("added");
    expect(result.previousSource).toBeNull();
    expect(result.packages).toEqual(["npm:pi-lens", "npm:@dieulc/pi-office-bridge@^0.4.1"]);
  });

  it("replaces the version of an existing package", () => {
    const result = upsertPackageSource(
      ["npm:pi-lens@4.2.1", "npm:@dieulc/pi-office-bridge"],
      "npm:@dieulc/pi-office-bridge@^0.4.1",
    );
    expect(result.action).toBe("replaced");
    expect(result.previousSource).toBe("npm:@dieulc/pi-office-bridge");
    expect(result.packages[1]).toBe("npm:@dieulc/pi-office-bridge@^0.4.1");
    expect(result.packages[0]).toBe("npm:pi-lens@4.2.1");
  });

  it("preserves per-package filters when re-pinning an object entry", () => {
    const entry = {
      source: "npm:@dieulc/pi-office-bridge",
      skills: [],
      extensions: ["extensions/*.ts"],
    };
    const result = upsertPackageSource([entry], "npm:@dieulc/pi-office-bridge@^0.4.1");
    expect(result.packages[0]).toEqual({
      source: "npm:@dieulc/pi-office-bridge@^0.4.1",
      skills: [],
      extensions: ["extensions/*.ts"],
    });
  });

  it("is idempotent", () => {
    const result = upsertPackageSource(
      ["npm:@dieulc/pi-office-bridge@^0.4.1"],
      "npm:@dieulc/pi-office-bridge@^0.4.1",
    );
    expect(result.action).toBe("unchanged");
    expect(result.packages).toHaveLength(1);
  });

  it("keeps unparseable entries untouched", () => {
    const result = upsertPackageSource([42 as unknown as string, "npm:pi-lens"], "npm:pi-memory");
    expect(result.packages).toHaveLength(3);
    expect(result.packages[0]).toBe(42);
  });
});

describe("removePackageSource / hasPackageSource", () => {
  it("removes by identity regardless of version", () => {
    const result = removePackageSource(
      ["npm:pi-lens", "npm:@dieulc/pi-office-bridge@^0.4.1", "npm:pi-memory"],
      "npm:@dieulc/pi-office-bridge",
    );
    expect(result.removed).toEqual(["npm:@dieulc/pi-office-bridge@^0.4.1"]);
    expect(result.packages).toEqual(["npm:pi-lens", "npm:pi-memory"]);
  });

  it("detects presence by identity", () => {
    expect(hasPackageSource(["npm:pi-lens@4.2.1"], "pi-lens")).toBe(true);
    expect(hasPackageSource(["npm:pi-lens"], "npm:pi-memory")).toBe(false);
  });
});

describe("readSettingsDocument", () => {
  it("returns an empty document when the file is missing", async () => {
    const fs = createMemoryFsPort();
    expect(await readSettingsDocument(fs, SETTINGS)).toEqual({});
  });

  it("refuses to touch invalid JSON", async () => {
    const fs = createMemoryFsPort({ files: { [SETTINGS]: "{ not json" } });
    await expect(readSettingsDocument(fs, SETTINGS)).rejects.toBeInstanceOf(SettingsParseError);
  });

  it("rejects a non-object root", async () => {
    const fs = createMemoryFsPort({ files: { [SETTINGS]: "[1,2,3]" } });
    await expect(readSettingsDocument(fs, SETTINGS)).rejects.toBeInstanceOf(SettingsParseError);
  });
});

describe("addPackageToSettings", () => {
  it("creates settings.json and preserves unrelated keys", async () => {
    const fs = createMemoryFsPort({
      files: {
        [SETTINGS]: JSON.stringify({ theme: "dark", compaction: { enabled: true } }, null, 2),
      },
    });

    const result = await addPackageToSettings(fs, SETTINGS, "npm:@dieulc/pi-office-bridge@^0.4.1");
    expect(result.changed).toBe(true);
    expect(result.action).toBe("added");

    const written = await fs.readTextFile(SETTINGS);
    expect(written).not.toBeNull();
    const parsed = JSON.parse(written ?? "{}") as Record<string, unknown>;
    expect(parsed.theme).toBe("dark");
    expect(parsed.compaction).toEqual({ enabled: true });
    expect(parsed.packages).toEqual(["npm:@dieulc/pi-office-bridge@^0.4.1"]);
    expect(written?.endsWith("\n")).toBe(true);
    // Atomic write leaves no temp file behind.
    expect([...fs.files.keys()].some((key) => key.includes(".tmp"))).toBe(false);
  });

  it("is a no-op on the second call", async () => {
    const fs = createMemoryFsPort();
    await addPackageToSettings(fs, SETTINGS, "npm:@dieulc/pi-office-bridge@^0.4.1");
    const second = await addPackageToSettings(fs, SETTINGS, "npm:@dieulc/pi-office-bridge@^0.4.1");
    expect(second.changed).toBe(false);
    expect(second.action).toBe("unchanged");
    expect(readPackageEntries(JSON.parse((await fs.readTextFile(SETTINGS)) ?? "{}"))).toHaveLength(
      1,
    );
  });

  it("does not modify the file when settings.json is invalid", async () => {
    const broken = "{ broken";
    const fs = createMemoryFsPort({ files: { [SETTINGS]: broken } });
    await expect(
      addPackageToSettings(fs, SETTINGS, "npm:@dieulc/pi-office-bridge@^0.4.1"),
    ).rejects.toBeInstanceOf(SettingsParseError);
    expect(await fs.readTextFile(SETTINGS)).toBe(broken);
  });
});

describe("removePackageFromSettings", () => {
  it("removes the package and reports it", async () => {
    const fs = createMemoryFsPort({
      files: {
        [SETTINGS]: JSON.stringify({
          packages: ["npm:pi-lens", "npm:@dieulc/pi-office-bridge@^0.4.1"],
        }),
      },
    });
    const result = await removePackageFromSettings(fs, SETTINGS, "@dieulc/pi-office-bridge");
    expect(result.changed).toBe(true);
    expect(result.removed).toEqual(["npm:@dieulc/pi-office-bridge@^0.4.1"]);
    expect(readPackageEntries(JSON.parse((await fs.readTextFile(SETTINGS)) ?? "{}"))).toEqual([
      "npm:pi-lens",
    ]);
  });
});

describe("backupFile", () => {
  it("copies the file into the backup directory", async () => {
    const backupDir = path.join(AGENT_DIR, "backups");
    const fs = createMemoryFsPort({ files: { [SETTINGS]: "{}" } });
    const target = await backupFile(fs, SETTINGS, backupDir, "2026-09-18T00-00-00-000Z");
    expect(target).toBe(path.join(backupDir, "settings.json.2026-09-18T00-00-00-000Z.bak"));
    expect(await fs.readTextFile(target ?? "")).toBe("{}");
  });

  it("returns null when the file does not exist", async () => {
    const fs = createMemoryFsPort();
    expect(await backupFile(fs, SETTINGS, path.join(AGENT_DIR, "backups"), "x")).toBeNull();
  });
});
