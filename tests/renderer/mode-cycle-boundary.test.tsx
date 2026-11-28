import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useAppStore } from "../../src/renderer/src/state/app-store";
import { SessionView } from "../../src/renderer/src/views/SessionView";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import type { Contribution } from "../../src/shared/extension-contributions";
import {
  buildContributionSnapshot,
  type ContributionSnapshot,
} from "../../src/shared/extension-contributions-view";
import type { SessionEventEntry } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Mode-cycle boundary test (2026-11-22 plan, step 9).
 *
 * The renderer sees only what a real envelope produces:
 *
 *   publisher contributions → validated snapshot model → renderer sanitation →
 *   store ingestion (`contributions.state`) → `SessionView`/`Composer` →
 *   `contributions.run`.
 *
 * Only the transport is faked; no test injects a prepared view model, and no
 * test depends on a Workflow name (the fixture owner and labels are arbitrary).
 * The host registry's own refusal/authority rules are covered in
 * `tests/host/contribution-mode-boundary.test.ts`.
 */

const TAB = "tab-1";
const OWNER = "fixture.mode-ext";
const CYCLE = ["Default", "Plan", "Orchestrator", "Build"];

const modeContribution = (label: string, over: Partial<Contribution> = {}): Contribution =>
  ({
    id: "mode",
    kind: "mode",
    slot: "mode",
    label,
    tone: label === "Plan" ? "warning" : "accent",
    order: 0,
    actionRef: "mode-cycle",
    actions: [],
    ...over,
  }) as Contribution;

const cycleContribution = (enabled = true): Contribution => ({
  id: "mode-cycle",
  kind: "action",
  slot: "action",
  label: "Cycle mode",
  tone: "neutral",
  order: 20,
  command: { name: "fixture-cycle" },
  enabled,
  ...(enabled ? {} : { disabledReason: "a review owns this turn" }),
});

function snapshotOf(entries: Array<{ ownerId: string; contributions: Contribution[] }>) {
  return buildContributionSnapshot(
    entries.map((entry, index) => ({ ...entry, epoch: 0, revision: index + 1 })),
    { supported: true, updatedAt: 1 },
  );
}

interface Harness {
  snapshot: () => ContributionSnapshot;
  /** Simulates the host's `contributions.run` for the referenced action. */
  run: (ownerId: string, id: string) => Promise<{ ran: boolean; error?: string }>;
  mode: () => string;
}

/** A generic publisher: the current mode plus the one action it references. */
function harness(initial = 0): Harness {
  let index = initial;
  const snapshot = () =>
    snapshotOf([
      { ownerId: OWNER, contributions: [modeContribution(CYCLE[index]!), cycleContribution()] },
    ]);
  const run = async (ownerId: string, id: string) => {
    if (ownerId !== OWNER || id !== "mode-cycle") {
      return { ran: false as const, error: "action is no longer available" };
    }
    index = (index + 1) % CYCLE.length;
    return { ran: true as const };
  };
  return { snapshot, run, mode: () => CYCLE[index]! };
}

/** The renderer's only ingestion point for a pushed contribution snapshot. */
function ingest(payload: unknown): void {
  useAppStore.getState().handleExtensionUiEvent(TAB, {
    event: "contributions.state",
    payload,
  } as SessionEventEntry);
}

function resetStore(): void {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tabs: [
      {
        id: TAB,
        kind: "session",
        cwd: "C:/work/app",
        title: "Fixture",
        sessionFile: null,
        status: "idle",
        createdAt: 1,
        lastActiveAt: 1,
        model: null,
      },
    ],
    activeTabId: TAB,
    transcripts: {},
    sessionStates: {},
    extensionUi: {},
    contributions: {},
    contributionActions: {},
    shortcutStates: {},
    tuiSurfaces: {},
    picker: null,
    draftHistory: {},
    historySeed: {},
    historyBrowse: {},
  });
}

beforeEach(() => {
  resetStore();
});

