import { describe, expect, it, vi } from "vitest";
import {
  fuzzyFilter as upstreamFilter,
  fuzzyMatch as upstreamMatch,
  type AutocompleteProvider,
} from "@earendil-works/pi-tui";
import { fuzzyFilter, fuzzyMatch } from "../../src/renderer/src/completion/fuzzy";
import {
  createCommandProvider,
  parseCommandInput,
} from "../../src/renderer/src/completion/command-source";
import {
  createDocumentProvider,
  type DocumentMention,
} from "../../src/renderer/src/completion/document-source";
import { createFileProvider } from "../../src/renderer/src/completion/file-source";
import { createShellProvider } from "../../src/renderer/src/completion/shell-source";
import { createCompletionProvider } from "../../src/renderer/src/completion/stack";
import {
  applyCompletionInPlace,
  type CompletionProviderFactory,
} from "../../src/renderer/src/completion/types";
import { parseOfficeDocumentsView, toDocumentMentions } from "../../src/shared/office-documents";

/**
 * The completion engine (plan step 7), tested with no DOM at all: these modules
 * are type-checked by the node project and run in the node environment, which is
 * the strongest available proof that the engine is pure.
 */

function signal(): AbortSignal {
  return new AbortController().signal;
}

const HOST_COMMANDS = [
  { name: "deploy", description: "Deploy the app", source: "extension" },
  { name: "profile", description: "Manage profiles", source: "extension" },
  { name: "model", description: "An extension that also claims /model", source: "extension" },
  {
    name: "settings",
    description: "A template that also claims /settings",
    source: "prompt",
    argumentHint: "<key>",
  },
  { name: "release", description: "Cut a release", source: "prompt", argumentHint: "<version>" },
  { name: "skill:review", description: "Review the diff", source: "skill" },
];

describe("fuzzy ranking matches Pi's own matcher", () => {
  const corpus = [
    "src/renderer/src/app.tsx",
    "src/host/session-core.ts",
    "docs/product/parity.md",
    "README.md",
    "model3",
    "3model",
    "packages/app/dist/index.js",
  ];
  const queries = [
    "app",
    "src",
    "renderer",
    "sr",
    "ses",
    "md",
    "model3",
    "3model",
    "pack",
    "zzz",
    "PARITY",
  ];

  it("agrees with pi-tui on matches and scores", () => {
    for (const query of queries) {
      for (const text of corpus) {
        expect(fuzzyMatch(query, text), `${query} vs ${text}`).toEqual(upstreamMatch(query, text));
      }
    }
  });

  it("agrees with pi-tui on the filtered order", () => {
    for (const query of queries) {
      const mine = fuzzyFilter(corpus, query, (value) => value);
      const theirs = upstreamFilter(corpus, query, (value) => value);
      expect(mine, query).toEqual(theirs);
    }
  });

  it("keeps input order for an empty query, like Pi", () => {
    expect(fuzzyFilter(corpus, "   ", (value) => value)).toEqual(corpus);
  });

  it("requires every whitespace- or slash-separated token to match", () => {
    const ranked = fuzzyFilter(corpus, "src/renderer", (value) => value);
    expect(ranked).toEqual(["src/renderer/src/app.tsx"]);
  });
});

