import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOST_STALE_MESSAGE, useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Command dispatch through the store (plan step 7): a `/command` is resolved
 * before anything is sent, an unknown name becomes a hint, and an extension
 * command is passed to `prompt` for the SDK to expand.
 */

const HOST_COMMANDS = [
  { name: "deploy", description: "Deploy", source: "extension" },
  { name: "model", description: "An extension claiming /model", source: "extension" },
  { name: "review", description: "Review a change", source: "prompt" },
];

function tab(): TabRecord {
  return {
    id: "tab-1",
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status: "idle",
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function stubRequest(handler?: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    if (input.method === "commands.list") return { commands: HOST_COMMANDS };
    if (input.method === "files.list")
      return { root: "/work/app", files: ["src/app.ts"], truncated: false };
    if (input.method === "commands.run") return { ran: true };
    return handler ? handler(input) : {};
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: "tab-1",
    transcripts: {},
    sessionStates: {},
    draftHistory: {},
    historyBrowse: {},
    completionCommands: {},
    completionFiles: {},
    modelCatalog: {},
    providerAuth: {},
    thinkingLevels: {},
    picker: null,
    view: "session",
    staleHosts: {},
    hint: null,
  });
});

describe("runCommandInput", () => {
  it("runs an app command through its host method, without a prompt", async () => {
    const request = stubRequest();
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/new");

    expect(outcome).toEqual({ handled: true, sent: true });
    expect(request.mock.calls.map((call) => call[0]?.method)).toContain("session.new");
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(false);
  });

  it("sends an argument to the command's own parameters", async () => {
    const request = stubRequest();
    await useAppStore.getState().runCommandInput("tab-1", "/name Renamed session");
    const rename = request.mock.calls.find((call) => call[0]?.method === "session.rename");
    expect(rename?.[0]?.params).toEqual({ name: "Renamed session" });
  });

  it("runs an extension command directly, even while streaming", async () => {
    const request = stubRequest();
    useAppStore.setState({
      tabs: [{ ...tab(), status: "running" }],
    });
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/deploy now");

    expect(outcome).toEqual({ handled: true, sent: true });
    const run = request.mock.calls.find((call) => call[0]?.method === "commands.run");
    expect(run?.[0]?.params).toEqual({ name: "deploy", args: "now", ack: "started" });
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(false);
    expect(useAppStore.getState().draftHistory["tab-1"]).toEqual(["/deploy now"]);
  });

  it("keeps prompt templates on the prompt path with the send mode", async () => {
    const request = stubRequest();
    useAppStore.setState({ tabs: [{ ...tab(), status: "running" }] });
    const sent = await useAppStore
      .getState()
      .sendPrompt("tab-1", "/review the diff", { mode: "followUp" });

    expect(sent).toBe(true);
    const prompt = request.mock.calls.find((call) => call[0]?.method === "prompt");
    expect(prompt?.[0]?.params).toMatchObject({
      text: "/review the diff",
      streamingBehavior: "followUp",
      ack: "preflight",
      promptOrigin: "/review the diff",
    });
    expect(request.mock.calls.some((call) => call[0]?.method === "commands.run")).toBe(false);
  });

  it("falls back to prompt when the host cannot run commands directly", async () => {
    const request = vi.fn(async (input: { method: string; params?: unknown }) => {
      if (input.method === "commands.list") return { commands: HOST_COMMANDS };
      if (input.method === "commands.run") throw new Error("not implemented");
      return {};
    });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/deploy now");

    expect(outcome).toEqual({ handled: true, sent: true });
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(true);
    const prompt = request.mock.calls.find((call) => call[0]?.method === "prompt");
    // The fallback still carries the raw command for the transcript label.
    expect(prompt?.[0]?.params).toMatchObject({
      ack: "preflight",
      promptOrigin: "/deploy now",
    });
  });

  it("refreshes once and hints when the command is no longer live", async () => {
    const request = vi.fn(async (input: { method: string; params?: unknown }) => {
      if (input.method === "commands.list") return { commands: HOST_COMMANDS };
      if (input.method === "commands.run") return { ran: false };
      return {};
    });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/deploy now");

    expect(outcome).toEqual({ handled: true, sent: false });
    expect(useAppStore.getState().hint).toMatch(/no longer available/);
    expect(request.mock.calls.filter((call) => call[0]?.method === "commands.list")).toHaveLength(
      2,
    );
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(false);
  });

  it("refreshes once before treating a valid command as unknown", async () => {
    let listCalls = 0;
    const request = vi.fn(async (input: { method: string; params?: unknown }) => {
      if (input.method === "commands.list") {
        listCalls += 1;
        return { commands: listCalls === 1 ? [] : HOST_COMMANDS };
      }
      if (input.method === "commands.run") return { ran: true };
      return {};
    });
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;

    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/deploy now");

    expect(outcome).toEqual({ handled: true, sent: true });
    expect(listCalls).toBe(2);
    expect(request.mock.calls.some((call) => call[0]?.method === "commands.run")).toBe(true);
  });

  it("shows a hint for an unknown command and never sends it as prose", async () => {
    const request = stubRequest();
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/zzzz");

    expect(outcome).toEqual({ handled: true, sent: false });
    expect(useAppStore.getState().hint).toMatch(/Unknown command \/zzzz/);
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(false);
  });

  it("opens the session history tree for /tree (plan step 11)", async () => {
    const request = stubRequest();
    await useAppStore.getState().runCommandInput("tab-1", "/tree");

    expect(request.mock.calls.some((call) => call[0]?.method === "tree.get")).toBe(true);
    expect(useAppStore.getState().sessionTreeOpen).toBe(true);
  });

  it("switches view for an app command that opens one", async () => {
    stubRequest();
    await useAppStore.getState().runCommandInput("tab-1", "/settings");
    expect(useAppStore.getState().view).toBe("settings");
  });

  it("lists the commands for /help", async () => {
    stubRequest();
    await useAppStore.getState().runCommandInput("tab-1", "/help");
    expect(useAppStore.getState().hint).toContain("/new");
  });

  it("refuses a command that needs an argument it did not get", async () => {
    const request = stubRequest();
    await useAppStore.getState().runCommandInput("tab-1", "/name");
    expect(useAppStore.getState().hint).toMatch(/\/name needs/);
    expect(request.mock.calls.some((call) => call[0]?.method === "session.rename")).toBe(false);
  });

  it("resolves a collision with the source the user picked", async () => {
    const request = stubRequest();
    // The app reserves /model: its own picker opens and nothing is sent …
    await useAppStore.getState().runCommandInput("tab-1", "/model");
    expect(useAppStore.getState().picker).toBe("model");
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(false);

    // …but picking the extension's entry runs it directly instead.
    await useAppStore.getState().runCommandInput("tab-1", "/model", {
      preferredSource: "extension",
    });
    expect(request.mock.calls.some((call) => call[0]?.method === "commands.run")).toBe(true);
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(false);
  });

  it("leaves ordinary text alone", async () => {
    stubRequest();
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "fix the bug");
    expect(outcome).toEqual({ handled: false, sent: false });
  });
});

