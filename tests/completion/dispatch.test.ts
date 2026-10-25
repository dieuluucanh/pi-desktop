import { describe, expect, it } from "vitest";
import {
  appCommandNames,
  findCommandCollisions,
  isKnownHostCommand,
  resolveCommandInput,
} from "../../src/renderer/src/completion/dispatch";
import type { HostCommandEntry } from "../../src/renderer/src/completion/command-source";

/**
 * The dispatch table (plan step 7): which `/…` input becomes an app action, which
 * one goes through `prompt` for the SDK to expand, and which one is a typo that
 * must never be sent to the model as prose.
 */

const HOST_COMMANDS: HostCommandEntry[] = [
  { name: "deploy", description: "Deploy", source: "extension" },
  { name: "model", description: "Extension that claims /model", source: "extension" },
  { name: "settings", description: "Template that claims /settings", source: "prompt" },
  { name: "skill:review", description: "Review the diff", source: "skill" },
];

describe("resolution", () => {
  it("hands app commands to the app", () => {
    const result = resolveCommandInput("/new", { hostCommands: HOST_COMMANDS });
    expect(result.kind).toBe("app");
    if (result.kind === "app")
      expect(result.command.action).toEqual({
        kind: "host",
        method: "session.new",
      });
  });

  it("passes a name to the command's parameters", () => {
    const result = resolveCommandInput("/name My session", { hostCommands: [] });
    expect(result.kind).toBe("app");
    if (result.kind === "app") {
      expect(result.argument).toBe("My session");
      expect(
        result.command.action.kind === "host" && result.command.action.params?.("My session"),
      ).toEqual({ name: "My session" });
    }
  });

  it("sends extension commands, templates and skills to the prompt", () => {
    for (const name of ["deploy", "skill:review"]) {
      const result = resolveCommandInput(`/${name}`, { hostCommands: HOST_COMMANDS });
      expect(result.kind, name).toBe("host");
    }
  });

  it("reports an unknown command instead of guessing", () => {
    const result = resolveCommandInput("/zzz", { hostCommands: HOST_COMMANDS });
    expect(result).toEqual({ kind: "unknown", name: "zzz", argument: "" });
  });

  it("leaves ordinary text alone", () => {
    expect(resolveCommandInput("please fix the bug", { hostCommands: HOST_COMMANDS })).toEqual({
      kind: "not-a-command",
    });
  });
});

describe("collisions", () => {
  it("lists both sides for a name the app reserves", () => {
    const result = resolveCommandInput("/model", { hostCommands: HOST_COMMANDS });
    // Dispatch prefers the app's own command…
    expect(result.kind).toBe("app");

    // …but an explicit pick from the completion list wins, which is how the
    // palette disambiguates two entries that share a name.
    const picked = resolveCommandInput("/model", {
      hostCommands: HOST_COMMANDS,
      preferredSource: "extension",
    });
    expect(picked.kind).toBe("host");
    if (picked.kind === "host") expect(picked.command.source).toBe("extension");
  });

  it("ignores a preferred source that does not own the name", () => {
    const result = resolveCommandInput("/new", {
      hostCommands: HOST_COMMANDS,
      preferredSource: "extension",
    });
    expect(result.kind).toBe("app");
  });

  it("reports the names both sides claim", () => {
    const collisions = findCommandCollisions(HOST_COMMANDS);
    expect(collisions.map((entry) => entry.name).sort()).toEqual(["model", "settings"]);
  });

  it("does not report a host entry that is itself app-sourced", () => {
    expect(findCommandCollisions([{ name: "model", source: "app" }])).toEqual([]);
  });

  it("knows which names the host can resolve", () => {
    expect(isKnownHostCommand("deploy", HOST_COMMANDS)).toBe(true);
    expect(isKnownHostCommand("nope", HOST_COMMANDS)).toBe(false);
  });
});

describe("help", () => {
  it("lists the app's reserved commands", () => {
    const names = appCommandNames();
    expect(names).toContain("/new");
    expect(names).toContain("/model");
    expect(names.every((name) => name.startsWith("/"))).toBe(true);
  });

  it("reports the picker for a reserved command it can now run", () => {
    for (const name of ["/model", "/thinking"]) {
      const result = resolveCommandInput(name, { hostCommands: [] });
      expect(result.kind, name).toBe("app");
      if (result.kind === "app") expect(result.command.action.kind, name).toBe("picker");
    }
  });

  it("reserves /scoped-models as the unified scope editor", () => {
    const result = resolveCommandInput("/scoped-models", { hostCommands: [] });
    expect(result.kind).toBe("app");
    if (result.kind === "app") expect(result.command.action.kind).toBe("scope");
    expect(appCommandNames()).toContain("/scoped-models");
  });

  it("routes the session-history commands to their dialogs (plan step 11)", () => {
    const expected: Record<string, string> = {
      "/resume": "browser",
      "/tree": "tree",
      "/fork": "fork",
      "/export": "export",
    };
    for (const [name, kind] of Object.entries(expected)) {
      const result = resolveCommandInput(name, { hostCommands: [] });
      expect(result.kind, name).toBe("app");
      if (result.kind === "app") expect(result.command.action.kind, name).toBe(kind);
    }
  });

  it("routes /trust to the project trust prompt (plan step 10)", () => {
    const result = resolveCommandInput("/trust", { hostCommands: [] });
    expect(result.kind).toBe("app");
    if (result.kind === "app") expect(result.command.action.kind).toBe("trust");
  });
});