describe("command completion", () => {
  const hostComplete = vi.fn(async ({ name, prefix }: { name: string; prefix: string }) => {
    if (name !== "profile") return null;
    return [
      { value: "use ", label: "use", description: "activate a profile" },
      { value: "list", label: "list" },
    ].filter((item) => item.label.startsWith(prefix));
  });
  const appComplete = vi.fn(async ({ name, prefix }: { name: string; prefix: string }) =>
    name === "model" && "test/model".startsWith(prefix)
      ? [
          {
            value: "test/model",
            label: "model",
            description: "test",
            source: "app" as const,
          },
        ]
      : null,
  );
  const provider = createCommandProvider({
    loadCommands: async () => HOST_COMMANDS,
    completeCommand: hostComplete,
    completeAppArgument: appComplete,
  });

  it("lists app commands, extensions, templates and skills on the first line", async () => {
    const result = await provider.getSuggestions(["/"], 0, 1, { signal: signal() });
    expect(result).not.toBeNull();
    const labels = result!.items.map((item) => item.label);
    expect(labels).toContain("/model");
    expect(labels).toContain("/deploy");
    expect(labels).toContain("/skill:review");

    const byLabel = new Map(result!.items.map((item) => [item.label, item]));
    // `/model` appears twice (the app's own and the extension's), so a Map keeps
    // only the last one: read the collision through the list instead.
    const appModel = result!.items.find((item) => item.label === "/model" && item.source === "app");
    expect(appModel).toBeDefined();
    expect(byLabel.get("/deploy")?.source).toBe("extension");
    expect(byLabel.get("/release")?.source).toBe("prompt");
    expect(byLabel.get("/release")?.detail).toBe("<version>");
    expect(byLabel.get("/skill:review")?.source).toBe("skill");
  });

  it("filters by the typed prefix", async () => {
    const result = await provider.getSuggestions(["/dep"], 0, 4, { signal: signal() });
    expect(result?.items.map((item) => item.label)).toEqual(["/deploy"]);
    expect(result?.prefix).toBe("/dep");
  });

  it("suggests /scoped-models for the singular typo", async () => {
    const result = await provider.getSuggestions(["/scoped-model"], 0, 13, {
      signal: signal(),
    });
    expect(result?.items.map((item) => item.label)).toContain("/scoped-models");
    expect(result?.items.find((item) => item.label === "/scoped-models")?.source).toBe("app");
  });

  it("asks the host for the full argument prefix after the first space", async () => {
    hostComplete.mockClear();
    const result = await provider.getSuggestions(["/profile u"], 0, 10, {
      signal: signal(),
    });

    expect(hostComplete).toHaveBeenCalledWith(
      expect.objectContaining({ name: "profile", prefix: "u" }),
    );
    expect(result?.prefix).toBe("u");
    expect(result?.items).toEqual([
      {
        value: "use ",
        label: "use",
        description: "activate a profile",
        source: "extension",
        appendSpace: false,
      },
    ]);
  });

  it("passes the whole multi-token argument, not just the last word", async () => {
    hostComplete.mockClear();
    await provider.getSuggestions(["/profile use S"], 0, 14, { signal: signal() });
    expect(hostComplete).toHaveBeenCalledWith(
      expect.objectContaining({ name: "profile", prefix: "use S" }),
    );
  });

  it("uses the app completer for a reserved name and never the host hook", async () => {
    hostComplete.mockClear();
    appComplete.mockClear();
    const result = await provider.getSuggestions(["/model test"], 0, 11, {
      signal: signal(),
    });

    expect(appComplete).toHaveBeenCalledWith(expect.objectContaining({ name: "model" }));
    expect(hostComplete).not.toHaveBeenCalled();
    expect(result?.items[0]).toMatchObject({
      value: "test/model",
      label: "model",
      source: "app",
      appendSpace: false,
    });
  });

  it("applies an argument value verbatim, preserving its trailing space", async () => {
    const result = await provider.getSuggestions(["/profile u"], 0, 10, {
      signal: signal(),
    });
    const applied = provider.applyCompletion(
      ["/profile u"],
      0,
      10,
      result!.items[0]!,
      result!.prefix,
    );
    expect(applied.lines[0]).toBe("/profile use ");
    expect(applied.cursorCol).toBe(13);
  });

  it("returns null for an unknown command, a failed hook, or an aborted request", async () => {
    expect(await provider.getSuggestions(["/zzzz arg"], 0, 9, { signal: signal() })).toBeNull();

    const broken = createCommandProvider({
      loadCommands: async () => HOST_COMMANDS,
      completeCommand: async () => {
        throw new Error("boom");
      },
    });
    expect(await broken.getSuggestions(["/deploy now"], 0, 11, { signal: signal() })).toBeNull();

    const controller = new AbortController();
    controller.abort();
    expect(
      await provider.getSuggestions(["/profile u"], 0, 10, { signal: controller.signal }),
    ).toBeNull();
  });

  it("only triggers on the first line", async () => {
    expect(await provider.getSuggestions(["hello", "/na"], 1, 3, { signal: signal() })).toBeNull();
    expect(
      await provider.getSuggestions(["hello", "/profile u"], 1, 10, { signal: signal() }),
    ).toBeNull();
  });

  it("returns nothing when the prefix matches no command", async () => {
    expect(await provider.getSuggestions(["/zzzz"], 0, 5, { signal: signal() })).toBeNull();
  });

  it("keeps both entries when a name collides", async () => {
    const result = await provider.getSuggestions(["/model"], 0, 6, { signal: signal() });
    const models = result!.items.filter((item) => item.label === "/model");
    expect(models).toHaveLength(2);
    expect(models.map((item) => item.source).sort()).toEqual(["app", "extension"]);
  });
});

