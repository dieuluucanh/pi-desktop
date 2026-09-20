import { describe, expect, it } from "vitest";
import {
  describeSettingsValue,
  formatSettingsDraft,
  parseSettingsDraft,
  settingsDiffForScope,
  settingsValueProvenance,
  splitAdvancedFields,
} from "../../src/shared/settings-view";
import {
  findSettingsField,
  SETTINGS_FIELDS,
  settingsDefaultsDocument,
} from "../../src/shared/settings-schema";

/**
 * Pure settings-editor helpers (plan step 12). These have no DOM, so the node
 * project checks the provenance, draft parsing and diff logic that the view
 * relies on.
 */

const scopes = (global: Record<string, unknown>, project: Record<string, unknown> = {}) => ({
  global,
  project,
});
const defaults = settingsDefaultsDocument();

function field(key: string) {
  const found = findSettingsField(key);
  if (!found) throw new Error(`missing field ${key}`);
  return found;
}

describe("settingsValueProvenance", () => {
  it("prefers project, then global, then the default", () => {
    expect(
      settingsValueProvenance(
        field("theme"),
        scopes({ theme: "dark" }, { theme: "light" }),
        defaults,
      ).source,
    ).toBe("project");
    expect(
      settingsValueProvenance(field("theme"), scopes({ theme: "dark" }), defaults).source,
    ).toBe("global");
    expect(settingsValueProvenance(field("theme"), scopes({}), defaults)).toMatchObject({
      source: "default",
      effective: "dark",
    });
    expect(settingsValueProvenance(field("httpProxy"), scopes({}), defaults).source).toBe("unset");
  });

  it("reports nested values from both scopes", () => {
    const provenance = settingsValueProvenance(
      field("compaction.reserveTokens"),
      scopes({ compaction: { reserveTokens: 16384 } }, { compaction: { reserveTokens: 8192 } }),
      defaults,
    );
    expect(provenance.global).toBe(16384);
    expect(provenance.project).toBe(8192);
    expect(provenance.effective).toBe(8192);
  });
});

describe("formatSettingsDraft / parseSettingsDraft", () => {
  it("round-trips a string and a number", () => {
    expect(formatSettingsDraft(field("theme"), "dark")).toBe("dark");
    expect(parseSettingsDraft(field("theme"), "light")).toEqual({ ok: true, value: "light" });
    expect(formatSettingsDraft(field("editorPaddingX"), 2)).toBe("2");
    expect(parseSettingsDraft(field("editorPaddingX"), "3")).toEqual({ ok: true, value: 3 });
  });

  it("treats an empty draft as unset", () => {
    expect(parseSettingsDraft(field("theme"), "   ")).toEqual({ ok: true, value: undefined });
  });

  it("parses a string list one entry per line", () => {
    expect(formatSettingsDraft(field("enabledModels"), ["claude-*", "gpt-4o"])).toBe(
      "claude-*\ngpt-4o",
    );
    expect(parseSettingsDraft(field("enabledModels"), "claude-*\n\ngpt-4o\n")).toEqual({
      ok: true,
      value: ["claude-*", "gpt-4o"],
    });
  });

  it("parses JSON fields and reports invalid text", () => {
    const json = field("packages");
    expect(formatSettingsDraft(json, [{ source: "pi-skills" }])).toContain('"pi-skills"');
    expect(parseSettingsDraft(json, '[{"source":"pi-skills"}]')).toEqual({
      ok: true,
      value: [{ source: "pi-skills" }],
    });
    expect(parseSettingsDraft(json, "{nope").ok).toBe(false);
  });

  it("reports a validation error for a bad number or enum", () => {
    expect(parseSettingsDraft(field("editorPaddingX"), "9").ok).toBe(false);
    expect(parseSettingsDraft(field("defaultProjectTrust"), "sometimes").ok).toBe(false);
  });
});

describe("splitAdvancedFields", () => {
  it("splits a group without dropping fields", () => {
    const fields = SETTINGS_FIELDS.filter((entry) => entry.group === "retry");
    const { basic, advanced } = splitAdvancedFields(fields);
    expect(basic.length + advanced.length).toBe(fields.length);
    expect(advanced.map((entry) => entry.key)).toContain("retry.provider.maxRetries");
    expect(basic.map((entry) => entry.key)).toContain("retry.enabled");
  });
});

describe("settingsDiffForScope", () => {
  it("lists only the keys that differ from the defaults", () => {
    const entries = settingsDiffForScope(
      scopes({ theme: "light", compaction: { enabled: true } }),
      "global",
    );
    expect(entries).toEqual([{ key: "theme", value: "light", defaultValue: "dark" }]);
  });

  it("describes a value compactly", () => {
    expect(describeSettingsValue(undefined)).toBe("(unset)");
    expect(describeSettingsValue(true)).toBe("true");
    expect(describeSettingsValue({ a: 1 })).toBe('{"a":1}');
    expect(describeSettingsValue("x".repeat(100)).endsWith("…")).toBe(true);
  });
});
