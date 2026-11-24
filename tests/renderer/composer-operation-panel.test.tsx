import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { ComposerOperationDerived } from "../../src/shared/composer-operation";
import { ComposerOperationPanel } from "../../src/renderer/src/session/ComposerOperationPanel";
import { SessionView } from "../../src/renderer/src/views/SessionView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { buildContributionSnapshot } from "../../src/shared/extension-contributions-view";
import {
  COMPOSER_TRANSFORM_CONTRACT,
  type ComposerControlContribution,
} from "../../src/shared/composer-transform";
import type { Contribution } from "../../src/shared/extension-contributions";
import type { ExtensionDialogRequest } from "../../src/shared/extension-ui";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { installBridge } from "./fixtures";

/**
 * Composer-operation progress/result surface and its ownership rules
 * (2026-11-22 prompt-refinement plan, row 22).
 *
 * The panel is generic: labels and stage text come from the operation, never
 * from an extension name. It is displayed in the composer branch only, so a
 * questionnaire/TUI dialog replaces it instead of stacking a second loader.
 */

const OWNER = "refine.ext";
const TAB = "tab-1";
const REQUEST_ID = "req-1";
const OPERATION_ID = "op-1";

function derived(over: Partial<ComposerOperationDerived> = {}): ComposerOperationDerived {
  return {
    uiState: "running",
    eligible: [],
    armed: [],
    armedControl: null,
    runningControl: null,
    isRunning: true,
    isAwaitingInput: false,
    hasCandidate: false,
    candidateText: null,
    candidateSummary: null,
    stage: "inspection",
    statusMessage: "test/model · inspecting the repository (grep)",
    originalText: "please fix it",
    isConflict: false,
    conflict: null,
    canStart: false,
    canCancel: true,
    canApply: false,
    ...over,
  };
}

function control(): ComposerControlContribution {
  return {
    id: "refine",
    kind: "composer-control",
    slot: "composer-actions",
    tone: "accent",
    order: 0,
    label: "Refine prompt",
    description: "Returns a refined draft; never runs it.",
    icon: "sparkles",
    checked: true,
    enabled: true,
    behavior: "one-shot-return",
    actionRef: "toggle",
    transformActionRef: "transform",
    operation: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      publicCommand: "prompt",
      companionCommand: "prompt-companion",
    },
  };
}

function contributions() {
  const actions: Contribution[] = [
    {
      id: "toggle",
      kind: "action",
      slot: "action",
      label: "Toggle refine",
      tone: "neutral",
      order: 0,
      command: { name: "prompt" },
      enabled: true,
    },
    {
      id: "transform",
      kind: "action",
      slot: "action",
      label: "Transform",
      tone: "neutral",
      order: 0,
      command: { name: "prompt" },
      enabled: true,
    },
  ];
  return buildContributionSnapshot(
    [{ ownerId: OWNER, epoch: 0, revision: 1, contributions: [control(), ...actions] }],
    { supported: true, updatedAt: 1 },
  );
}

function resetStore(over: Record<string, unknown> = {}): void {
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS, drafts: {} },
    tabs: [
      {
        id: TAB,
        kind: "session",
        cwd: "/work/app",
        title: "app",
        sessionFile: null,
        status: "idle",
        createdAt: 0,
        lastActiveAt: 0,
        model: "test-model",
      },
    ],
    activeTabId: TAB,
    transcripts: {},
    sessionStates: { [TAB]: { sessionId: "session-1" } },
    sessionEpochs: { [TAB]: 1 },
    contributions: { [TAB]: contributions() },
    extensionUi: {},
    tuiSurfaces: {},
    extensionDialogs: [],
    composerDrafts: {},
    composerOperations: {},
    composerApplyReceipts: {},
    picker: null,
    draftHistory: {},
    historySeed: {},
    historyBrowse: {},
    hint: null,
    ...over,
  });
}

