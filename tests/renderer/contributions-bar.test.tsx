import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ContributionsBar } from "../../src/renderer/src/session/ContributionsBar";
import { buildContributionSnapshot } from "../../src/shared/extension-contributions-view";
import type { Contribution, ModeContribution } from "../../src/shared/extension-contributions";

/**
 * Generic contribution bar (orchestrator plan step 9; mode-cycle step 8).
 *
 * The fixture uses arbitrary extension names on purpose: the component must
 * render and control any publisher without a Desktop change. The primary mode
 * is the composer's concern, so this bar never repeats it.
 */

const mode = (id: string, label: string): ModeContribution => ({
  id,
  kind: "mode",
  slot: "mode",
  label,
  tone: "accent",
  order: 0,
  actions: [],
});

const action = (id: string, label: string, enabled = true): Contribution => ({
  id,
  kind: "action",
  slot: "action",
  label,
  tone: "info",
  order: 0,
  command: { name: "analyze" },
  enabled,
  ...(enabled ? {} : { disabledReason: "busy" }),
});

const snapshotOf = (entries: Array<{ ownerId: string; contributions: Contribution[] }>) =>
  buildContributionSnapshot(
    entries.map((entry, index) => ({ ...entry, epoch: 0, revision: index + 1 })),
    { supported: true, updatedAt: 1 },
  );

describe("ContributionsBar", () => {
  it("keeps rows and actions from unrelated owners visible", () => {
    const onRun = vi.fn();
    render(
      <ContributionsBar
        snapshot={snapshotOf([
          { ownerId: "alpha.ext", contributions: [mode("m", "Analyze")] },
          {
            ownerId: "beta.ext",
            contributions: [
              {
                id: "s",
                kind: "status",
                slot: "status",
                text: "3 of 9",
                tone: "neutral",
                order: 0,
              },
              action("go", "Start"),
            ],
          },
        ])}
        onRunAction={onRun}
      />,
    );
    expect(screen.queryByText("Analyze")).toBeNull();
    expect(screen.getByText("3 of 9")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("contribution-action"));
    expect(onRun).toHaveBeenCalledWith("beta.ext", "go");
  });

  it("disables an action that the publisher disabled", () => {
    render(
      <ContributionsBar
        snapshot={snapshotOf([
          { ownerId: "gamma.ext", contributions: [action("go", "Start", false)] },
        ])}
        onRunAction={() => {}}
      />,
    );
    expect(screen.getByTestId("contribution-action")).toBeDisabled();
    expect(screen.getByTestId("contribution-action")).toHaveAttribute("title", "busy");
  });

  it("does not repeat the primary mode or its referenced action as row chrome", () => {
    const { container } = render(
      <ContributionsBar
        snapshot={snapshotOf([
          {
            ownerId: "alpha.ext",
            contributions: [
              { ...mode("m", "Analyze"), actionRef: "cycle" },
              {
                id: "cycle",
                kind: "action",
                slot: "action",
                label: "Cycle mode",
                tone: "neutral",
                order: 20,
                command: { name: "cycle" },
                enabled: true,
              },
            ],
          },
        ])}
        onRunAction={() => {}}
      />,
    );
    // The composer corner owns the mode and its cycle action; a mode-only or
    // mode+referenced-action snapshot leaves no empty bordered strip here.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Analyze")).toBeNull();
    expect(screen.queryByText("Cycle mode")).toBeNull();
  });

  it("keeps unrelated rows and actions visible beside a primary mode", () => {
    render(
      <ContributionsBar
        snapshot={snapshotOf([
          { ownerId: "alpha.ext", contributions: [mode("m", "Analyze")] },
          {
            ownerId: "beta.ext",
            contributions: [
              {
                id: "s",
                kind: "status",
                slot: "status",
                text: "3 of 9",
                tone: "neutral",
                order: 0,
              },
              action("go", "Start"),
            ],
          },
        ])}
        onRunAction={() => {}}
      />,
    );
    expect(screen.getByText("3 of 9")).toBeInTheDocument();
    expect(screen.getByTestId("contribution-action")).toHaveTextContent("Start");
  });

  it("shows a locked input and a host-provided linked tab", () => {
    const open = vi.fn();
    render(
      <ContributionsBar
        snapshot={snapshotOf([
          {
            ownerId: "alpha.ext",
            contributions: [
              {
                id: "input",
                kind: "input",
                slot: "input",
                availability: "locked",
                tone: "warning",
                order: 0,
                reason: "A reviewer owns this turn",
              },
            ],
          },
        ])}
        linkedTab={{ label: "Open linked tab", onOpen: open }}
        onRunAction={() => {}}
      />,
    );
    const locked = screen.getByTestId("contribution-input");
    expect(locked).toHaveTextContent("input locked");
    expect(locked).toHaveAttribute("title", "A reviewer owns this turn");
    fireEvent.click(screen.getByTestId("contribution-linked-tab"));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not spend a chip on an available input", () => {
    render(
      <ContributionsBar
        snapshot={snapshotOf([
          {
            ownerId: "alpha.ext",
            contributions: [
              {
                id: "input",
                kind: "input",
                slot: "input",
                availability: "available",
                tone: "neutral",
                order: 0,
              },
            ],
          },
        ])}
        onRunAction={() => {}}
      />,
    );
    expect(screen.queryByTestId("contribution-input")).toBeNull();
  });

  it("folds a long action list into an overflow menu", () => {
    render(
      <ContributionsBar
        snapshot={snapshotOf([
          {
            ownerId: "alpha.ext",
            contributions: Array.from({ length: 6 }, (_, index) =>
              action(`a${index}`, `Action ${index}`),
            ),
          },
        ])}
        onRunAction={() => {}}
      />,
    );
    expect(screen.getAllByTestId("contribution-action")).toHaveLength(4);
    expect(screen.getByTestId("contribution-action-overflow")).toHaveTextContent("More");
  });

  it("renders nothing without a snapshot or contributions", () => {
    const { container, rerender } = render(
      <ContributionsBar snapshot={undefined} onRunAction={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(
      <ContributionsBar
        snapshot={snapshotOf([{ ownerId: "delta.ext", contributions: [] }])}
        onRunAction={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
