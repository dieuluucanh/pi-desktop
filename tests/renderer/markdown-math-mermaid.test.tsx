import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "../../src/renderer/src/session/Markdown";
import {
  normalizeMermaidMode,
  shouldRenderMermaid,
} from "../../src/renderer/src/session/mermaid-mode";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * Markdown math and Mermaid (2026-10-26 session-parity plan step 19).
 *
 * Terminal Pi renders LaTeX everywhere and Mermaid per `markdown.mermaid`. The
 * desktop keeps the same setting contract, and any diagram failure falls back to
 * the code block rather than an empty box.
 */

beforeEach(() => {
  installBridge();
  useAppStore.setState({ prefs: { ...DEFAULT_PREFS }, settings: { global: {}, project: {} } });
});

describe("mermaid policy", () => {
  it("normalizes unknown values to final", () => {
    expect(normalizeMermaidMode("off")).toBe("off");
    expect(normalizeMermaidMode("streaming")).toBe("streaming");
    expect(normalizeMermaidMode("final")).toBe("final");
    expect(normalizeMermaidMode(undefined)).toBe("final");
    expect(normalizeMermaidMode("nonsense")).toBe("final");
  });

  it("off never draws, final waits for the stream to end, streaming draws now", () => {
    expect(shouldRenderMermaid("off", false)).toBe(false);
    expect(shouldRenderMermaid("off", true)).toBe(false);
    expect(shouldRenderMermaid("final", true)).toBe(false);
    expect(shouldRenderMermaid("final", false)).toBe(true);
    expect(shouldRenderMermaid("streaming", true)).toBe(true);
  });
});

describe("LaTeX", () => {
  it("renders inline math", () => {
    const { container } = render(<Markdown>{"Energy is $E = mc^2$ exactly."}</Markdown>);
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain("mc");
  });

  it("renders block math", () => {
    const { container } = render(
      <Markdown>{"Before\n\n$$\n\\int_0^1 x^2\\,dx\n$$\n\nAfter"}</Markdown>,
    );
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("leaves a lone dollar amount as text", () => {
    const { container } = render(<Markdown>{"It costs $5 today."}</Markdown>);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$5 today");
  });
});

describe("Mermaid", () => {
  it("renders a code block when the setting is off", () => {
    useAppStore.setState({ settings: { global: { markdown: { mermaid: "off" } }, project: {} } });
    render(<Markdown>{"```mermaid\ngraph TD; A-->B\n```"}</Markdown>);
    expect(screen.getByTestId("mermaid-fallback")).toBeInTheDocument();
    expect(screen.getByTestId("mermaid-fallback").textContent).toContain("graph TD");
  });

  it("waits for the message to finish under `final`", () => {
    useAppStore.setState({ settings: { global: { markdown: { mermaid: "final" } }, project: {} } });
    render(<Markdown streaming>{"```mermaid\ngraph TD; A-->B\n```"}</Markdown>);
    expect(screen.getByTestId("mermaid-fallback")).toBeInTheDocument();
  });

  it("leaves a plain code fence untouched", () => {
    const { container } = render(<Markdown>{"```ts\nconst a = 1;\n```"}</Markdown>);
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(screen.queryByTestId("mermaid-fallback")).toBeNull();
  });
});
