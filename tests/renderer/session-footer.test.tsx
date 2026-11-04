import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionFooter } from "../../src/renderer/src/session/SessionFooter";

/**
 * The Pi-shaped session footer (minimal-session-ui step 6).
 *
 * `ComposerFooter` used to render a bespoke facts row, a context row and a
 * derived `mode: …` chip. The replacement follows terminal Pi: pwd (branch),
 * tokens/cost/context + model • thinking, then the extension statuses. The chip
 * is gone because the composer names the mode now, and the status line is where
 * `ctx.ui.setStatus` values (pi-lens, Office bridge) live.
 */

const CONTEXT = { percent: 42, tokens: 12_345, contextWindow: 200_000 };
const USAGE = { input: 12_340, output: 4_560, cacheRead: 1000, cacheWrite: 0 };

describe("SessionFooter", () => {
  it("renders the pwd, stats/context, model and status rows", () => {
    render(
      <SessionFooter
        homeDir={"C:\\Users\\me"}
        facts={{
          cwd: "C:\\Users\\me\\app",
          branch: "main",
          model: "anthropic/claude-sonnet-4",
          modelId: "claude-sonnet-4",
          thinking: "medium",
          context: CONTEXT,
          cost: 0.0432,
          usage: USAGE,
        }}
        statuses={{ "pi-lens-lsp": "LSP ✓ tsserver" }}
      />,
    );

    expect(screen.getByTestId("session-footer")).toBeInTheDocument();
    expect(screen.getByTestId("session-footer-pwd")).toHaveTextContent("~\\app (main)");
    expect(screen.getByText("↑12.3k ↓4.6k R1.0k $0.043")).toBeInTheDocument();
    expect(screen.getByTestId("session-footer-context")).toHaveTextContent("42%/200.0k");
    expect(screen.getByTestId("session-footer-model")).toHaveTextContent(
      "claude-sonnet-4 • medium",
    );
    expect(screen.getByTestId("extension-status-pi-lens-lsp")).toHaveTextContent("LSP ✓ tsserver");
  });

  it("uses the full path and model key in titles", () => {
    const cwd = "C:\\Users\\someone\\very\\deeply\\nested\\workspace\\project-folder";
    render(
      <SessionFooter
        homeDir={"C:\\Users\\me"}
        facts={{ cwd, model: "anthropic/claude-sonnet-4", modelId: "claude-sonnet-4" }}
      />,
    );

    const pwd = screen.getByTestId("session-footer-pwd");
    expect(pwd.textContent).not.toBe(cwd);
    expect(pwd).toHaveAttribute("title", cwd);
    expect(screen.getByTestId("session-footer-model")).toHaveAttribute(
      "title",
      "anthropic/claude-sonnet-4",
    );
  });

  it("puts the token/provider/auto detail in the stats row title", () => {
    render(
      <SessionFooter
        facts={{
          context: CONTEXT,
          cost: 0.01,
          usage: USAGE,
          model: "anthropic/claude",
          provider: "anthropic",
          auto: { compaction: true, retry: false },
        }}
      />,
    );

    const title = screen.getByTestId("session-footer-context").parentElement?.getAttribute("title");
    expect(title).toContain("in 12.3k");
    expect(title).toContain("out 4.6k");
    expect(title).toContain("cache r 1.0k / w 0");
    expect(title).toContain("model anthropic/claude");
    expect(title).toContain("provider anthropic");
    expect(title).toContain("auto-compaction");
    // Pi appends the marker to the context chunk.
    expect(screen.getByTestId("session-footer-context")).toHaveTextContent("(auto)");
  });

  it("marks the context tone at Pi's thresholds", () => {
    const view = render(<SessionFooter facts={{ context: { ...CONTEXT, percent: 72 } }} />);
    expect(screen.getByTestId("session-footer-context")).toHaveClass("text-warn");
    view.unmount();

    render(<SessionFooter facts={{ context: { ...CONTEXT, percent: 95 } }} />);
    expect(screen.getByTestId("session-footer-context")).toHaveClass("text-danger");
  });

  it("sorts statuses by key and keeps ANSI colour out of the text", () => {
    render(
      <SessionFooter
        facts={{}}
        statuses={{ workflow: "\x1b[33m⏸ plan\x1b[0m", autocompact: "idle" }}
      />,
    );

    const items = screen
      .getByTestId("session-footer-statuses")
      .querySelectorAll("[data-testid^='extension-status-']");
    expect([...items].map((node) => node.getAttribute("data-testid"))).toEqual([
      "extension-status-autocompact",
      "extension-status-workflow",
    ]);

    const workflow = screen.getByTestId("extension-status-workflow");
    expect(workflow.textContent).toBe("⏸ plan");
    expect(workflow.textContent).not.toContain("\x1b");
    expect(workflow.querySelector("[style]")).not.toBeNull();
    expect(workflow).toHaveAttribute("title", "Extension status: workflow\n⏸ plan");
  });

  it("renders the status row even without session facts", () => {
    render(<SessionFooter facts={{}} statuses={{ "server-logs": "tailing app.log" }} />);
    expect(screen.getByTestId("session-footer-statuses")).toBeInTheDocument();
    expect(screen.getByText("tailing app.log")).toBeInTheDocument();
  });

  it("has no mode chip (the composer names the mode now)", () => {
    render(<SessionFooter facts={{ cwd: "/w" }} statuses={{ workflow: "⏸ plan" }} />);
    expect(screen.queryByTestId("composer-mode")).toBeNull();
    expect(screen.queryByText(/^mode: /i)).toBeNull();
  });

  it("renders one wrapping rail with the facts and statuses as columns", () => {
    render(
      <SessionFooter
        facts={{
          cwd: "C:\\Users\\me\\app",
          modelId: "claude-sonnet-4",
          thinking: "medium",
          context: CONTEXT,
          cost: 0.0432,
          usage: USAGE,
        }}
        statuses={{ "pi-lens-lsp": "LSP ✓ tsserver" }}
      />,
    );

    const footer = screen.getByTestId("session-footer");
    expect(footer.className).toContain("flex-wrap");
    expect(footer.className).not.toContain("flex-col");
    // A fixed, two-line viewport: mode-dependent statuses scroll instead of
    // changing the composer/footer height (2026-10-31 UI plan).
    expect(footer.className).toContain("h-10");
    expect(footer.className).toContain("overflow-y-auto");
    expect(footer.className).toContain("overflow-x-hidden");
    // pwd, stats/context, statuses and model are direct columns of the rail.
    expect(screen.getByTestId("session-footer-pwd").parentElement).toBe(footer);
    expect(screen.getByTestId("session-footer-statuses").parentElement).toBe(footer);
    expect(screen.getByTestId("session-footer-model").parentElement).toBe(footer);
    expect(screen.getByTestId("extension-status-pi-lens-lsp").className).toContain("max-w-[48ch]");
  });

  it("keeps every overflowing status in the scrollable rail", () => {
    const statuses = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`status-${index}`, `value ${index}`]),
    );
    render(<SessionFooter facts={{}} statuses={statuses} />);
    const footer = screen.getByTestId("session-footer");
    expect(footer.className).toContain("h-10");
    expect(footer.className).toContain("overflow-y-auto");
    for (let index = 0; index < 8; index += 1) {
      expect(screen.getByTestId(`extension-status-status-${index}`)).toBeInTheDocument();
    }
  });

  it("renders single-line widgets inline and counts them as content", () => {
    render(
      <SessionFooter
        facts={{}}
        widgets={<span data-testid="inline-widget">pi-lens compact</span>}
      />,
    );
    expect(screen.getByTestId("session-footer")).toBeInTheDocument();
    expect(screen.getByTestId("inline-widget").parentElement).toBe(
      screen.getByTestId("session-footer"),
    );
  });

  it("renders nothing when there is nothing to say", () => {
    const { container } = render(<SessionFooter facts={{}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