function stubRequest() {
  const methods: string[] = [];
  const request = vi.fn(async (input: { method: string }) => {
    methods.push(input.method);
    if (input.method === "contributions.state") {
      return useAppStore.getState().contributions[TAB] ?? contributions();
    }
    if (input.method === "composer.cancel") {
      return {
        contract: COMPOSER_TRANSFORM_CONTRACT,
        requestId: REQUEST_ID,
        operationId: OPERATION_ID,
        state: "cancelled",
        at: 1,
      };
    }
    return {};
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return { request, methods };
}

function liveOperation(): void {
  useAppStore.getState().applyComposerOperationEvent(TAB, {
    type: "start",
    requestId: REQUEST_ID,
    ownerId: OWNER,
    controlId: "refine",
    baseRevision: 1,
    baseAttachmentRevision: 1,
    baseText: "please fix it",
    binding: {
      sessionId: "session-1",
      epoch: 1,
      bindingId: `tab:${TAB}`,
      hostGeneration: 1,
    },
    descriptorGeneration: { ownerId: OWNER, epoch: 0, revision: 1 },
  });
  useAppStore.getState().applyComposerOperationEvent(TAB, {
    type: "started",
    receipt: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      status: "started",
      binding: {
        sessionId: "session-1",
        epoch: 1,
        bindingId: `tab:${TAB}`,
        hostGeneration: 1,
      },
      startedAt: 1,
    },
  });
  useAppStore.getState().applyComposerOperationEvent(TAB, {
    type: "progress",
    progress: {
      contract: COMPOSER_TRANSFORM_CONTRACT,
      requestId: REQUEST_ID,
      operationId: OPERATION_ID,
      state: "running",
      phase: "inspection",
      message: "test/model · inspecting the repository (grep)",
      at: 1,
    },
  });
}

beforeEach(() => {
  installBridge();
  resetStore();
});

describe("ComposerOperationPanel", () => {
  it("shows the effective model and stage and cancels on request", () => {
    const onCancel = vi.fn();
    render(
      <ComposerOperationPanel operation={derived()} onCancel={onCancel} onReplace={vi.fn()} />,
    );
    const status = screen.getByTestId("composer-operation-status");
    expect(status).toHaveTextContent("test/model");
    expect(status).toHaveTextContent("inspecting the repository");
    expect(screen.getByTestId("composer-operation-panel")).toHaveAttribute(
      "data-stage",
      "inspection",
    );
    fireEvent.click(screen.getByTestId("composer-operation-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("is not rendered for an idle/finished operation", () => {
    render(
      <ComposerOperationPanel
        operation={derived({ isRunning: false, canCancel: false, statusMessage: null })}
        onCancel={vi.fn()}
        onReplace={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("composer-operation-panel")).toBeNull();
  });

  it("keeps a conflicted candidate viewable, copyable and explicitly replaceable", async () => {
    const onReplace = vi.fn();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <ComposerOperationPanel
        operation={derived({
          isRunning: false,
          canCancel: false,
          hasCandidate: true,
          candidateText: "Please fix the parser.",
          candidateSummary: "Clarified the request.",
          isConflict: true,
          conflict: {
            kind: "stale-base",
            message: "Your draft changed while it was being refined.",
          },
          statusMessage: null,
        })}
        onCancel={vi.fn()}
        onReplace={onReplace}
      />,
    );

    expect(screen.getByTestId("composer-operation-conflict")).toHaveTextContent(
      "Your draft changed",
    );
    expect(screen.getByTestId("composer-operation-summary")).toHaveTextContent(
      "Clarified the request.",
    );

    fireEvent.click(screen.getByTestId("composer-operation-view-result"));
    expect(screen.getByTestId("composer-operation-candidate")).toHaveValue(
      "Please fix the parser.",
    );
    fireEvent.click(screen.getByTestId("composer-operation-view-original"));
    expect(screen.getByTestId("composer-operation-original")).toHaveValue("please fix it");

    fireEvent.click(screen.getByTestId("composer-operation-copy"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("Please fix the parser."));

    fireEvent.click(screen.getByTestId("composer-operation-replace"));
    expect(onReplace).toHaveBeenCalledTimes(1);
  });
});

describe("session view ownership", () => {
  it("renders the live operation above the composer and sends one cancel from its button", async () => {
    const stub = stubRequest();
    liveOperation();
    render(<SessionView tabId={TAB} />);

    expect(screen.getByTestId("composer-operation-panel")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("composer-operation-cancel"));
    await vi.waitFor(() =>
      expect(stub.methods.filter((method) => method === "composer.cancel")).toHaveLength(1),
    );
    // Cancelling never reaches the terminal/Review input path.
    expect(stub.methods).not.toContain("tui.input");
  });

  it("a questionnaire dialog replaces the progress panel instead of nesting", () => {
    liveOperation();
    const dialog: ExtensionDialogRequest = {
      id: "question-1",
      method: "select",
      title: "Which term should this keep?",
      options: ["child-session", "sub-session"],
      message: "",
      placeholder: null,
      prefill: null,
      timeout: null,
      tabId: TAB,
      at: 1,
    };
    useAppStore.setState({ extensionDialogs: [dialog] });
    render(<SessionView tabId={TAB} />);

    expect(screen.queryByTestId("composer-operation-panel")).toBeNull();
    expect(screen.queryByTestId("composer-operation-cancel")).toBeNull();
  });

  it("toggle-off cancels the live refinement and then runs the toggle action", async () => {
    const stub = stubRequest();
    liveOperation();
    render(<SessionView tabId={TAB} />);

    fireEvent.click(screen.getByTestId("composer-control"));

    await vi.waitFor(() => expect(stub.methods).toContain("contributions.run"));
    expect(stub.methods.indexOf("composer.cancel")).toBeGreaterThanOrEqual(0);
    expect(stub.methods.indexOf("composer.cancel")).toBeLessThan(
      stub.methods.indexOf("contributions.run"),
    );
  });
});
