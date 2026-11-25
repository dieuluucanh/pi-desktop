import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkingBar } from "../../src/renderer/src/session/WorkingBar";
import {
  buildContributionBar,
  buildContributionSnapshot,
  type ContributionBarModel,
} from "../../src/shared/extension-contributions-view";
import type {
  ActionContribution,
  Contribution,
  ContributionActionGroup,
  InputAvailability,
} from "../../src/shared/extension-contributions";
import type { ExtensionWorkingState } from "../../src/shared/extension-ui";

/**
 * The single working bar (2026-11-25 session run bar plan, step 3).
 *
 * The fixtures use arbitrary owner ids and no Workflow names: the bar renders
 * props, so the same tests hold for any publisher. Radix menus are opened for
 * the two menu tests; everything else is pure rendering.
 */

const workingState = (overrides: Partial<ExtensionWorkingState> = {}): ExtensionWorkingState => ({
  message: null,
  visible: null,
  frames: null,
  intervalMs: null,
  ...overrides,
});

function action(
  id: string,
  label: string,
  extra: Partial<Omit<ActionContribution, "id" | "label">> = {},
): ActionContribution {
  return {
    id,
    kind: "action",
    slot: "action",
    label,
    tone: "info",
    order: 0,
    command: { name: "analyze" },
    enabled: true,
    ...extra,
  };
}

function group(
  id: string,
  label: string,
  placement: "inline" | "menu",
  order = 0,
): ContributionActionGroup {
  return { id, label, order, placement };
}

function input(availability: InputAvailability, reason?: string): Contribution {
  return {
    id: `input-${availability}`,
    kind: "input",
    slot: "input",
    availability,
    tone: "warning",
    order: 0,
    ...(reason === undefined ? {} : { reason }),
  };
}

function progress(id: string, label: string, done: number, total: number): Contribution {
  return {
    id,
    kind: "progress",
    slot: "progress",
    label,
    tone: "neutral",
    order: 0,
    done,
    total,
    actions: [],
  };
}

function modelOf(contributions: Contribution[], ownerId = "alpha.ext"): ContributionBarModel {
  return buildContributionBar(
    buildContributionSnapshot([{ ownerId, revision: 1, epoch: 0, contributions }], {
      supported: true,
      updatedAt: 1,
    }),
  );
}

function renderBar(
  options: {
    working?: ExtensionWorkingState;
    running?: boolean;
    startedAt?: number | null;
    model?: ContributionBarModel;
    linkedTab?: { label: string; onOpen: () => void } | null;
    onRunAction?: (ownerId: string, id: string) => void | Promise<unknown>;
  } = {},
) {
  return render(
    <WorkingBar
      working={options.working ?? workingState()}
      running={options.running ?? false}
      startedAt={options.startedAt ?? null}
      model={options.model ?? modelOf([])}
      linkedTab={options.linkedTab ?? null}
      onRunAction={options.onRunAction ?? (() => {})}
    />,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkingBar working status", () => {
  it("renders the extension working message as the hint without appending Esc to cancel", () => {
    const message = "ESC or /orchestrator pause · /orchestrator abort to stop";
    renderBar({
      working: workingState({ message }),
      running: true,
      model: modelOf([action("pause", "Pause child")]),
    });

    expect(screen.getByTestId("working-bar-message")).toHaveTextContent(message);
    expect(screen.queryByText(/Esc to cancel/)).toBeNull();
    expect(screen.getByText("Pause child")).toBeInTheDocument();
  });

  it("renders a review message the same way (extension hint wins)", () => {
    const message = "Reviewing… ESC or /review-pause to pause · /review-abort to stop";
    renderBar({ working: workingState({ message }), running: true });

    expect(screen.getByTestId("working-bar-message")).toHaveTextContent(message);
    expect(screen.queryByText(/Esc to cancel/)).toBeNull();
  });

  it("falls back to Working… and Esc to cancel for a plain running turn", () => {
    renderBar({ working: workingState(), running: true });

    expect(screen.getByTestId("working-bar-message")).toHaveTextContent("Working…");
    expect(screen.getByTestId("working-bar-hint")).toHaveTextContent("Esc to cancel");
  });

  it("does not show the default hint when the tab is not running", () => {
    renderBar({ working: workingState(), running: false, model: modelOf([action("go", "Start")]) });

    expect(screen.queryByTestId("working-bar-message")).toBeNull();
    expect(screen.queryByText("Esc to cancel")).toBeNull();
    expect(screen.getByTestId("working-bar-action")).toHaveTextContent("Start");
  });

  it("uses the extension frames as the marker and animates them", () => {
    vi.useFakeTimers();
    renderBar({
      working: workingState({ frames: ["⠋", "⠙"], intervalMs: 100 }),
      running: true,
    });

    const indicator = screen.getByTestId("working-bar-indicator");
    expect(indicator).toHaveTextContent("⠋");
    expect(indicator.className).toContain("font-mono");

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByTestId("working-bar-indicator")).toHaveTextContent("⠙");
  });

  it("shows elapsed time and keeps it out of the live region", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
    renderBar({
      working: workingState({ message: "Compacting" }),
      running: true,
      startedAt: Date.now() - 65_000,
    });

    expect(screen.getByTestId("working-bar-elapsed")).toHaveTextContent("1:05");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByTestId("working-bar-elapsed")).toHaveTextContent("1:07");
    expect(screen.getByTestId("working-bar-status")).toHaveTextContent("Compacting");
    expect(screen.getByTestId("working-bar-status").textContent).not.toContain("1:07");
  });

  it("clamps the visible message to one line and exposes the full value beyond title", () => {
    const message = "line one\nline two — a very long extension working message";
    renderBar({ working: workingState({ message }), running: true });

    const visible = screen.getByTestId("working-bar-message");
    expect(visible).toHaveAttribute("title", message);
    expect(visible.className).toContain("truncate");

    const live = screen.getByTestId("working-bar-status");
    expect(live).toHaveAttribute("role", "status");
    expect(live.className).toContain("sr-only");
    expect(live.textContent).toBe(message);
  });
});

