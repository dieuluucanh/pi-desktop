import { describe, expect, it } from "vitest";

import {
  BACKUP_VERSION,
  backupFileName,
  isEditorBackupExpired,
  isSafeBackupTabId,
  parseEditorBackup,
  sanitizeEditorBackup,
  serializeEditorBackup,
} from "../../src/workspace/backup";
import { MAX_BACKUP_AGE_MS, type EditorBackup } from "../../src/shared/workspace";

function backup(overrides: Partial<EditorBackup> = {}): EditorBackup {
  return {
    version: BACKUP_VERSION,
    tabId: "tab-1",
    projectPath: "C:/work/app",
    path: "src/app.ts",
    text: "const x = 1;\n",
    updatedAt: 1_000,
    baselineMtimeMs: 999,
    eol: "lf",
    bom: false,
    ...overrides,
  };
}

describe("backup records", () => {
  it("accepts safe tab ids and rejects path-like ones", () => {
    expect(isSafeBackupTabId("tab-1")).toBe(true);
    expect(isSafeBackupTabId("a_b-C9")).toBe(true);
    expect(isSafeBackupTabId("../tab-1")).toBe(false);
    expect(isSafeBackupTabId("tab/1")).toBe(false);
    expect(isSafeBackupTabId("")).toBe(false);
    expect(() => backupFileName("../x")).toThrow();
    expect(backupFileName("tab-1")).toBe("tab-1.json");
  });

  it("sanitizes a good record and rejects bad shapes", () => {
    expect(sanitizeEditorBackup(backup())).toEqual(backup());
    expect(sanitizeEditorBackup(null)).toBeNull();
    expect(sanitizeEditorBackup({ ...backup(), version: 2 })).toBeNull();
    expect(sanitizeEditorBackup({ ...backup(), path: "../x" })).toBeNull();
    expect(sanitizeEditorBackup({ ...backup(), tabId: "../x" })).toBeNull();
    expect(sanitizeEditorBackup({ ...backup(), eol: "cr" })).toBeNull();
    expect(sanitizeEditorBackup({ ...backup(), text: 42 })).toBeNull();
  });

  it("round-trips through serialization and parsing", () => {
    const json = serializeEditorBackup(backup());
    expect(json).not.toBeNull();
    expect(parseEditorBackup(json)).toEqual(backup());
    expect(parseEditorBackup("not json")).toBeNull();
    expect(parseEditorBackup(null)).toBeNull();
  });

  it("flags old backups", () => {
    expect(isEditorBackupExpired(backup(), 1_000 + MAX_BACKUP_AGE_MS)).toBe(false);
    expect(isEditorBackupExpired(backup(), 1_000 + MAX_BACKUP_AGE_MS + 1)).toBe(true);
  });
});
