import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { EXTENSION_UI_STATE_EVENT } from "../../src/shared/extension-ui";
import { installBridge } from "./fixtures";

/**
 * The renderer's extension-render store (plan step 18).
 *
 * What matters: a render request is sanitized before it reaches a card, a host
 * without the registry leaves the native card in place, and the app's expand-all
 * state is both local (for Ctrl+O) and mirrored to `ctx.ui.getToolsExpanded()`.
 */

const TAB = "tab-1";

function stubRequest(impl: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn((input: { method: string; params?: unknown }) =>
    impl(input.method, input.params),
  );
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    toolsExpanded: {},
  });
});

describe("extension render store", () => {
  it("requests a render and sanitizes the frame", async () => {
    const request = stubRequest(async (method) =>
      method === "render.request"
        ? { rendered: true, width: 80, lines: ["\x1b[32mok\x1b[0m"], junk: 1 }
        : {},
    );
    const frame = await useAppStore
      .getState()
      .extensionRender(TAB, { target: "tool", type: "bash", width: 80, expanded: false });

    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "render.request",
      params: { target: "tool", type: "bash", width: 80, expanded: false },
    });
    expect(frame).toEqual({ rendered: true, width: 80, lines: ["\x1b[32mok\x1b[0m"] });
  });

  it("returns null when the host cannot render (the native card stays)", async () => {
    stubRequest(async () => {
      throw new Error("not_implemented");
    });
    await expect(
      useAppStore
        .getState()
        .extensionRender(TAB, { target: "message", type: "todo", width: 40, expanded: false }),
    ).resolves.toBeNull();
  });

  it("applies the registered markdown transformers", async () => {
    const request = stubRequest(async (method) =>
      method === "render.markdown" ? { text: "transformed", transformed: true } : {},
    );
    const result = await useAppStore.getState().extensionMarkdown(TAB, {
      text: "raw",
      messageType: "assistant",
      isStreaming: false,
      width: 80,
    });
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "render.markdown",
      params: { text: "raw", messageType: "assistant", isStreaming: false, width: 80 },
    });
    expect(result).toEqual({ text: "transformed", transformed: true });
  });

  it("toggles expand-all and mirrors it to the host", () => {
    const request = stubRequest(async () => ({ ok: true }));
    useAppStore.getState().toggleToolsExpanded(TAB);
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(true);
    expect(request).toHaveBeenCalledWith({
      tabId: TAB,
      method: "oi.setToolsExpanded",
      params: { expanded: true },
    });

    useAppStore.getState().toggleToolsExpanded(TAB);
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(false);
  });

  it("adopts an extension's expand state from an oi.state push", () => {
    useAppStore.getState().handleExtensionUiEvent(TAB, {
      event: EXTENSION_UI_STATE_EVENT,
      payload: { toolsExpanded: true },
    });
    expect(useAppStore.getState().toolsExpanded[TAB]).toBe(true);
  });
});
