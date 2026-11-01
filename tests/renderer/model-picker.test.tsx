import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../src/renderer/src/session/ModelPicker";
import { ThinkingPicker } from "../../src/renderer/src/session/ThinkingPicker";
import { ContextRing, contextRingLabel } from "../../src/renderer/src/session/ContextRing";
import { toCatalog } from "../../src/renderer/src/session/model-catalog";

/**
 * The model/thinking/usage UI (plan step 8). The behaviours worth pinning:
 * an unconfigured provider offers "Sign in" instead of failing later, the
 * thinking list can only contain levels the model supports, and the ring shows
 * Pi's own percentage (0–100, not a fraction).
 */

const CATALOG = toCatalog([
  { id: "claude-sonnet-4-5", provider: "anthropic", name: "Sonnet 4.5" },
  { id: "gpt-5", provider: "openai", name: "GPT-5" },
]);
const AUTH = {
  anthropic: { configured: true, source: "stored", label: "keychain" },
  openai: { configured: false },
};

function renderPicker(overrides: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  const onPick = vi.fn();
  const onToggleScope = vi.fn();
  const onSignIn = vi.fn();
  const onOpenModelsJson = vi.fn();
  const onClose = vi.fn();
  render(
    <ModelPicker
      open
      entries={CATALOG}
      auth={AUTH}
      currentKey="anthropic/claude-sonnet-4-5"
      scoped={[]}
      onPick={onPick}
      onToggleScope={onToggleScope}
      onSignIn={onSignIn}
      onOpenModelsJson={onOpenModelsJson}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onPick, onToggleScope, onSignIn, onOpenModelsJson, onClose };
}

