import { render, screen } from "@testing-library/react";
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
  const onToggleFavorite = vi.fn();
  const onSignIn = vi.fn();
  const onOpenModelsJson = vi.fn();
  const onClose = vi.fn();
  render(
    <ModelPicker
      open
      entries={CATALOG}
      auth={AUTH}
      currentKey="anthropic/claude-sonnet-4-5"
      favorites={[]}
      onPick={onPick}
      onToggleFavorite={onToggleFavorite}
      onSignIn={onSignIn}
      onOpenModelsJson={onOpenModelsJson}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { onPick, onToggleFavorite, onSignIn, onOpenModelsJson, onClose };
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

  it("picks session-only by default and persists when asked", async () => {
    const user = userEvent.setup();
    const { onPick } = renderPicker();
    await user.click(screen.getByRole("option", { name: /GPT-5/ }));
    expect(onPick).toHaveBeenCalledWith(CATALOG[1], { persist: false });

    await user.click(screen.getByLabelText("Save as default"));
    await user.click(screen.getByRole("option", { name: /GPT-5/ }));
    expect(onPick).toHaveBeenLastCalledWith(CATALOG[1], { persist: true });
  });

  it("toggles a favourite from the star", async () => {
    const user = userEvent.setup();
    const { onToggleFavorite } = renderPicker();
    await user.click(screen.getByRole("button", { name: "Favourite GPT-5" }));
    expect(onToggleFavorite).toHaveBeenCalledWith("openai/gpt-5");
  });

  it("lists favourites first", () => {
    renderPicker({ favorites: ["openai/gpt-5"] });
    const sections = screen.getByTestId("model-list").querySelectorAll("h3");
    expect(sections[0]?.textContent).toContain("Favourites");
  });

  it("shows a picker-scoped error when one is set, and none otherwise", () => {
    const { rerender } = render(
      <ModelPicker
        open
        entries={CATALOG}
        auth={AUTH}
        favorites={[]}
        onPick={vi.fn()}
        onToggleFavorite={vi.fn()}
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
        favorites={[]}
        onPick={vi.fn()}
        onToggleFavorite={vi.fn()}
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
  it("offers only the levels the host reported for this model", async () => {
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

    const levels = [...screen.getByTestId("thinking-levels").querySelectorAll("[data-level]")].map(
      (node) => node.getAttribute("data-level"),
    );
    expect(levels).toEqual(["off", "high"]);
    expect(screen.getByRole("option", { name: /high/ })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("option", { name: /off/ }));
    expect(onPick).toHaveBeenCalledWith("off", { persist: false });
  });

  it("says so when the model cannot think", () => {
    render(<ThinkingPicker open levels={[]} current={null} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText(/does not support thinking levels/)).toBeInTheDocument();
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