describe("file completion", () => {
  const files = [
    "src/renderer/app.tsx",
    "src/renderer/session/Composer.tsx",
    "src/host/session-core.ts",
    "README.md",
  ];
  const provider = createFileProvider({ loadFiles: async () => ({ files, root: "/w" }) });

  it("completes a real path after @ and keeps the prefix", async () => {
    const result = await provider.getSuggestions(["look at @src/renderer/a"], 0, 23, {
      signal: signal(),
    });
    expect(result?.prefix).toBe("@src/renderer/a");
    expect(result?.items[0]?.value).toBe("@src/renderer/app.tsx");
    expect(result?.items[0]?.source).toBe("file");
    expect(result?.items[0]?.description).toBe("src/renderer");
  });

  it("applies an @ suggestion by replacing only the typed prefix", () => {
    const applied = applyCompletionInPlace(
      ["look at @src/renderer/a", ""],
      0,
      23,
      { value: "@src/renderer/app.tsx", label: "src/renderer/app.tsx" },
      "@src/renderer/a",
    );
    expect(applied.lines[0]).toBe("look at @src/renderer/app.tsx ");
    expect(applied.cursorCol).toBe(30);
  });

  it("offers nothing for an absolute or home path, rather than the wrong files", async () => {
    expect(await provider.getSuggestions(["@/etc/pass"], 0, 9, { signal: signal() })).toBeNull();
    expect(await provider.getSuggestions(["@~/not"], 0, 6, { signal: signal() })).toBeNull();
  });

  it("completes a plain path only when asked explicitly (Tab)", async () => {
    expect(await provider.getSuggestions(["src/ren"], 0, 7, { signal: signal() })).toBeNull();
    const forced = await provider.getSuggestions(["src/renderer/comp"], 0, 17, {
      signal: signal(),
      force: true,
    });
    expect(forced?.items.map((item) => item.value)).toEqual(["src/renderer/session/Composer.tsx"]);
  });

  it("gives up when the request was aborted", async () => {
    const slow = createFileProvider({
      loadFiles: async () => ({ files }),
    });
    const controller = new AbortController();
    controller.abort();
    expect(await slow.getSuggestions(["@src"], 0, 4, { signal: controller.signal })).toBeNull();
  });
});