describe("WorkingBar visibility semantics", () => {
  it("hides only the indicator for visible:false while keeping actions", () => {
    const onRun = vi.fn();
    renderBar({
      working: workingState({ message: "Compacting", visible: false }),
      running: true,
      model: modelOf([action("go", "Run now")]),
      onRunAction: onRun,
    });

    expect(screen.getByTestId("working-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("working-bar-message")).toBeNull();
    expect(screen.queryByTestId("working-bar-indicator")).toBeNull();
    expect(screen.queryByText("Compacting")).toBeNull();
    fireEvent.click(screen.getByTestId("working-bar-action"));
    expect(onRun).toHaveBeenCalledWith("alpha.ext", "go");
  });

  it("hides the whole row for visible:false with no other content", () => {
    const { container } = renderBar({
      working: workingState({ message: "Compacting", visible: false }),
      running: true,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("hides only the indicator for empty frames while keeping actions", () => {
    renderBar({
      working: workingState({ message: "Compacting", frames: [] }),
      running: true,
      model: modelOf([action("go", "Run now")]),
    });

    expect(screen.getByTestId("working-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("working-bar-indicator")).toBeNull();
    expect(screen.queryByTestId("working-bar-message")).toBeNull();
    expect(screen.getByTestId("working-bar-action")).toHaveTextContent("Run now");
  });

  it("hides the whole row for empty frames with no other content", () => {
    const { container } = renderBar({ working: workingState({ frames: [] }), running: true });
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the menu and the lock visible when the indicator is hidden", async () => {
    renderBar({
      working: workingState({ visible: false }),
      running: true,
      model: modelOf([
        action("auto", "Auto todos", { group: group("todos", "Todos", "menu", 1) }),
        input("locked", "Review owns the turn"),
      ]),
    });

    expect(screen.getByTestId("working-bar-input-lock")).toBeInTheDocument();
    // The three-dot trigger is a control, not part of the indicator: it stays
    // when `visible:false` hides the spinner. Its content is covered by the one
    // real menu test below (a second Radix open in the same file is unreliable
    // in jsdom; see tests/renderer/setup.ts).
    expect(screen.getByTestId("working-bar-menu")).toBeInTheDocument();
  });

  it("renders nothing when there is genuinely nothing to show", () => {
    const { container } = renderBar({ working: workingState(), model: modelOf([]) });
    expect(container).toBeEmptyDOMElement();
  });
});

describe("WorkingBar input lock", () => {
  it("derives a locked input from the model and shows the reason", () => {
    renderBar({ model: modelOf([input("locked", "Review owns the turn")]) });

    const lock = screen.getByTestId("working-bar-input-lock");
    expect(lock).toHaveAttribute("aria-label", "Input locked: Review owns the turn");
    expect(lock).toHaveAttribute("title", "Review owns the turn");
  });

  it("keeps the row visible for an input-only locked snapshot", () => {
    renderBar({ model: modelOf([input("locked", "Orchestrator owns the turn")]) });
    expect(screen.getByTestId("working-bar")).toBeInTheDocument();
  });

  it("shows no lock for available or restricted input", () => {
    const available = renderBar({ model: modelOf([input("available")]) });
    expect(screen.queryByTestId("working-bar-input-lock")).toBeNull();
    expect(available.container).toBeEmptyDOMElement();
    available.unmount();

    const restricted = renderBar({ model: modelOf([input("restricted", "Prose is limited")]) });
    expect(screen.queryByTestId("working-bar-input-lock")).toBeNull();
    // A restricted input is not a lock, and alone it is not worth a row.
    expect(restricted.container).toBeEmptyDOMElement();
  });
});

describe("WorkingBar idle and actions", () => {
  it("shows the first menu group label when idle and only menu actions exist", () => {
    renderBar({
      model: modelOf([
        action("auto", "Auto todos", { group: group("todos", "Todos", "menu", 1) }),
        action("hide", "Hide todos", { group: group("todos", "Todos", "menu", 1) }),
        progress("todos", "Steps", 3, 9),
      ]),
    });

    expect(screen.getByTestId("working-bar-group-label")).toHaveTextContent("Todos");
    // No native mirror of the progress counts; the TODO panel owns them.
    expect(screen.queryByText(/3\/9/)).toBeNull();
    expect(screen.queryByText("Steps")).toBeNull();
    expect(screen.queryByTestId("working-bar-action")).toBeNull();
    expect(screen.getByTestId("working-bar-menu")).toBeInTheDocument();
  });

  it("keeps inline actions in model presentation order", () => {
    renderBar({
      model: modelOf([
        action("b", "Second", { order: 2, group: group("run", "Run", "inline", 0) }),
        action("a", "First", { order: 1, group: group("run", "Run", "inline", 0) }),
        action("c", "Third", { order: 3, group: group("run", "Run", "inline", 0) }),
      ]),
    });

    expect(screen.getAllByTestId("working-bar-action").map((node) => node.textContent)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("keeps action descriptions in title and aria-description", () => {
    renderBar({
      model: modelOf([action("pause", "Pause child", { description: "/orchestrator pause" })]),
    });

    const button = screen.getByTestId("working-bar-action");
    expect(button).toHaveAttribute("title", "/orchestrator pause");
    expect(button).toHaveAttribute("aria-description", "/orchestrator pause");
  });

  it("disables an action with the publisher's reason", () => {
    renderBar({
      model: modelOf([
        action("pause", "Pause child", { enabled: false, disabledReason: "Already paused" }),
      ]),
    });

    const button = screen.getByTestId("working-bar-action");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Already paused");
  });

  it("renders a linked tab as a compact secondary button", () => {
    const onOpen = vi.fn();
    renderBar({ linkedTab: { label: "Review: session alpha", onOpen } });

    fireEvent.click(screen.getByTestId("working-bar-linked-tab"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("activates an inline action from the keyboard", async () => {
    const onRun = vi.fn();
    renderBar({ model: modelOf([action("go", "Start")]), onRunAction: onRun });

    const button = screen.getByTestId("working-bar-action");
    act(() => button.focus());
    await userEvent.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledWith("alpha.ext", "go");
  });

  it("guards against a second dispatch while an action is pending", async () => {
    let release: (() => void) | undefined;
    const onRun = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderBar({ model: modelOf([action("go", "Start")]), onRunAction: onRun });

    const button = screen.getByTestId("working-bar-action");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    await act(async () => {
      release?.();
    });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(onRun).toHaveBeenCalledTimes(2);
  });
});

describe("WorkingBar menu", () => {
  // Radix ports its content into `document.body`, and jsdom in this project
  // loses the pointer-open path once an earlier test in the file has mounted
  // and unmounted a dropdown (the setup file documents the same class of leak
  // for dialogs). The trigger is the shared `DropdownMenuTrigger` primitive that
  // the grid-layout menu already covers with a real click, so these tests open
  // the same real menu from the keyboard, which stays reliable.
  it("opens one upward, end-aligned menu with grouped sections, disabled reasons and forwarding", async () => {
    const onRun = vi.fn();
    renderBar({
      model: modelOf([
        action("pause", "Pause child", {
          group: group("run-controls", "Run controls", "menu", 0),
        }),
        action("auto", "Auto todos", {
          group: group("todos", "Todos", "menu", 1),
          enabled: false,
          disabledReason: "Only the parent panel changes visibility",
        }),
        action("show", "Show todos", { group: group("todos", "Todos", "menu", 1) }),
      ]),
      onRunAction: onRun,
    });

    const trigger = screen.getByTestId("working-bar-menu");
    act(() => trigger.focus());
    await userEvent.keyboard("{Enter}");

    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-side", "top");
    expect(menu).toHaveAttribute("data-align", "end");
    expect(within(menu).getByText("Run controls")).toBeInTheDocument();
    expect(within(menu).getByText("Todos")).toBeInTheDocument();
    expect(within(menu).getAllByRole("group")).toHaveLength(2);
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Pause child", "Auto todos", "Show todos"]);

    const disabled = within(menu).getByTestId("working-bar-menu-item-alpha.ext:auto");
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled).toHaveAttribute("data-disabled");
    expect(disabled).toHaveAttribute("title", "Only the parent panel changes visibility");

    // The first item has focus; Enter runs it through the same forwarding path.
    await userEvent.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledWith("alpha.ext", "pause");
  });

  it("folds legacy ungrouped actions into the menu and activates them from the keyboard", async () => {
    const onRun = vi.fn();
    renderBar({
      model: modelOf([
        action("a1", "One"),
        action("a2", "Two"),
        action("a3", "Three"),
        action("a4", "Four"),
      ]),
      onRunAction: onRun,
    });

    expect(screen.getAllByTestId("working-bar-action")).toHaveLength(3);

    const trigger = screen.getByTestId("working-bar-menu");
    act(() => trigger.focus());
    await userEvent.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("More actions")).toBeInTheDocument();
    expect(within(menu).getByTestId("working-bar-menu-item-alpha.ext:a4")).toHaveTextContent(
      "Four",
    );

    await userEvent.keyboard("{Enter}");
    expect(onRun).toHaveBeenCalledWith("alpha.ext", "a4");
  });
});
