import { describe, expect, it, vi } from "vitest";
import type { ModelScopeDiagnostic, ScopedModel } from "@earendil-works/pi-coding-agent";
import {
  ModelScopeError,
  createSdkModelScope,
  resolveSessionScope,
  toggleScope,
  type ModelScopeResolution,
  type ModelScopeResolver,
} from "../../src/host/sdk/model-scope";

/**
 * The SDK adapter for Pi's model scope.
 *
 * The resolver itself is Pi's (`resolveModelScopeWithDiagnostics`); these tests
 * pin the adapter's contract: no patterns means no call, a failure degrades for
 * session creation but aborts a toggle, the rewrite materialises globs while
 * preserving unmatched patterns, and diagnostics come back in the host's shape.
 */

const RUNTIME = { getAvailable: vi.fn() };

function scoped(provider: string, id: string, thinkingLevel?: string): ScopedModel {
  return {
    model: { provider, id, name: id } as unknown as ScopedModel["model"],
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as ScopedModel["thinkingLevel"] } : {}),
  };
}

function noMatch(pattern: string): ModelScopeDiagnostic {
  return {
    type: "warning",
    code: "no-match",
    message: `No models match pattern "${pattern}"`,
    pattern,
  };
}

function fakeResolver(
  implementation: (patterns: string[]) => Promise<ModelScopeResolution>,
): ModelScopeResolver & { mock: { calls: unknown[][] } } {
  return vi.fn(async (patterns: string[]) =>
    implementation(patterns),
  ) as unknown as ModelScopeResolver & { mock: { calls: unknown[][] } };
}

describe("resolveSessionScope", () => {
  it("returns no scope without calling the resolver when nothing is configured", async () => {
    const resolve = vi.fn();
    await expect(
      resolveSessionScope({ patterns: undefined, runtime: RUNTIME }, { resolve }),
    ).resolves.toEqual({ scopedModels: [], diagnostics: [] });
    await expect(
      resolveSessionScope({ patterns: [], runtime: RUNTIME }, { resolve }),
    ).resolves.toEqual({ scopedModels: [], diagnostics: [] });
    await expect(
      resolveSessionScope({ patterns: [" ", "  "], runtime: RUNTIME }, { resolve }),
    ).resolves.toEqual({ scopedModels: [], diagnostics: [] });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("normalises patterns and maps the SDK diagnostics", async () => {
    const resolve = fakeResolver(async () => ({
      scopedModels: [scoped("a", "one")],
      diagnostics: [noMatch("gone/*")],
    }));
    const result = await resolveSessionScope(
      { patterns: [" a/one ", "a/one", "gone/*"], runtime: RUNTIME },
      { resolve },
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve.mock.calls[0]?.[0]).toEqual(["a/one", "gone/*"]);
    expect(resolve.mock.calls[0]?.[1]).toBe(RUNTIME);
    const options = resolve.mock.calls[0]?.[2] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      scopedModels: [scoped("a", "one")],
      diagnostics: [{ type: "warning", message: 'No models match pattern "gone/*"' }],
    });
  });

  it("fails soft: a rejected resolver yields no scope plus one warning", async () => {
    const resolve = fakeResolver(async () => {
      throw new Error("auth store is locked");
    });
    const result = await resolveSessionScope(
      { patterns: ["a/one"], runtime: RUNTIME },
      { resolve },
    );
    expect(result.scopedModels).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("auth store is locked");
    expect(result.diagnostics[0]?.message).toContain("every available model is usable");
  });

  it("fails soft on a synchronous throw too", async () => {
    const resolve = vi.fn(() => {
      throw new Error("boom");
    }) as unknown as ModelScopeResolver;
    const result = await resolveSessionScope(
      { patterns: ["a/one"], runtime: RUNTIME },
      { resolve },
    );
    expect(result.scopedModels).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain("boom");
  });
});