describe("sendPrompt routing", () => {
  it("consumes a command instead of sending it as a message", async () => {
    const request = stubRequest();
    const sent = await useAppStore.getState().sendPrompt("tab-1", "/new");

    expect(sent).toBe(true);
    expect(request.mock.calls.some((call) => call[0]?.method === "session.new")).toBe(true);
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(false);
  });

  it("still sends normal text as a prompt", async () => {
    const request = stubRequest();
    await useAppStore.getState().sendPrompt("tab-1", "hello there");
    const prompt = request.mock.calls.find((call) => call[0]?.method === "prompt");
    expect(prompt?.[0]?.params).toMatchObject({ text: "hello there" });
  });

  it("clears the composer text once a command is consumed", async () => {
    stubRequest();
    useAppStore.getState().setDraft("tab-1", "/help");
    await useAppStore.getState().sendPrompt("tab-1", "/help");
    expect(useAppStore.getState().prefs.drafts["tab-1"]).toBe("");
  });
});

describe("command argument transport", () => {
  it("sends the command name and full argument prefix to commands.complete", async () => {
    const request = stubRequest(async (input) =>
      input.method === "commands.complete"
        ? { items: [{ value: "use ", label: "use", description: "activate" }] }
        : {},
    );

    const items = await useAppStore
      .getState()
      .completeCommandArguments("tab-1", "profile", "use S");

    expect(items).toEqual([{ value: "use ", label: "use", description: "activate" }]);
    expect(
      request.mock.calls.find((call) => call[0]?.method === "commands.complete")?.[0]?.params,
    ).toEqual({ name: "profile", prefix: "use S" });
  });

  it("returns null for a malformed or failed completion response", async () => {
    stubRequest(async () => ({ items: [{ value: 3, label: "bad" }] }));
    await expect(
      useAppStore.getState().completeCommandArguments("tab-1", "profile", ""),
    ).resolves.toBeNull();
  });

  it("uses the app completers and loads their data only once per tab", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "model.available") {
        return {
          models: [{ id: "gpt-5", provider: "openai", name: "gpt-5" }],
          auth: {},
          thinkingLevels: ["high"],
        };
      }
      if (input.method === "providers.list") {
        return {
          providers: [
            {
              id: "openai",
              label: "OpenAI",
              authTypes: ["api_key"],
              subscription: false,
              configured: true,
              modelCount: 1,
              envVars: [],
              envAvailable: false,
            },
          ],
        };
      }
      return {};
    });

    const first = await useAppStore.getState().completeAppCommandArguments("tab-1", "model", "gpt");
    const second = await useAppStore
      .getState()
      .completeAppCommandArguments("tab-1", "model", "gpt");
    const login = await useAppStore
      .getState()
      .completeAppCommandArguments("tab-1", "login", "open");

    expect(first?.[0]).toMatchObject({ value: "openai/gpt-5", source: "app" });
    expect(second?.[0]?.value).toBe("openai/gpt-5");
    expect(login?.[0]).toMatchObject({ value: "openai", label: "openai" });
    expect(request.mock.calls.filter((call) => call[0]?.method === "model.available")).toHaveLength(
      1,
    );
    expect(request.mock.calls.filter((call) => call[0]?.method === "providers.list")).toHaveLength(
      1,
    );
  });
});

