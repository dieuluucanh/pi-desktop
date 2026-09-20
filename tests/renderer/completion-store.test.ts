import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
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
    sendModes: {},
    draftHistory: {},
    historyIndex: {},
    completionCommands: {},
    completionFiles: {},
    modelCatalog: {},
    providerAuth: {},
    thinkingLevels: {},
    picker: null,
    view: "session",
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

  it("handles extension commands as prompts so the SDK expands them", async () => {
    const request = stubRequest();
    const outcome = await useAppStore.getState().runCommandInput("tab-1", "/deploy now");

    expect(outcome).toEqual({ handled: true, sent: true });
    const prompt = request.mock.calls.find((call) => call[0]?.method === "prompt");
    expect(prompt?.[0]?.params).toMatchObject({ text: "/deploy now" });
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

    // …but picking the extension's entry sends it to the prompt instead.
    await useAppStore.getState().runCommandInput("tab-1", "/model", "extension");
    expect(request.mock.calls.some((call) => call[0]?.method === "prompt")).toBe(true);
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

describe("completion caches", () => {
  it("fetches the command list once and reuses it", async () => {
    const request = stubRequest();
    const first = await useAppStore.getState().loadCommands("tab-1");
    const second = await useAppStore.getState().loadCommands("tab-1");

    expect(first).toHaveLength(2);
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

  it("caches the workspace file list", async () => {
    const request = stubRequest();
    const files = await useAppStore.getState().loadFiles("tab-1");
    expect(files?.files).toEqual(["src/app.ts"]);
    await useAppStore.getState().loadFiles("tab-1");
    expect(request.mock.calls.filter((call) => call[0]?.method === "files.list")).toHaveLength(1);
  });
});
