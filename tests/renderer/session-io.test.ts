import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { TabRecord } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * `/export jsonl` and `/import` (2026-10-26 session-parity plan step 14).
 *
 * Terminal Pi round-trips sessions as JSONL through Pi's own writer/reader; the
 * desktop had HTML only. The import is confirmed before the open conversation is
 * replaced, and the transcript is re-hydrated from the imported session.
 */

const TAB = "tab-1";

function tab(): TabRecord {
  return {
    id: TAB,
    kind: "session",
    cwd: "/work/app",
    title: "app",
    sessionFile: "/profile/s1.jsonl",
    status: "running",
    createdAt: 0,
    lastActiveAt: 0,
    model: "test-model",
  };
}

function stubRequest(impl: (input: { method: string; params?: unknown }) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => impl(input));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    tabs: [tab()],
    activeTabId: TAB,
    transcripts: {},
    importPrompt: null,
    hint: null,
  });
});

describe("/export", () => {
  it("exports HTML by default", async () => {
    const request = stubRequest(async (input) =>
      input.method === "session.exportHtml" ? { path: "/tmp/s1.html" } : {},
    );
    const reveal = vi.fn(async () => true);
    (window.pi as unknown as { revealPath: unknown }).revealPath = reveal;

    await useAppStore.getState().runCommandInput(TAB, "/export");

    expect(request).toHaveBeenCalledWith({ tabId: TAB, method: "session.exportHtml" });
    expect(useAppStore.getState().hint).toMatch(/Exported to \/tmp\/s1\.html/);
  });

  it("exports JSONL when asked and reveals the path", async () => {
    const request = stubRequest(async (input) =>
      input.method === "session.exportJsonl" ? { path: "/tmp/s1.jsonl" } : {},
    );
    const reveal = vi.fn(async () => true);
    (window.pi as unknown as { revealPath: unknown }).revealPath = reveal;

    await useAppStore.getState().runCommandInput(TAB, "/export jsonl");

    expect(request).toHaveBeenCalledWith({ tabId: TAB, method: "session.exportJsonl" });
    expect(reveal).toHaveBeenCalledWith("/tmp/s1.jsonl");
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.exportHtml" }),
    );
  });

  it("names the two formats for an unknown one", async () => {
    const request = stubRequest(async () => ({}));
    await useAppStore.getState().runCommandInput(TAB, "/export pdf");
    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().hint).toMatch(/html.*jsonl/i);
  });
});

describe("/import", () => {
  it("asks before replacing the session and reads the picked file", async () => {
    stubRequest(async () => ({}));
    const pickFile = vi.fn(async () => "/tmp/import.jsonl");
    (window.pi as unknown as { pickFile: unknown }).pickFile = pickFile;

    await useAppStore.getState().runCommandInput(TAB, "/import");

    expect(pickFile).toHaveBeenCalled();
    expect(useAppStore.getState().importPrompt).toEqual({
      tabId: TAB,
      path: "/tmp/import.jsonl",
    });
  });

  it("imports only after confirmation, then resets and hydrates", async () => {
    const request = stubRequest(async (input) => {
      if (input.method === "messages.get") {
        return { messages: [{ role: "assistant", content: [{ type: "text", text: "imported" }] }] };
      }
      return {};
    });
    useAppStore.setState({ importPrompt: { tabId: TAB, path: "/tmp/import.jsonl" } });

    await useAppStore.getState().confirmImport();

    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "session.importJsonl",
      params: { path: "/tmp/import.jsonl" },
    });
    expect(useAppStore.getState().importPrompt).toBeNull();
    await vi.waitFor(() => {
      const items = useAppStore.getState().transcripts[TAB]?.items ?? [];
      expect(
        items.some(
          (item) =>
            item.kind === "message" &&
            item.message.blocks.some((block) => block.kind === "text" && block.text === "imported"),
        ),
      ).toBe(true);
    });
  });

  it("does nothing when cancelled", async () => {
    const request = stubRequest(async () => ({}));
    useAppStore.setState({ importPrompt: { tabId: TAB, path: "/tmp/import.jsonl" } });

    useAppStore.getState().cancelImport();

    expect(useAppStore.getState().importPrompt).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a typed path from the command line", async () => {
    stubRequest(async () => ({}));
    const pickFile = vi.fn(async () => null);
    (window.pi as unknown as { pickFile: unknown }).pickFile = pickFile;

    await useAppStore.getState().runCommandInput(TAB, "/import C:/tmp/session.jsonl");

    expect(pickFile).not.toHaveBeenCalled();
    expect(useAppStore.getState().importPrompt?.path).toBe("C:/tmp/session.jsonl");
  });
});