/** Wires the IPC surface to the fixture controller, as the host service does. */
function wire(h: Harness): ReturnType<typeof vi.fn> {
  const request = vi.fn(async (input: { method: string; params?: Record<string, string> }) => {
    if (input.method === "contributions.state") return h.snapshot();
    if (input.method === "contributions.run") {
      return h.run(input.params?.ownerId ?? "", input.params?.id ?? "");
    }
    return {};
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

describe("mode cycle through the real contribution boundary", () => {
  it("renders the published mode as one corner control and no mode row", () => {
    const h = harness(1);
    wire(h);
    ingest(h.snapshot());

    render(<SessionView tabId={TAB} />);

    expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Plan");
    expect(screen.getByLabelText("Prompt")).toHaveClass("border-warn");
    // The mode is not repeated as a bar; only the composer corner owns it, and
    // the referenced cycle action is consumed there.
    expect(screen.queryByTestId("working-bar")).toBeNull();
  });

  it("advances to the newly published mode on click, never optimistically", async () => {
    const h = harness(1);
    const request = wire(h);
    ingest(h.snapshot());

    render(<SessionView tabId={TAB} />);
    const button = screen.getByTestId("composer-mode-button");
    expect(button).toHaveTextContent("Plan");

    fireEvent.click(button);
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: TAB,
        method: "contributions.run",
        params: { ownerId: OWNER, id: "mode-cycle" },
      }),
    );
    // The controller changed mode; the label follows what it publishes.
    await waitFor(() => expect(h.mode()).toBe("Orchestrator"));
    ingest(h.snapshot());
    await waitFor(() =>
      expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Orchestrator"),
    );
    expect(screen.queryByTestId("working-bar")).toBeNull();
  });

  it("shows a disabled referenced action without invoking it", () => {
    const request = vi.fn(async () => ({}));
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
    // Same owner, one action, not runnable right now.
    ingest(
      snapshotOf([
        {
          ownerId: OWNER,
          contributions: [modeContribution("Review", { tone: "accent" }), cycleContribution(false)],
        },
      ]),
    );

    render(<SessionView tabId={TAB} />);
    const button = screen.getByTestId("composer-mode-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "a review owns this turn");
    fireEvent.click(button);
    // Rendering may legitimately load shortcuts; the refusal is about the action.
    expect(request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "contributions.run" }),
    );
  });

  it("does not make a cross-owner or dangling reference actionable", () => {
    ingest(
      snapshotOf([
        { ownerId: OWNER, contributions: [modeContribution("Plan")] },
        { ownerId: "someone.else", contributions: [cycleContribution()] },
      ]),
    );
    render(<SessionView tabId={TAB} />);
    // The label stays informative; no button is fabricated from an id alone.
    expect(screen.queryByTestId("composer-mode-button")).toBeNull();
    expect(screen.getByTestId("composer-contribution-badge")).toHaveTextContent("Plan");
    // The other owner's action remains an ordinary bar action.
    expect(screen.getByRole("button", { name: "Cycle mode" })).toBeInTheDocument();
  });

  it("keeps task and recovery controls in the bar while the mode lives in the corner", () => {
    const h = harness(1);
    wire(h);
    const base = h.snapshot();
    ingest(
      snapshotOf([
        ...base.owners.map((owner) => ({
          ownerId: owner.ownerId,
          contributions: [modeContribution("Plan"), cycleContribution()],
        })),
        {
          ownerId: "fixture.tasks",
          contributions: [
            {
              id: "todos",
              kind: "progress",
              slot: "progress",
              label: "Todos",
              tone: "neutral",
              order: 10,
              done: 1,
              total: 3,
              actions: [],
            },
            {
              id: "recovery",
              kind: "action",
              slot: "action",
              label: "Use direct Build",
              tone: "warning",
              order: 30,
              command: { name: "build" },
              enabled: true,
            },
          ],
        },
      ]),
    );

    render(<SessionView tabId={TAB} />);

    expect(screen.getByTestId("composer-mode-button")).toHaveTextContent("Plan");
    const bar = screen.getByTestId("working-bar");
    // The bar carries the generic action, never the mode identity or its cycle
    // action. The progress row now belongs to the footer rail.
    expect(screen.getByRole("button", { name: "Use direct Build" })).toBeInTheDocument();
    expect(bar).not.toHaveTextContent("Todos");
    expect(screen.getByTestId("session-footer")).toHaveTextContent("Todos");
    expect(bar).not.toHaveTextContent("Plan");
    expect(bar).not.toHaveTextContent("Cycle mode");
  });
});