describe("toggleScope", () => {
  it("disables a model by materialising the rest of the live scope", async () => {
    const calls: string[][] = [];
    const resolve = fakeResolver(async (patterns) => {
      calls.push(patterns);
      if (patterns.length === 2) {
        return { scopedModels: [scoped("a", "one", "high"), scoped("b", "two")], diagnostics: [] };
      }
      return { scopedModels: [scoped("b", "two")], diagnostics: [] };
    });

    const result = await toggleScope(
      {
        liveScoped: [scoped("a", "one", "high"), scoped("b", "two")],
        patterns: ["a/one:high", "b/two"],
        runtime: RUNTIME,
        provider: "a",
        id: "one",
        enabled: false,
      },
      { resolve },
    );

    expect(calls).toEqual([["a/one:high", "b/two"], ["b/two"]]);
    expect(result.patterns).toEqual(["b/two"]);
    expect(result.scopedModels).toEqual([scoped("b", "two")]);
    expect(result.diagnostics).toEqual([]);
  });

  it("enables a model that was not in the live scope with a single resolution", async () => {
    const calls: string[][] = [];
    const resolve = fakeResolver(async (patterns) => {
      calls.push(patterns);
      return {
        scopedModels: patterns.map((pattern) =>
          scoped(...(pattern.split("/") as [string, string])),
        ),
        diagnostics: [],
      };
    });

    const result = await toggleScope(
      {
        liveScoped: [],
        patterns: [],
        runtime: RUNTIME,
        provider: "a",
        id: "one",
        enabled: true,
      },
      { resolve },
    );

    expect(calls).toEqual([["a/one"]]);
    expect(result.patterns).toEqual(["a/one"]);
    expect(result.scopedModels).toEqual([scoped("a", "one")]);
  });

  it("keeps persisted models when an empty live scope means resolution failed", async () => {
    const calls: string[][] = [];
    const resolve = fakeResolver(async (patterns) => {
      calls.push(patterns);
      return {
        scopedModels: patterns.map((pattern) =>
          scoped(...(pattern.split("/") as [string, string])),
        ),
        diagnostics: [],
      };
    });

    const result = await toggleScope(
      {
        liveScoped: [],
        patterns: ["a/one", "b/two"],
        runtime: RUNTIME,
        provider: "c",
        id: "three",
        enabled: true,
      },
      { resolve },
    );

    expect(calls[0]).toEqual(["a/one", "b/two"]);
    expect(calls[1]).toEqual(["a/one", "b/two", "c/three"]);
    expect(result.patterns).toEqual(["a/one", "b/two", "c/three"]);
    expect(result.scopedModels).toEqual([
      scoped("a", "one"),
      scoped("b", "two"),
      scoped("c", "three"),
    ]);
  });

  it("expands a matching glob to explicit ids so un-starring really removes a model", async () => {
    const calls: string[][] = [];
    const resolve = fakeResolver(async (patterns) => {
      calls.push(patterns);
      if (patterns[0] === "opencode/*") {
        return {
          scopedModels: [scoped("opencode", "a"), scoped("opencode", "b")],
          diagnostics: [],
        };
      }
      return { scopedModels: [scoped("opencode", "b")], diagnostics: [] };
    });

    const result = await toggleScope(
      {
        liveScoped: [scoped("opencode", "a"), scoped("opencode", "b")],
        patterns: ["opencode/*"],
        runtime: RUNTIME,
        provider: "opencode",
        id: "a",
        enabled: false,
      },
      { resolve },
    );

    expect(calls[1]).toEqual(["opencode/b"]);
    expect(result.patterns).toEqual(["opencode/b"]);
  });

  it("preserves patterns that currently match nothing", async () => {
    const calls: string[][] = [];
    const resolve = fakeResolver(async (patterns) => {
      calls.push(patterns);
      if (patterns.includes("a/one")) {
        return { scopedModels: [scoped("a", "one")], diagnostics: [noMatch("offline/*")] };
      }
      return { scopedModels: [], diagnostics: [noMatch("offline/*")] };
    });

    const result = await toggleScope(
      {
        liveScoped: [scoped("a", "one")],
        patterns: ["a/one", "offline/*"],
        runtime: RUNTIME,
        provider: "a",
        id: "one",
        enabled: false,
      },
      { resolve },
    );

    expect(calls[1]).toEqual(["offline/*"]);
    expect(result.patterns).toEqual(["offline/*"]);
    expect(result.diagnostics).toEqual([
      { type: "warning", message: 'No models match pattern "offline/*"' },
    ]);
  });

  it("returns undefined (delete the key) when the last model leaves and nothing is preserved", async () => {
    const resolve = fakeResolver(async () => ({
      scopedModels: [scoped("a", "one")],
      diagnostics: [],
    }));

    const result = await toggleScope(
      {
        liveScoped: [scoped("a", "one")],
        patterns: ["a/one"],
        runtime: RUNTIME,
        provider: "a",
        id: "one",
        enabled: false,
      },
      { resolve },
    );

    expect(result).toEqual({ patterns: undefined, scopedModels: [], diagnostics: [] });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("stars every model as an explicit list (never collapses to no scope)", async () => {
    const resolve = fakeResolver(async (patterns) => ({
      scopedModels: patterns.map((pattern) => scoped(...(pattern.split("/") as [string, string]))),
      diagnostics: [],
    }));

    const result = await toggleScope(
      {
        liveScoped: [scoped("a", "one")],
        patterns: ["a/one"],
        runtime: RUNTIME,
        provider: "b",
        id: "two",
        enabled: true,
      },
      { resolve },
    );

    expect(result.patterns).toEqual(["a/one", "b/two"]);
  });

  it("throws instead of half-applying when the current scope cannot resolve", async () => {
    const resolve = fakeResolver(async () => {
      throw new Error("no catalogue");
    });
    await expect(
      toggleScope(
        {
          liveScoped: [scoped("a", "one")],
          patterns: ["a/one"],
          runtime: RUNTIME,
          provider: "a",
          id: "one",
          enabled: false,
        },
        { resolve },
      ),
    ).rejects.toBeInstanceOf(ModelScopeError);
  });

  it("throws when the new scope cannot resolve", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ scopedModels: [scoped("a", "one")], diagnostics: [] })
      .mockRejectedValueOnce(new Error("refresh failed")) as unknown as ModelScopeResolver;

    await expect(
      toggleScope(
        {
          liveScoped: [scoped("a", "one")],
          patterns: ["a/one"],
          runtime: RUNTIME,
          provider: "b",
          id: "two",
          enabled: true,
        },
        { resolve },
      ),
    ).rejects.toBeInstanceOf(ModelScopeError);
  });
});

describe("createSdkModelScope", () => {
  it("exposes the same two functions with the injected resolver", async () => {
    const resolve = fakeResolver(async (patterns) => ({
      scopedModels: patterns.map((pattern) => scoped(...(pattern.split("/") as [string, string]))),
      diagnostics: [],
    }));
    const port = createSdkModelScope({ resolve });

    await expect(port.resolve(["a/one"], RUNTIME)).resolves.toEqual({
      scopedModels: [scoped("a", "one")],
      diagnostics: [],
    });
    await expect(
      port.toggle({
        liveScoped: [scoped("a", "one")],
        patterns: ["a/one"],
        runtime: RUNTIME,
        provider: "b",
        id: "two",
        enabled: true,
      }),
    ).resolves.toMatchObject({ patterns: ["a/one", "b/two"] });
  });
});
