import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExtensionBlock } from "../../src/renderer/src/session/ExtensionBlock";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * The extension-renderer card body (plan step 18).
 *
 * A registered renderer's ANSI frame replaces the native card; no renderer (or a
 * failed request) leaves the native card, which is Pi's own fallback. The frame
 * is debounced, so a streaming tool does not issue one request per delta.
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
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS, drafts: {} }, toolsExpanded: {} });
});

describe("ExtensionBlock", () => {
  it("shows the host's ANSI frame when the item has a renderer", async () => {
    stubRequest(async (method) =>
      method === "render.request"
        ? { rendered: true, width: 40, lines: ["\x1b[32mrendered by extension\x1b[0m"] }
        : {},
    );
    render(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "tool", type: "bash", toolCallId: "t1", version: 1 }}
        expanded={false}
        fallback={<span>native card</span>}
      />,
    );

    expect(await screen.findByText("rendered by extension")).toBeInTheDocument();
    expect(screen.queryByText("native card")).not.toBeInTheDocument();
  });

  it("keeps the native card when there is no renderer", async () => {
    stubRequest(async () => ({ rendered: false, width: 40, lines: [] }));
    render(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "tool", type: "read", toolCallId: "t1", version: 1 }}
        expanded={false}
        fallback={<span>native card</span>}
      />,
    );

    expect(await screen.findByText("native card")).toBeInTheDocument();
  });

  it("keeps the native card when the request fails", async () => {
    stubRequest(async () => {
      throw new Error("not_implemented");
    });
    render(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "message", type: "todo", version: 1 }}
        expanded={false}
        fallback={<span>native card</span>}
      />,
    );

    expect(await screen.findByText("native card")).toBeInTheDocument();
  });

  it("re-requests with the expand state and the content version", async () => {
    const request = stubRequest(async () => ({ rendered: false, width: 40, lines: [] }));
    const { rerender } = render(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "tool", type: "bash", toolCallId: "t1", version: 1 }}
        expanded={false}
        fallback={<span>native</span>}
      />,
    );
    rerender(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "tool", type: "bash", toolCallId: "t1", version: 2 }}
        expanded
        fallback={<span>native</span>}
      />,
    );

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "render.request",
          params: expect.objectContaining({ expanded: true, target: "tool" }),
        }),
      );
    });
  });

  it("hides the fallback for a rendererless entry when asked", async () => {
    // Pi renders nothing for a bare `CustomEntry` with no registered renderer
    // (`addCustomEntryToChat` → `hasContent()`); this is what keeps the workflow
    // extension's state entries out of the transcript.
    stubRequest(async () => ({ rendered: false, width: 40, lines: [] }));
    const { container } = render(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "entry", type: "workflow", version: 1 }}
        expanded={false}
        fallback={<span>native card</span>}
        hideWhenUnrendered
      />,
    );

    await vi.waitFor(() => {
      // The request must still be made (the measurement drives the render)…
      expect(container.querySelector("[data-extension-render]")).not.toBeNull();
    });
    expect(screen.queryByText("native card")).not.toBeInTheDocument();
  });

  it("shows the fallback for an entry whose renderer threw", async () => {
    // Pi shows an error box when a renderer exists but fails, so a failure must
    // not be silently swallowed the way a missing renderer is.
    stubRequest(async () => ({ rendered: false, width: 40, lines: [], error: "boom" }));
    render(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "entry", type: "workflow", version: 1 }}
        expanded={false}
        fallback={<span>native card</span>}
        hideWhenUnrendered
      />,
    );

    expect(await screen.findByText("native card")).toBeInTheDocument();
  });

  it("still shows an ANSI frame for an entry that does have a renderer", async () => {
    stubRequest(async () => ({ rendered: true, width: 40, lines: ["review band"] }));
    render(
      <ExtensionBlock
        tabId={TAB}
        input={{ target: "entry", type: "workflow-review-mode", version: 1 }}
        expanded={false}
        fallback={<span>native card</span>}
        hideWhenUnrendered
      />,
    );

    expect(await screen.findByText("review band")).toBeInTheDocument();
    expect(screen.queryByText("native card")).not.toBeInTheDocument();
  });
});