describe("document completion", () => {
  const documents: DocumentMention[] = [
    { id: "1", name: "Budget.xlsx", kind: "excel", description: "Q3 plan" },
    { id: "2", name: "Report.docx", kind: "word" },
  ];

  it("answers nothing until a registry is supplied", async () => {
    const provider = createDocumentProvider(null);
    expect(await provider.getSuggestions(["#"], 0, 1, { signal: signal() })).toBeNull();
  });

  it("completes open documents when the registry exists", async () => {
    const provider = createDocumentProvider({ list: () => documents });
    const result = await provider.getSuggestions(["summarise #bud"], 0, 14, { signal: signal() });
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0]).toMatchObject({
      value: "#Budget.xlsx",
      source: "document",
      detail: "excel",
      description: "Q3 plan",
    });
  });

  it("is fed by the bridge's pane registry (plan step 20)", async () => {
    const view = parseOfficeDocumentsView({
      payload: {
        service: "pi-office-bridge",
        protocolVersion: 3,
        panes: [
          {
            host: "excel",
            document: { id: "url_sha256:aaaa", name: "Book1.xlsx" },
            targetId: "url_sha256:aaaa",
            focused: true,
            windows: 1,
            ops: ["excel.read_range"],
          },
          {
            host: "word",
            document: { id: "url_sha256:bbbb", name: "Report.docx" },
            targetId: "url_sha256:bbbb",
            windows: 2,
            ops: [],
          },
        ],
      },
      status: "ok",
      fetchedAt: "2026-09-20T10:00:00.000Z",
    });
    const provider = createDocumentProvider({ list: () => toDocumentMentions(view.panes) });

    const result = await provider.getSuggestions(["read #rep"], 0, 9, { signal: signal() });
    expect(result?.items[0]).toMatchObject({
      value: "#Report.docx",
      label: "#Report.docx",
      detail: "Word",
      description: "Word · 2 windows",
    });
  });
});

describe("the stack", () => {
  const command = createCommandProvider({ loadCommands: async () => HOST_COMMANDS });
  const file = createFileProvider({ loadFiles: async () => ({ files: ["src/app.ts"] }) });
  const document = createDocumentProvider({ list: () => [{ id: "1", name: "Book.xlsx" }] });
  const provider = createCompletionProvider({ command, file, document });

  it("routes each trigger to its source and ignores everything else", async () => {
    expect(
      (await provider.getSuggestions(["/he"], 0, 3, { signal: signal() }))?.items[0]?.label,
    ).toBe("/help");
    expect(
      (await provider.getSuggestions(["@src"], 0, 4, { signal: signal() }))?.items[0]?.value,
    ).toBe("@src/app.ts");
    expect(
      (await provider.getSuggestions(["#bo"], 0, 3, { signal: signal() }))?.items[0]?.value,
    ).toBe("#Book.xlsx");
    expect(
      await provider.getSuggestions(["a plain sentence"], 0, 16, { signal: signal() }),
    ).toBeNull();
  });

  it("treats a / on a later line as ordinary text", async () => {
    expect(
      await provider.getSuggestions(["line one", "/he"], 1, 3, { signal: signal() }),
    ).toBeNull();
  });

  it("does not ask for files on a plain word unless Tab was pressed", async () => {
    expect(provider.shouldTriggerFileCompletion?.(["/na"], 0, 3)).toBe(false);
    expect(provider.shouldTriggerFileCompletion?.(["src/app"], 0, 7)).toBe(true);
    expect(provider.shouldTriggerFileCompletion?.(["/profile use"], 0, 12)).toBe(false);
  });

  it("routes command arguments to the command provider, including on a forced Tab", async () => {
    const loadFiles = vi.fn(async () => ({ files: ["src/app.ts"] }));
    const completeCommand = vi.fn(async () => [
      { value: "use ", label: "use", description: "activate" },
    ]);
    const argumentProvider = createCompletionProvider({
      command: createCommandProvider({
        loadCommands: async () => HOST_COMMANDS,
        completeCommand,
      }),
      file: createFileProvider({ loadFiles }),
    });

    const natural = await argumentProvider.getSuggestions(["/profile "], 0, 9, {
      signal: signal(),
    });
    expect(natural?.items[0]?.value).toBe("use ");
    expect(completeCommand).toHaveBeenCalledWith(
      expect.objectContaining({ name: "profile", prefix: "" }),
    );

    completeCommand.mockClear();
    loadFiles.mockClear();
    const forced = await argumentProvider.getSuggestions(["/profile "], 0, 9, {
      signal: signal(),
      force: true,
    });
    expect(forced?.items[0]?.value).toBe("use ");
    expect(completeCommand).toHaveBeenCalled();
    expect(loadFiles).not.toHaveBeenCalled();
  });

  it("applies a command with a trailing space so arguments can be typed", () => {
    const applied = provider.applyCompletion(
      ["/he"],
      0,
      3,
      { value: "/help", label: "/help" },
      "/he",
    );
    expect(applied.lines[0]).toBe("/help ");
    expect(applied.cursorCol).toBe(6);
  });

  it("wraps the built-ins with extension providers in registration order", async () => {
    const calls: string[] = [];
    // An extension written against Pi's own types, assigned to our factory type:
    // if the shapes ever drift, this stops compiling.
    const extensionProvider: AutocompleteProvider = {
      triggerCharacters: ["!"],
      async getSuggestions() {
        return { items: [{ value: "!ping", label: "!ping" }], prefix: "!" };
      },
      applyCompletion: applyCompletionInPlace,
    };
    const factory: CompletionProviderFactory = (current) => {
      calls.push("first");
      return {
        ...current,
        async getSuggestions(lines, line, col, options) {
          if ((lines[line] ?? "").slice(0, col).startsWith("!")) {
            return extensionProvider.getSuggestions(lines, line, col, options);
          }
          return current.getSuggestions(lines, line, col, options);
        },
      };
    };
    const second: CompletionProviderFactory = (current) => {
      calls.push("second");
      return current;
    };

    const stacked = createCompletionProvider({
      command,
      file,
      document,
      extensionFactories: [factory, second],
    });
    expect(calls).toEqual(["first", "second"]);
    expect(
      (await stacked.getSuggestions(["!pi"], 0, 3, { signal: signal() }))?.items[0]?.value,
    ).toBe("!ping");
    // …and the built-ins still work through the wrapper.
    expect(
      (await stacked.getSuggestions(["/he"], 0, 3, { signal: signal() }))?.items[0]?.label,
    ).toBe("/help");
  });

  it("survives a factory that returns nothing", () => {
    const bad = (() => undefined) as unknown as CompletionProviderFactory;
    expect(() => createCompletionProvider({ command, extensionFactories: [bad] })).not.toThrow();
  });
});

