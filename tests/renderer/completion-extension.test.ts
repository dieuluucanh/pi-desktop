import { describe, expect, it, vi } from "vitest";

import { createExtensionCompletionProvider } from "../../src/renderer/src/completion/extension-source";
import { createCompletionProvider } from "../../src/renderer/src/completion/stack";
import type {
  CompletionProvider,
  CompletionSuggestions,
} from "../../src/renderer/src/completion/types";
import type { ExtensionCompletionBridge } from "../../src/renderer/src/completion/extension-source";

/**
 * Host-run extension completion (plan step 16).
 *
 * The contract: the renderer's built-in sources run first and are forwarded to
 * the host as the chain's `current`, so an extension that delegates still sees
 * `/`, `@` and `#`; when the host answers, its items win and are tagged
 * `extension` so the composer knows to apply them remotely.
 */

const baseSuggestions: CompletionSuggestions = {
  prefix: "@",
  items: [{ value: "@src", label: "@src", source: "file" }],
};

function baseProvider(overrides: Partial<CompletionProvider> = {}): CompletionProvider {
  return {
    id: "base",
    async getSuggestions() {
      return baseSuggestions;
    },
    applyCompletion: () => ({ lines: ["base"], cursorLine: 0, cursorCol: 4 }),
    shouldTriggerFileCompletion: () => false,
    ...overrides,
  };
}

function bridge(overrides: Partial<ExtensionCompletionBridge> = {}): ExtensionCompletionBridge {
  return {
    suggest: vi.fn(async () => null),
    apply: vi.fn(async () => null),
    ...overrides,
  };
}

describe("createExtensionCompletionProvider", () => {
  it("forwards the built-in result to the host and returns its items", async () => {
    const suggest = vi.fn(async () => ({
      prefix: "#do",
      items: [{ value: "#doc", label: "#doc", description: "Excel" }],
    }));
    const provider = createExtensionCompletionProvider(baseProvider(), bridge({ suggest }));

    const result = await provider.getSuggestions(["#do"], 0, 3, {
      signal: new AbortController().signal,
    });

    expect(suggest).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: ["#do"],
        cursorLine: 0,
        cursorCol: 3,
        base: { prefix: "@", items: [{ value: "@src", label: "@src", source: "file" }] },
      }),
    );
    expect(result).toEqual({
      prefix: "#do",
      items: [
        {
          value: "#doc",
          label: "#doc",
          description: "Excel",
          source: "extension",
          remote: true,
        },
      ],
    });
  });

  it("falls back to the built-in result when the host has nothing", async () => {
    const provider = createExtensionCompletionProvider(baseProvider(), bridge());
    const result = await provider.getSuggestions(["@s"], 0, 2, {
      signal: new AbortController().signal,
    });
    expect(result).toEqual(baseSuggestions);
  });

  it("delegates the file-completion decision to the built-in provider", () => {
    const provider = createExtensionCompletionProvider(baseProvider(), bridge());
    expect(provider.shouldTriggerFileCompletion?.(["x"], 0, 1)).toBe(false);
  });

  it("wraps the stack when a bridge is supplied", async () => {
    const suggest = vi.fn(async () => ({
      prefix: "#",
      items: [{ value: "#one", label: "#one" }],
    }));
    const provider = createCompletionProvider({
      extension: bridge({ suggest }),
    });
    const result = await provider.getSuggestions(["#"], 0, 1, {
      signal: new AbortController().signal,
    });
    expect(suggest).toHaveBeenCalled();
    expect(result?.items[0]).toMatchObject({ value: "#one", source: "extension" });
  });

  it("preserves the source and apply semantics of base items a provider delegates", async () => {
    const delegated: CompletionSuggestions = {
      prefix: "",
      items: [
        {
          value: "use ",
          label: "use",
          source: "extension",
          appendSpace: false,
        },
        { value: "test/model", label: "model", source: "app", appendSpace: false },
      ],
    };
    const suggest = vi.fn(async () => delegated);
    const provider = createExtensionCompletionProvider(
      baseProvider({
        async getSuggestions() {
          return delegated;
        },
      }),
      bridge({ suggest }),
    );

    const result = await provider.getSuggestions(["/profile "], 0, 9, {
      signal: new AbortController().signal,
    });

    expect(suggest).toHaveBeenCalledWith(
      expect.objectContaining({
        base: {
          prefix: "",
          items: [
            {
              value: "use ",
              label: "use",
              source: "extension",
              appendSpace: false,
            },
            { value: "test/model", label: "model", source: "app", appendSpace: false },
          ],
        },
      }),
    );
    expect(result?.items).toEqual([
      expect.objectContaining({
        value: "use ",
        source: "extension",
        appendSpace: false,
        remote: true,
      }),
      expect.objectContaining({
        value: "test/model",
        source: "app",
        appendSpace: false,
        remote: true,
      }),
    ]);
  });

  it("does not consult the host without a bridge", async () => {
    const suggest = vi.fn(async () => null);
    const provider = createCompletionProvider({ extension: bridge({ suggest }) });
    await provider.getSuggestions(["a"], 0, 1, { signal: new AbortController().signal });
    // No built-in source matches a bare word, so there is nothing to send.
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({ base: null }));
  });
});