describe("completion caches", () => {
  it("fetches the command list once and reuses it", async () => {
    const request = stubRequest();
    const first = await useAppStore.getState().loadCommands("tab-1");
    const second = await useAppStore.getState().loadCommands("tab-1");

    expect(first).toHaveLength(HOST_COMMANDS.length);
    expect(second).toEqual(first);
    expect(request.mock.calls.filter((call) => call[0]?.method === "commands.list")).toHaveLength(
      1,
    );
  });

  it("re-fetches when asked to refresh", async () => {
    const request = stubRequest();
    await useAppStore.getState().loadCommands("tab-1");
    await useAppStore.getState().loadCommands("tab-1", { refresh: true });
    expect(request.mock.calls.filter((call) => call[0]?.method === "commands.list")).toHaveLength(
      2,
    );
  });

  it("drops the command list so the next lookup refetches it", async () => {
    const request = stubRequest();
    await useAppStore.getState().loadCommands("tab-1");
    useAppStore.getState().invalidateCommands("tab-1");
    await useAppStore.getState().loadCommands("tab-1");

    expect(request.mock.calls.filter((call) => call[0]?.method === "commands.list")).toHaveLength(
      2,
    );
  });

  it("caches the workspace file list", async () => {
    const request = stubRequest();
    const files = await useAppStore.getState().loadFiles("tab-1");
    expect(files?.files).toEqual(["src/app.ts"]);
    await useAppStore.getState().loadFiles("tab-1");
    expect(request.mock.calls.filter((call) => call[0]?.method === "files.list")).toHaveLength(1);
  });
});

describe("stale host banner", () => {
  it("flags an unsupported completion once and records one incident", async () => {
    const record = vi.fn(async () => true);
    (window.pi as unknown as { diagnostics: { record: typeof record } }).diagnostics.record =
      record;
    stubRequest(async (input) =>
      input.method === "commands.complete" ? { items: null, unsupported: true } : {},
    );

    await useAppStore.getState().completeCommandArguments("tab-1", "profile", "");
    await useAppStore.getState().completeCommandArguments("tab-1", "profile", "");

    expect(useAppStore.getState().staleHosts["tab-1"]).toBe(HOST_STALE_MESSAGE);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "host_stale", tabId: "tab-1" }),
    );
  });

  it("clears the banner after a successful completion", async () => {
    useAppStore.setState({ staleHosts: { "tab-1": HOST_STALE_MESSAGE } });
    stubRequest(async (input) =>
      input.method === "commands.complete" ? { items: [{ value: "use ", label: "use" }] } : {},
    );

    const items = await useAppStore.getState().completeCommandArguments("tab-1", "profile", "u");

    expect(items).toEqual([{ value: "use ", label: "use" }]);
    expect(useAppStore.getState().staleHosts["tab-1"]).toBeUndefined();
  });

  it("clears the banner on restart and on session recovery", async () => {
    useAppStore.setState({ staleHosts: { "tab-1": HOST_STALE_MESSAGE } });
    await useAppStore.getState().restartTab("tab-1");
    expect(useAppStore.getState().staleHosts["tab-1"]).toBeUndefined();

    useAppStore.setState({
      staleHosts: { "tab-1": HOST_STALE_MESSAGE },
      completionCommands: { "tab-1": HOST_COMMANDS },
    });
    useAppStore.getState().applySessionEvents({
      tabId: "tab-1",
      seq: 1,
      events: [{ event: "session.recovered", payload: {} }],
    });

    expect(useAppStore.getState().staleHosts["tab-1"]).toBeUndefined();
    expect(useAppStore.getState().completionCommands["tab-1"]).toBeUndefined();
  });
});