describe("shell completion", () => {
  const shell = createShellProvider({
    loadFiles: async () => ({ files: ["src/app.ts", "src/renderer/main.ts", "docs/readme.md"] }),
  });
  const provider = createCompletionProvider({
    command: createCommandProvider({ loadCommands: async () => HOST_COMMANDS }),
    file: createFileProvider({ loadFiles: async () => ({ files: ["src/app.ts"] }) }),
    shell,
  });

  it("completes workspace paths after ! and !!", async () => {
    expect(
      (await provider.getSuggestions(["!git add src"], 0, 12, { signal: signal() }))?.items[0]
        ?.value,
    ).toBe("src/app.ts");
    expect(
      (await provider.getSuggestions(["!!git add src"], 0, 13, { signal: signal() }))?.items[0]
        ?.value,
    ).toBe("src/app.ts");
  });

  it("does not invent a completion for a flag, an absolute path or a non-path word", async () => {
    expect(
      await provider.getSuggestions(["!git push -u origin"], 0, 20, { signal: signal() }),
    ).toBeNull();
    expect(
      await provider.getSuggestions(["!cat /etc/hosts"], 0, 15, { signal: signal() }),
    ).toBeNull();
    expect(
      await provider.getSuggestions(["!git add --force"], 0, 17, { signal: signal() }),
    ).toBeNull();
  });

  it("keeps / on the first line a command line", async () => {
    expect(
      (await provider.getSuggestions(["/he"], 0, 3, { signal: signal() }))?.items[0]?.label,
    ).toBe("/help");
  });
});

describe("parseCommandInput", () => {
  it("splits a name from its argument", () => {
    expect(parseCommandInput("/name my session")).toEqual({ name: "name", argument: "my session" });
    expect(parseCommandInput("/model")).toEqual({ name: "model", argument: "" });
    expect(parseCommandInput("  /skill:review   the diff  ")).toEqual({
      name: "skill:review",
      argument: "the diff",
    });
  });

  it("rejects text that is not a command", () => {
    expect(parseCommandInput("hello")).toBeNull();
    expect(parseCommandInput("/")).toBeNull();
    expect(parseCommandInput("  ")).toBeNull();
  });
});
