import { describe, expect, it, vi } from "vitest";
import {
  createSettingsHandlers,
  effectiveSettingsValue,
  SettingsError,
  toSettingsErrorInfo,
  validateSettingsDocument,
} from "../../src/host/settings";
import { createFakeSettings } from "./fake-settings";

/**
 * The pure `settings.*` handlers (plan step 12). The port is faked, so these
 * tests pin the contract — validation, scope rules, what a write returns — while
 * `tests/host/sdk-settings.test.ts` pins the real file behaviour.
 */

function handlersFor(port: ReturnType<typeof createFakeSettings> | null) {
  return createSettingsHandlers({ resolvePort: () => port }).handlers();
}

describe("createSettingsHandlers", () => {
  it("returns both scopes, files, trust and errors", async () => {
    const port = createFakeSettings({
      errors: [{ scope: "project", message: "bad project key" }],
    });
    const result = (await handlersFor(port)["settings.get"]?.({}, {} as never)) as {
      settings: { global: Record<string, unknown>; project: Record<string, unknown> };
      files: { global: { path: string; mtimeMs: number } };
      projectTrusted: boolean;
      errors: unknown[];
    };
    expect(result.settings.global).toMatchObject({ theme: "dark" });
    expect(result.settings.project).toMatchObject({ defaultTools: ["read"] });
    expect(result.files.global.path).toBe(port.paths.global);
    expect(result.files.global.mtimeMs).toBeGreaterThan(0);
    expect(result.projectTrusted).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(port.reload).toHaveBeenCalledWith(null);
  });

  it("writes a validated value and returns the refreshed snapshot", async () => {
    const port = createFakeSettings();
    const result = (await handlersFor(port)["settings.set"]?.(
      { key: "theme", value: "light", scope: "global" },
      {} as never,
    )) as { settings: { global: Record<string, unknown> } };
    expect(port.write).toHaveBeenCalledWith(null, "theme", "light", "global");
    expect(result.settings.global.theme).toBe("light");
  });

  it("coerces numeric strings and deletes empty values", async () => {
    const port = createFakeSettings();
    const set = handlersFor(port)["settings.set"];
    await set?.({ key: "compaction.reserveTokens", value: "8192" }, {} as never);
    expect(port.write).toHaveBeenLastCalledWith(null, "compaction.reserveTokens", 8192, "global");
    await set?.({ key: "compaction.reserveTokens", value: "" }, {} as never);
    expect(port.write).toHaveBeenLastCalledWith(
      null,
      "compaction.reserveTokens",
      undefined,
      "global",
    );
  });

  it("forwards the project cwd to the port", async () => {
    const port = createFakeSettings();
    await handlersFor(port)["settings.set"]?.(
      { key: "theme", value: "light", scope: "project", cwd: "C:/work/app" },
      {} as never,
    );
    expect(port.write).toHaveBeenCalledWith("C:/work/app", "theme", "light", "project");
  });

  it("reloads the requested cwd before reporting a snapshot", async () => {
    const port = createFakeSettings();
    await handlersFor(port)["settings.get"]?.({ cwd: "C:/work/app" }, {} as never);
    expect(port.reload).toHaveBeenCalledWith("C:/work/app");

    port.scopes.global.theme = "light";
    const result = (await handlersFor(port)["settings.get"]?.({}, {} as never)) as {
      settings: { global: Record<string, unknown> };
    };
    expect(result.settings.global.theme).toBe("light");
  });

  it("refuses unknown keys, global-only project writes and invalid values", async () => {
    const port = createFakeSettings();
    const set = handlersFor(port)["settings.set"];
    await expect(set?.({ key: "nope", value: 1 }, {} as never)).rejects.toThrow(/unknown setting/i);
    await expect(
      set?.({ key: "httpProxy", value: "http://x", scope: "project" }, {} as never),
    ).rejects.toThrow(/global-only/i);
    await expect(set?.({ key: "compaction.enabled", value: "yes" }, {} as never)).rejects.toThrow(
      /true or false/i,
    );
    expect(port.write).not.toHaveBeenCalled();
  });

  it("reports untrusted project writes from the port", async () => {
    const port = createFakeSettings({ trusted: false });
    await expect(
      handlersFor(port)["settings.set"]?.(
        { key: "theme", value: "light", scope: "project" },
        {} as never,
      ),
    ).rejects.toThrow(/not trusted/i);
  });

  it("writes a raw document and validates its known keys", async () => {
    const port = createFakeSettings();
    const raw = handlersFor(port)["settings.raw"];
    await raw?.(
      { scope: "global", document: { theme: "light", unknownKey: { keep: true } } },
      {} as never,
    );
    expect(port.writeScope).toHaveBeenCalledWith(null, "global", {
      theme: "light",
      unknownKey: { keep: true },
    });

    await expect(
      raw?.({ scope: "global", document: { "compaction.enabled": "yes" } }, {} as never),
    ).rejects.toThrow(/true or false/i);
  });

  it("accepts raw JSON text", async () => {
    const port = createFakeSettings();
    await handlersFor(port)["settings.raw"]?.(
      { scope: "global", document: '{"theme":"light"}' },
      {} as never,
    );
    expect(port.writeScope).toHaveBeenCalledWith(null, "global", { theme: "light" });
    await expect(
      handlersFor(port)["settings.raw"]?.({ scope: "global", document: "{oops" }, {} as never),
    ).rejects.toThrow(/JSON/i);
  });

  it("reads without writing when no document is supplied", async () => {
    const port = createFakeSettings();
    await handlersFor(port)["settings.raw"]?.({}, {} as never);
    expect(port.writeScope).not.toHaveBeenCalled();
    expect(port.read).toHaveBeenCalledTimes(1);
  });

  it("flushes and reports errors", async () => {
    const port = createFakeSettings({
      errors: [{ scope: "global", message: "write failed" }],
    });
    const result = (await handlersFor(port)["settings.flush"]?.({}, {} as never)) as {
      flushed: boolean;
      errors: unknown[];
    };
    expect(port.flush).toHaveBeenCalledTimes(1);
    expect(result.flushed).toBe(true);
    expect(result.errors).toHaveLength(1);
  });

  it("answers not_implemented when no port is configured", async () => {
    const handlers = handlersFor(null);
    await expect(handlers["settings.get"]?.({}, {} as never)).rejects.toThrow(/not available/i);
    await expect(
      handlers["settings.set"]?.({ key: "theme", value: "light" }, {} as never),
    ).rejects.toThrow(/not available/i);
    await expect(handlers["settings.raw"]?.({}, {} as never)).rejects.toThrow(/not available/i);
    await expect(handlers["settings.flush"]?.({}, {} as never)).rejects.toThrow(/not available/i);
  });
});

describe("settings helpers", () => {
  it("normalises an SDK error into a JSON-safe shape", () => {
    expect(
      toSettingsErrorInfo({
        scope: "project",
        path: "/p/.pi/settings.json",
        error: new Error("x"),
      }),
    ).toEqual({ scope: "project", path: "/p/.pi/settings.json", message: "x" });
    expect(toSettingsErrorInfo({ scope: "nonsense", error: "raw" })).toEqual({
      scope: "global",
      message: "raw",
    });
  });

  it("rejects a non-object document and drops undefined leaves", () => {
    expect(() => validateSettingsDocument([1, 2])).toThrow(SettingsError);
    expect(validateSettingsDocument({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it("prefers the project value over the global one", () => {
    expect(
      effectiveSettingsValue({ global: { theme: "dark" }, project: { theme: "light" } }, "theme"),
    ).toBe("light");
    expect(effectiveSettingsValue({ global: { theme: "dark" }, project: {} }, "theme")).toBe(
      "dark",
    );
  });

  it("keeps its spies honest", () => {
    const port = createFakeSettings();
    expect(vi.isMockFunction(port.read)).toBe(true);
  });
});
