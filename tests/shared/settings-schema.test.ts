import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDocsPath } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  SETTINGS_FIELDS,
  SETTINGS_GROUPS,
  deleteSettingsValue,
  diffSettingsDocument,
  findSettingsField,
  flattenSettingsDocument,
  getSettingsValue,
  groupSettingsFields,
  mergeSettingsScopes,
  parseSettingsJson,
  setSettingsValue,
  settingsDefaultsDocument,
  splitSettingsKey,
  validateSettingsValue,
} from "../../src/shared/settings-schema";

/**
 * The settings schema must not drift from Pi (plan step 12). Pi's own
 * `docs/settings.md` is the source of truth: this test reads it through the
 * SDK's exported `getDocsPath()` and fails when a documented key is missing from
 * the table (or when the table invents a key Pi does not document).
 */

/** Extracts the backticked first-column keys from the "All Settings" section. */
function documentedKeys(markdown: string): string[] {
  const start = markdown.indexOf("## All Settings");
  const end = markdown.indexOf("## Project Overrides");
  const section = markdown.slice(start === -1 ? 0 : start, end === -1 ? undefined : end);
  const keys: string[] = [];
  for (const line of section.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}

describe("settings schema", () => {
  it("covers every key documented in Pi's docs/settings.md", async () => {
    const markdown = await readFile(join(getDocsPath(), "settings.md"), "utf8");
    const documented = documentedKeys(markdown);
    expect(documented.length).toBeGreaterThan(50);

    const schemaKeys = new Set(SETTINGS_FIELDS.map((field) => field.key));
    const missing = documented.filter((key) => !schemaKeys.has(key));
    expect(missing, "documented keys missing from the schema").toEqual([]);
  });

  it("does not invent a key Pi does not document", async () => {
    const markdown = await readFile(join(getDocsPath(), "settings.md"), "utf8");
    const documented = new Set(documentedKeys(markdown));
    const invented = SETTINGS_FIELDS.filter((field) => !documented.has(field.key)).map(
      (field) => field.key,
    );
    expect(invented, "schema keys absent from Pi's docs").toEqual([]);
  });

  it("has unique keys and every field belongs to a declared group", () => {
    const keys = SETTINGS_FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
    const groups = new Set(SETTINGS_GROUPS.map((group) => group.id));
    for (const field of SETTINGS_FIELDS) {
      expect(groups.has(field.group), `${field.key} has group ${field.group}`).toBe(true);
    }
  });

  it("keeps global-only keys global", () => {
    for (const key of ["httpProxy", "defaultProjectTrust", "cacheWarming"]) {
      expect(findSettingsField(key)?.scope, key).toBe("global");
    }
    expect(findSettingsField("compaction.reserveTokens")?.scope).toBe("both");
  });

  it("groups fields without dropping any", () => {
    const grouped = groupSettingsFields().flatMap((entry) => entry.fields);
    expect(grouped.length).toBe(SETTINGS_FIELDS.length);
  });

  it("splits and reads dotted keys", () => {
    expect(splitSettingsKey("retry.provider.timeoutMs")).toEqual([
      "retry",
      "provider",
      "timeoutMs",
    ]);
    const document = { retry: { provider: { maxRetries: 0 } }, theme: "dark" };
    expect(getSettingsValue(document, "retry.provider.maxRetries")).toBe(0);
    expect(getSettingsValue(document, "retry.provider.missing")).toBeUndefined();
    expect(getSettingsValue(document, "missing.deep.path")).toBeUndefined();
  });

  it("sets and deletes nested keys without mutating the input", () => {
    const original = { compaction: { enabled: true }, theme: "dark" };
    const withReserve = setSettingsValue(original, "compaction.reserveTokens", 8192);
    expect(withReserve).toEqual({
      compaction: { enabled: true, reserveTokens: 8192 },
      theme: "dark",
    });
    expect(original).toEqual({ compaction: { enabled: true }, theme: "dark" });

    const removed = deleteSettingsValue(withReserve, "compaction.enabled");
    expect(removed).toEqual({ compaction: { reserveTokens: 8192 }, theme: "dark" });
  });

  it("prunes empty intermediate objects on delete", () => {
    const document = { branchSummary: { skipPrompt: false } };
    expect(deleteSettingsValue(document, "branchSummary.skipPrompt")).toEqual({});
  });

  it("flattens only leaves", () => {
    expect(flattenSettingsDocument({ a: 1, b: { c: true, d: { e: "x" } }, f: [1, 2] })).toEqual({
      a: 1,
      "b.c": true,
      "b.d.e": "x",
      f: [1, 2],
    });
  });

  it("merges scopes with nested-merge semantics", () => {
    const merged = mergeSettingsScopes(
      { theme: "dark", compaction: { enabled: true, reserveTokens: 16384 } },
      { compaction: { reserveTokens: 8192 } },
    );
    expect(merged).toEqual({
      theme: "dark",
      compaction: { enabled: true, reserveTokens: 8192 },
    });
  });

  it("builds the documented defaults and diffs against them", () => {
    const defaults = settingsDefaultsDocument();
    expect(getSettingsValue(defaults, "compaction.reserveTokens")).toBe(16384);
    expect(getSettingsValue(defaults, "theme")).toBe("dark");

    // No diff when the document equals the defaults.
    expect(diffSettingsDocument(defaults)).toEqual([]);
    // A changed value and an unset non-default are both reported.
    const changed = setSettingsValue(defaults, "theme", "light");
    const entries = diffSettingsDocument(changed);
    expect(entries).toEqual([{ key: "theme", value: "light", defaultValue: "dark" }]);
  });

  it("validates booleans, numbers, enums and lists", () => {
    const boolean = findSettingsField("compaction.enabled");
    const reserve = findSettingsField("compaction.reserveTokens");
    const trust = findSettingsField("defaultProjectTrust");
    const extensions = findSettingsField("extensions");
    expect(boolean && reserve && trust && extensions).toBeTruthy();
    if (!boolean || !reserve || !trust || !extensions) return;

    expect(validateSettingsValue(boolean, true)).toEqual({ ok: true, value: true });
    expect(validateSettingsValue(boolean, "yes").ok).toBe(false);
    expect(validateSettingsValue(reserve, "8192")).toEqual({ ok: true, value: 8192 });
    expect(validateSettingsValue(reserve, "not-a-number").ok).toBe(false);
    expect(validateSettingsValue(trust, "always")).toEqual({ ok: true, value: "always" });
    expect(validateSettingsValue(trust, "sometimes").ok).toBe(false);
    expect(validateSettingsValue(extensions, ["a", "b"])).toEqual({
      ok: true,
      value: ["a", "b"],
    });
    expect(validateSettingsValue(extensions, "a").ok).toBe(false);
  });

  it("treats empty values as unset and clamps numeric ranges", () => {
    const padding = findSettingsField("editorPaddingX");
    expect(padding).toBeTruthy();
    if (!padding) return;
    expect(validateSettingsValue(padding, "")).toEqual({ ok: true, value: undefined });
    expect(validateSettingsValue(padding, null)).toEqual({ ok: true, value: undefined });
    expect(validateSettingsValue(padding, 4).ok).toBe(false);
    expect(validateSettingsValue(padding, -1).ok).toBe(false);
  });

  it("parses raw JSON text", () => {
    expect(parseSettingsJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseSettingsJson("   ")).toEqual({ ok: true, value: undefined });
    expect(parseSettingsJson("{oops").ok).toBe(false);
  });
});
