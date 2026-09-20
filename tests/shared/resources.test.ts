import { describe, expect, it } from "vitest";
import {
  applyResourceOverride,
  basenameOf,
  findResource,
  isDisabledOverride,
  isOverrideEntry,
  normalizeOverrideToken,
  resourceIdOf,
  resourceOverrideEntry,
  sanitizeResourcesSnapshot,
  settingsScopeForResource,
  sortResources,
  toPosixPath,
  type ResourceSummary,
} from "../../src/shared/resources";

/**
 * The Extensions hub's pure model (plan step 13). Enable/disable is a settings
 * array edit, so the override helpers are the part that must be exactly right —
 * a wrong token would silently stop Pi from loading a resource.
 */

function resource(overrides: Partial<ResourceSummary> = {}): ResourceSummary {
  return {
    id: "extensions:C:/x/foo.ts",
    kind: "extensions",
    name: "foo",
    path: "C:\\x\\foo.ts",
    overridePath: "C:/x/foo.ts",
    source: "user",
    scope: "user",
    origin: "top-level",
    settingsKey: "extensions",
    enabled: true,
    ...overrides,
  };
}

describe("override helpers", () => {
  it("recognizes override prefixes and their polarity", () => {
    expect(isOverrideEntry("+C:/x")).toBe(true);
    expect(isOverrideEntry("-C:/x")).toBe(true);
    expect(isOverrideEntry("!C:/x")).toBe(true);
    expect(isOverrideEntry("C:/x")).toBe(false);
    expect(isDisabledOverride("-C:/x")).toBe(true);
    expect(isDisabledOverride("!C:/x")).toBe(true);
    expect(isDisabledOverride("+C:/x")).toBe(false);
  });

  it("normalizes separators and strips the prefix", () => {
    expect(normalizeOverrideToken("-C:\\x\\foo.ts")).toBe("C:/x/foo.ts");
    expect(toPosixPath("C:\\x\\foo.ts")).toBe("C:/x/foo.ts");
  });

  it("disables an exact resource with a -path entry and is idempotent", () => {
    const once = applyResourceOverride([], "C:\\x\\foo.ts", false);
    expect(once).toEqual(["-C:/x/foo.ts"]);
    expect(applyResourceOverride(once, "C:\\x\\foo.ts", false)).toEqual(["-C:/x/foo.ts"]);
    expect(applyResourceOverride(once, "C:/x/foo.ts", false)).toHaveLength(1);
  });

  it("re-enabling replaces the exclusion with a force-include", () => {
    const disabled = applyResourceOverride(["other"], "C:/x/foo.ts", false);
    expect(applyResourceOverride(disabled, "C:/x/foo.ts", true)).toEqual(["other", "+C:/x/foo.ts"]);
  });

  it("leaves unrelated entries and globs alone", () => {
    const entries = ["!C:/x/*.ts", "C:/keep", "+C:/keep"];
    expect(applyResourceOverride(entries, "C:/x/foo.ts", false)).toEqual([
      "!C:/x/*.ts",
      "C:/keep",
      "+C:/keep",
      "-C:/x/foo.ts",
    ]);
  });

  it("maps a resource to the settings scope and entry that toggles it", () => {
    expect(settingsScopeForResource("project")).toBe("project");
    expect(settingsScopeForResource("user")).toBe("global");
    expect(settingsScopeForResource("temporary")).toBe("global");
    expect(resourceOverrideEntry(resource())).toBe("-C:/x/foo.ts");
    expect(resourceOverrideEntry(resource({ enabled: false }))).toBe("+C:/x/foo.ts");
  });
});

describe("sanitizeResourcesSnapshot", () => {
  it("coerces a hostile payload into a usable snapshot", () => {
    const snapshot = sanitizeResourcesSnapshot({
      cwd: "C:\\project",
      scope: "session",
      resources: [
        {
          kind: "extensions",
          path: "C:\\p\\foo.ts",
          overridePath: "C:\\p\\foo.ts",
          source: "npm:foo",
          scope: "project",
          origin: "package",
          settingsKey: "extensions",
          enabled: true,
          contributed: [
            { kind: "tool", name: "do_thing", description: "does" },
            { kind: "bogus", name: "nope" },
          ],
        },
        { kind: "nonsense" },
        null,
      ],
      overrides: [{ kind: "skills", scope: "project", entry: "-C:/s/x" }, { kind: "skills" }],
      diagnostics: [{ type: "collision", message: "dup", collision: { name: "x" } }],
      runtimeErrors: [{ error: "boom", extensionPath: "p", event: "agent_end", at: 5 }],
      loadedAt: 12,
    });
    expect(snapshot.scope).toBe("session");
    expect(snapshot.resources).toHaveLength(1);
    expect(snapshot.resources[0]).toMatchObject({
      id: "extensions:C:/p/foo.ts",
      overridePath: "C:/p/foo.ts",
      name: "foo.ts",
      scope: "project",
      origin: "package",
      contributed: [{ kind: "tool", name: "do_thing", description: "does" }],
    });
    expect(snapshot.overrides).toEqual([{ kind: "skills", scope: "project", entry: "-C:/s/x" }]);
    expect(snapshot.diagnostics[0]).toMatchObject({
      type: "collision",
      collision: { resourceType: "extension", name: "x" },
    });
    expect(snapshot.runtimeErrors[0]).toMatchObject({ error: "boom", at: 5 });
    expect(snapshot.loadedAt).toBe(12);
  });

  it("never invents a resource from garbage", () => {
    expect(sanitizeResourcesSnapshot(null)).toMatchObject({
      cwd: null,
      scope: "control",
      resources: [],
      loadedAt: 0,
    });
    expect(sanitizeResourcesSnapshot("not an object").resources).toEqual([]);
  });

  it("defaults a missing overridePath and name from the path", () => {
    const [entry] = sanitizeResourcesSnapshot({
      resources: [{ kind: "skills", path: "C:\\s\\thing\\SKILL.md" }],
    }).resources;
    expect(entry?.name).toBe("SKILL.md");
    expect(entry?.overridePath).toBe("C:/s/thing/SKILL.md");
    expect(entry?.enabled).toBe(true);
  });
});

describe("display helpers", () => {
  it("sorts by kind then name without mutating the input", () => {
    const input = [
      resource({ kind: "themes", name: "z", id: "themes:z" }),
      resource({ kind: "extensions", name: "b", id: "extensions:b" }),
      resource({ kind: "extensions", name: "a", id: "extensions:a" }),
    ];
    expect(sortResources(input).map((entry) => entry.id)).toEqual([
      "extensions:a",
      "extensions:b",
      "themes:z",
    ]);
    expect(input[0]?.id).toBe("themes:z");
  });

  it("resolves ids and basenames", () => {
    expect(resourceIdOf("prompts", "C:\\p\\a.md")).toBe("prompts:C:/p/a.md");
    expect(basenameOf("C:\\a\\b\\c")).toBe("c");
    expect(basenameOf("C:/a/b/")).toBe("b");
    expect(findResource([resource()], "extensions:C:/x/foo.ts")?.name).toBe("foo");
    expect(findResource([resource()], "nope")).toBeUndefined();
  });
});