describe("ModelPicker", () => {
  it("groups models by provider and marks the current one", () => {
    renderPicker();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("openai")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Sonnet 4\.5/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("option", { name: /GPT-5/ })).toHaveAttribute("aria-selected", "false");
  });

  it("previews each model's supported thinking levels", () => {
    const entries = toCatalog(
      [
        { id: "deepseek", provider: "synthetic", name: "DeepSeek" },
        { id: "plain", provider: "synthetic", name: "Plain" },
      ],
      {
        "synthetic/deepseek": ["off", "low", "high", "xhigh", "max"],
      },
    );
    renderPicker({ entries });

    const deepseek = screen.getByText("off/low/high/xhigh/max");
    expect(deepseek).toHaveAttribute("title", "Supports thinking: off, low, high, xhigh, max");
    // A model with no capability entry shows no extra span.
    expect(screen.queryByText("off", { exact: true })).toBeNull();
  });

  it("shows the credential state, and offers Sign in when there is none", async () => {
    const user = userEvent.setup();
    const { onSignIn } = renderPicker();
    expect(screen.getByText("keychain")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in to openai" }));
    expect(onSignIn).toHaveBeenCalledWith("openai");
  });

  it("warns when providers still need credentials", () => {
    renderPicker();
    expect(screen.getByTestId("signed-out-note")).toHaveTextContent("1 provider");
  });

  it("starts with the search a /model command supplied", () => {
    renderPicker({ initialQuery: "gpt" });
    expect(screen.getByLabelText("Search models")).toHaveValue("gpt");
    expect(screen.getByText("GPT-5")).toBeInTheDocument();
    expect(screen.queryByText("Sonnet 4.5")).toBeNull();
  });

  it("filters by search", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(screen.getByLabelText("Search models"), "gpt");
    expect(screen.queryByRole("option", { name: /Sonnet 4\.5/ })).toBeNull();
    expect(screen.getByRole("option", { name: /GPT-5/ })).toBeInTheDocument();
  });

  it("always saves the picked model as the default", async () => {
    const user = userEvent.setup();
    const { onPick } = renderPicker();
    await user.click(screen.getByRole("option", { name: /GPT-5/ }));
    expect(onPick).toHaveBeenCalledWith(CATALOG[1], { persist: true });
  });

  it("no longer offers a save-as-default switch", () => {
    renderPicker();
    expect(screen.queryByLabelText("Save as default")).toBeNull();
    expect(screen.queryByText("Save as default")).toBeNull();
  });

  it("toggles a model in the scope from the star", async () => {
    const user = userEvent.setup();
    const { onToggleScope } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Add openai / GPT-5 to scope" }));
    expect(onToggleScope).toHaveBeenCalledWith(CATALOG[1]);
  });

  it("lists the scoped models first, in scope order", () => {
    renderPicker({ scoped: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"] });
    const sections = screen.getByTestId("model-list").querySelectorAll("h3");
    expect(sections[0]?.textContent).toContain("Scoped (2)");
    expect(screen.queryByTestId("no-scope-note")).toBeNull();
  });

  it("explains that an empty scope still offers every model", () => {
    renderPicker();
    expect(screen.getByTestId("no-scope-note")).toHaveTextContent(/every model is available/);
  });

  it("disables the star while that model's scope write is in flight", () => {
    renderPicker({ scoped: ["openai/gpt-5"], scopeBusyKey: "openai/gpt-5" });
    expect(screen.getByRole("button", { name: "Remove openai / GPT-5 from scope" })).toBeDisabled();
  });

  it("prefixes scoped rows when two providers share a model name", () => {
    const entries = toCatalog([
      { id: "kimi", provider: "moonshotai", name: "Kimi" },
      { id: "kimi", provider: "synthetic", name: "Kimi" },
    ]);
    renderPicker({ entries, scoped: ["moonshotai/kimi", "synthetic/kimi"] });

    const list = screen.getByTestId("model-list");
    const options = within(list).getAllByRole("option", { name: /Kimi/ });
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAccessibleName("moonshotai / Kimi");
    expect(options[1]).toHaveAccessibleName("synthetic / Kimi");
    // The visible prefix is what disambiguates the rows.
    expect(within(list).getByText("moonshotai /")).toHaveAttribute(
      "data-model-provider",
      "moonshotai",
    );
    expect(within(list).getByText("synthetic /")).toHaveAttribute(
      "data-model-provider",
      "synthetic",
    );
    // Provider groups keep their heading, so their rows stay uncluttered.
    expect(within(list).queryByText("anthropic /")).toBeNull();
  });

  it("shows a picker-scoped error when one is set, and none otherwise", () => {
    const { rerender } = render(
      <ModelPicker
        open
        entries={CATALOG}
        auth={AUTH}
        scoped={[]}
        onPick={vi.fn()}
        onToggleScope={vi.fn()}
        onSignIn={vi.fn()}
        onOpenModelsJson={vi.fn()}
        onClose={vi.fn()}
        error="No API key for synthetic/other-model"
      />,
    );
    expect(screen.getByTestId("model-picker-error")).toHaveTextContent(
      "No API key for synthetic/other-model",
    );
    rerender(
      <ModelPicker
        open
        entries={CATALOG}
        auth={AUTH}
        scoped={[]}
        onPick={vi.fn()}
        onToggleScope={vi.fn()}
        onSignIn={vi.fn()}
        onOpenModelsJson={vi.fn()}
        onClose={vi.fn()}
        error={null}
      />,
    );
    expect(screen.queryByTestId("model-picker-error")).toBeNull();
  });

  it("offers the models.json entry point", async () => {
    const user = userEvent.setup();
    const { onOpenModelsJson } = renderPicker();
    await user.click(screen.getByRole("button", { name: /models\.json/ }));
    expect(onOpenModelsJson).toHaveBeenCalledTimes(1);
  });
});

describe("ThinkingPicker", () => {
  function levelRow(level: string): HTMLButtonElement {
    const node = screen
      .getByTestId("thinking-levels")
      .querySelector(`button[data-level="${level}"]`);
    if (!(node instanceof HTMLButtonElement)) throw new Error(`no row for ${level}`);
    return node;
  }

  it("shows the full scale and disables levels the model does not support", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(
      <ThinkingPicker
        open
        levels={["off", "high"]}
        current="high"
        onPick={onPick}
        onClose={vi.fn()}
      />,
    );

    const rows = [...screen.getByTestId("thinking-levels").querySelectorAll("button[data-level]")];
    expect(rows.map((node) => node.getAttribute("data-level"))).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(rows.map((node) => node.getAttribute("data-supported"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(levelRow("high")).toHaveAttribute("aria-selected", "true");

    // Unsupported rows are visible but cannot be picked.
    const medium = levelRow("medium");
    expect(medium).toBeDisabled();
    expect(within(medium).getByText("not supported")).toBeInTheDocument();
    await user.click(medium);
    expect(onPick).not.toHaveBeenCalled();

    await user.click(levelRow("off"));
    expect(onPick).toHaveBeenCalledWith("off", { persist: true });
  });

  it("updates the enabled set when the selected model changes", () => {
    const { rerender } = render(
      <ThinkingPicker
        open
        levels={["low", "high", "max"]}
        current="high"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(levelRow("medium")).toBeDisabled();
    expect(levelRow("off")).toBeDisabled();

    rerender(
      <ThinkingPicker
        open
        levels={["off", "minimal", "low", "medium", "high", "xhigh", "max"]}
        current="high"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(levelRow("medium")).toBeEnabled();
    expect(levelRow("off")).toBeEnabled();
  });

  it("no longer offers a save-as-default switch", () => {
    render(
      <ThinkingPicker
        open
        levels={["off", "high"]}
        current="high"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("Save as default")).toBeNull();
  });

  it("says so when the model cannot think, and disables the whole scale", () => {
    render(<ThinkingPicker open levels={[]} current={null} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/does not support thinking levels/)).toBeInTheDocument();
    const rows = [...screen.getByTestId("thinking-levels").querySelectorAll("button[data-level]")];
    expect(rows).toHaveLength(7);
    for (const row of rows) expect(row).toBeDisabled();
  });

  it("orders the full scale, names the model and describes every level", () => {
    render(
      <ThinkingPicker
        open
        levels={["max", "low", "off", "high", "xhigh"]}
        current="max"
        modelLabel="synthetic/deepseek"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const levels = [
      ...screen.getByTestId("thinking-levels").querySelectorAll("button[data-level]"),
    ].map((node) => node.getAttribute("data-level"));
    expect(levels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(screen.getByText(/Levels supported by synthetic\/deepseek\./)).toBeInTheDocument();
    expect(screen.getByText("Maximum reasoning effort")).toBeInTheDocument();
    expect(screen.getByText("Extra-high reasoning effort")).toBeInTheDocument();
    expect(levelRow("max")).toHaveAttribute("aria-selected", "true");
  });

  it("shows a custom level as its own enabled row", () => {
    render(
      <ThinkingPicker
        open
        levels={["off", "ultra"]}
        current="off"
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("Custom level")).toBeInTheDocument();
    const ultra = levelRow("ultra");
    expect(ultra).toBeEnabled();
    expect(ultra).toHaveAttribute("data-supported", "true");
  });
});

describe("ContextRing", () => {
  it("draws the fraction Pi's percentage implies", () => {
    render(<ContextRing usage={{ tokens: 42_000, contextWindow: 100_000, percent: 42 }} />);
    const label = screen.getByTestId("context-ring").getAttribute("aria-label") ?? "";
    expect(label).toContain("42% of context used");
    expect(label).toContain("42.0k of 100.0k tokens");
    expect(screen.getByTestId("context-ring-arc")).toBeInTheDocument();
  });

  it("shows an unknown count as unknown, not as empty", () => {
    render(<ContextRing usage={{ tokens: null, contextWindow: 200_000, percent: null }} />);
    const label = screen.getByTestId("context-ring").getAttribute("aria-label") ?? "";
    expect(label).toContain("context usage unknown");
    expect(screen.queryByTestId("context-ring-arc")).toBeNull();
  });

  it("includes the cost when the session has one", () => {
    expect(contextRingLabel({ tokens: 1000, contextWindow: 2000, percent: 50 }, 0.05)).toBe(
      "50% of context used · 1.0k of 2.0k tokens · $0.0500 spent",
    );
    expect(contextRingLabel(null)).toBe("Context usage unknown");
  });
});
