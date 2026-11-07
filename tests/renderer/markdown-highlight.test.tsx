import { fireEvent, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodeBlock, Markdown } from "../../src/renderer/src/session/Markdown";
import { FindPatternContext } from "../../src/renderer/src/session/find-context";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";

/**
 * Highlight stability contract (2026-11-07 transcript-highlight-stability).
 *
 * Two separate defects used to make a coloured code block flash to plain text:
 *
 * 1. `Markdown` rebuilt its `components` map on every render, so every custom
 *    renderer was a new React element type. React unmounted and remounted the
 *    whole Markdown subtree on any re-render (a store push, a click, focus
 *    re-sync), and `CodeBlock`'s component-local token state was lost.
 * 2. `CodeBlock` kept tokens only in local state, so a genuine remount (a
 *    virtualized row scrolling out of the overscan window) painted the plain
 *    source before the async highlight resolved.
 *
 * These tests assert DOM identity across a re-render and first-paint colour
 * after a remount. Both are written against a deterministic fake highlighter so
 * the assertion is about timing, not about Shiki's grammars.
 */

vi.mock("shiki/bundle/web", () => ({
  createHighlighter: async () => ({
    loadLanguage: async () => undefined,
    codeToTokens: (code: string) => ({
      tokens: code.split("\n").map((line) => [{ content: line, color: "#ff0000" }]),
    }),
  }),
}));

const COLOURED_TOKEN = "pre span[style]";

beforeEach(() => {
  // The transcript surface reads prefs/settings (Mermaid fences, themes).
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS }, settings: { global: {}, project: {} } });
});

describe("Markdown re-render keeps the highlighted subtree", () => {
  it("keeps the same <pre> node and its colours across a re-render", async () => {
    const source = "```bash\n# comment for the identity test\necho hello\n```";
    const view = render(<Markdown>{source}</Markdown>);

    await waitFor(() => expect(view.container.querySelector(COLOURED_TOKEN)).not.toBeNull());
    const pre = view.container.querySelector("pre");
    expect(pre).not.toBeNull();

    // The same children with a different wrapper class forces a re-render of
    // `Markdown` — exactly what a store push, a click or the focus re-sync does.
    view.rerender(<Markdown className="forced-rerender">{source}</Markdown>);

    // Same DOM node: no unmount/remount happened.
    expect(view.container.querySelector("pre")).toBe(pre);
    // Colour is on the first paint after the re-render, not one frame later.
    expect(view.container.querySelector(COLOURED_TOKEN)).not.toBeNull();
  });

  it("keeps the colours while a parent re-renders around it", async () => {
    const source = "```bash\n# parent rerender\necho second\n```";
    const view = render(
      <div>
        <Markdown>{source}</Markdown>
      </div>,
    );

    await waitFor(() => expect(view.container.querySelector(COLOURED_TOKEN)).not.toBeNull());

    view.rerender(
      <div data-parent-revision="1">
        <Markdown>{source}</Markdown>
      </div>,
    );

    expect(view.container.querySelector(COLOURED_TOKEN)).not.toBeNull();
  });

  it("survives a click-driven state update, the pointer-down re-render path", async () => {
    // `SessionView` calls `ensureSession` on every pointer-down and focus re-sync
    // writes store slices; both re-render the transcript around a mounted block.
    function Harness(): React.ReactElement {
      const [revision, setRevision] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => setRevision((value) => value + 1)}>
            bump
          </button>
          <div data-revision={revision}>
            <Markdown>{"```bash\n# click rerender\necho hi\n```"}</Markdown>
          </div>
        </div>
      );
    }

    const view = render(<Harness />);
    await waitFor(() => expect(view.container.querySelector(COLOURED_TOKEN)).not.toBeNull());
    const pre = view.container.querySelector("pre");

    fireEvent.click(view.getByRole("button", { name: "bump" }));

    expect(view.container.querySelector("pre")).toBe(pre);
    expect(view.container.querySelector(COLOURED_TOKEN)).not.toBeNull();
  });
});

describe("CodeBlock remount paints colour immediately", () => {
  it("renders tokens synchronously after an unmount/remount of the same block", async () => {
    const code = "# remount identity\necho again";
    const first = render(<CodeBlock code={code} language="bash" />);
    await waitFor(() => expect(first.container.querySelector(COLOURED_TOKEN)).not.toBeNull());
    first.unmount();

    // A virtualized row that left the overscan window mounts fresh; the cache is
    // what lets this paint colour without waiting a frame.
    const second = render(<CodeBlock code={code} language="bash" />);
    expect(second.container.querySelector(COLOURED_TOKEN)).not.toBeNull();
  });
});

describe("context still reaches a memoized Markdown", () => {
  it("paints find marks when the pattern arrives after the first render", async () => {
    const view = render(
      <FindPatternContext.Provider value={null}>
        <Markdown>{"the needle is here"}</Markdown>
      </FindPatternContext.Provider>,
    );
    expect(view.container.querySelector("mark.pi-find")).toBeNull();

    view.rerender(
      <FindPatternContext.Provider value={/needle/gi}>
        <Markdown>{"the needle is here"}</Markdown>
      </FindPatternContext.Provider>,
    );

    expect(view.container.querySelector("mark.pi-find")?.textContent).toBe("needle");
  });
});
