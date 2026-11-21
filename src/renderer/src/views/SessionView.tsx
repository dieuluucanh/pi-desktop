import { useEffect, useMemo, useRef, useState } from "react";
import { Cpu } from "lucide-react";
import { Composer } from "../session/Composer";
import { useAttachmentDraft } from "../attachments/use-attachment-draft";
import { ReviewBar } from "../session/ReviewBar";
import { TodoPanelBar } from "../session/TodoPanelBar";
import { StartingBanner } from "../session/StartingBanner";
import { SessionFooter } from "../session/SessionFooter";
import { Transcript } from "../session/Transcript";
import { Button } from "../ui/button";
import { MultilineText } from "../ui/multiline-text";
import { WelcomeView } from "./WelcomeView";
import { useAppStore } from "../state/app-store";
import { selectDefaultModelProblem } from "../state/selectors";
import { WidgetStrip } from "../extension-ui/WidgetStrip";
import { ExtensionDialogDock } from "../extension-ui/ExtensionDialog";
import { WorkingRow } from "../extension-ui/WorkingRow";
import { RunStatusRow } from "../session/RunStatusRow";
import { TuiCellProbe, TuiSlotFrame, TuiSurface } from "../tui/TuiSurface";
import { TuiWidgetStrip, TuiWidgetInline } from "../tui/TuiWidgetStrip";
import { splitSingleLineFrames } from "../../../shared/tui-surface";
import { isDockedOverlay } from "../tui/tui-geometry";
import { useTuiViewport } from "../tui/use-tui-viewport";
import { createCommandProvider } from "../completion/command-source";
import { createDocumentProvider } from "../completion/document-source";
import { createFileProvider } from "../completion/file-source";
import { documentMentionsForHost } from "../../../shared/office-documents";
import { createCompletionProvider } from "../completion/stack";
import type { CompletionItem, CompletionSuggestions } from "../completion/types";
import { ContextRing } from "../session/ContextRing";
import { ModelPicker } from "../session/ModelPicker";
import { ThinkingPicker } from "../session/ThinkingPicker";
import { ThinkingLevelIcon } from "../session/ThinkingLevelIcon";
import { thinkingLevelTitle } from "../../../shared/thinking";
import type { ScopeDiagnosticInfo } from "../../../shared/model-scope";
import { contextUsageOf, modelKeyOf, thinkingLevelsOf } from "../session/model-catalog";
import { sameFolder } from "../../../shared/rail-scope";
import type { WorkspaceEntryKind } from "../../../shared/workspace";
import { isWorkspaceDrag, readWorkspaceDrop } from "../files/workspace-drag";
import {
  parseWorkflowStatus,
  reviewLineText,
  WORKFLOW_REVIEW_STATUS_KEY,
} from "../../../shared/workflow-mode";
import {
  resolveTodoPanel,
  TODO_STATUS_KEY,
  type TodoPanelActionId,
} from "../../../shared/workflow-todos";
import { isLoopbackUrl } from "../../../shared/web-tabs";

/**
 * Session view (plan step 5).
 *
 * The transcript is the view. There is no session header any more
 * (minimal-session-ui step 4): the tab strip owns the title, status dot and
 * review tabs; the composer owns Stop and the model/thinking/context controls;
 * the error banner owns Restart. What remains above the transcript is only the
 * error banner, so every other pixel goes to the conversation.
 */

/** Stable empty scope for a tab whose scope has not loaded yet. */
const EMPTY_SCOPE: readonly string[] = [];
const EMPTY_DIAGNOSTICS: readonly ScopeDiagnosticInfo[] = [];

/**
 * The review row promotes the extension's live review status; the footer must
 * not repeat the same line below the composer while that row is visible.
 */
const REVIEW_HIDDEN_STATUS_KEYS = [WORKFLOW_REVIEW_STATUS_KEY] as const;

/**
 * The `#` completion source.
 *
 * It reads the live registry from the store on every keystroke, so a document
 * attached or detached mid-session is reflected without rebuilding the completion
 * stack — and it works even when the bridge extension's own provider is absent.
 *
 * **Scoped to the host session** (plan D10): the list is empty unless this tab is
 * the one that owns bridge port 38617, because a mention writes a prompt whose
 * `office_*` call only that tab can serve. An empty list plus the Documents
 * scope row's explanation beats offering a document that cannot answer.
 */
const documentMentionSource = (tabId: string) => ({
  list: () => {
    const state = useAppStore.getState();
    // Scoped to the pane's own tab: a `#` mention writes a prompt whose
    // `office_*` call only that tab's host can serve.
    return documentMentionsForHost(state.officeDocuments ?? [], state.tabs, tabId);
  },
});

/**
 * The session-scoped facts line that used to summarize context usage moved to
 * `ComposerFooter` (`contextFooterText`), which the composer renders under the
 * input. `usageLine` was removed with it; the percentage-not-fraction guard now
 * lives in `tests/renderer/composer-footer.test.tsx`.
 */

export function SessionView({ tabId }: { tabId: string }) {
  const attachmentProfileScope = useAppStore((state) => state.info?.profileDir ?? "profile");
  const attachmentDraft = useAttachmentDraft(tabId, attachmentProfileScope);
  const project = useAppStore((state) => state.project);
  const homeDir = useAppStore((state) => state.info?.homeDir ?? null);
  const tabs = useAppStore((state) => state.tabs);
  // The tab this surface renders. In the grid several `SessionView`s are mounted
  // at once (2026-11-03 plan), so every per-tab read below uses the prop and the
  // app-wide selection is only consulted where it genuinely means "focused".
  const focusedTabId = useAppStore((state) => state.activeTabId);
  const sessionStates = useAppStore((state) => state.sessionStates);
  const transcripts = useAppStore((state) => state.transcripts);
  const ensureSession = useAppStore((state) => state.ensureSession);
  const restartTab = useAppStore((state) => state.restartTab);
  const cancelSession = useAppStore((state) => state.cancelSession);
  const hydrateTranscript = useAppStore((state) => state.hydrateTranscript);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const sendAttachmentPrompt = useAppStore((state) => state.sendAttachmentPrompt);
  const expandPastes = useAppStore((state) => state.expandPastes);
  const stopRun = useAppStore((state) => state.stopRun);
  const interruptRun = useAppStore((state) => state.interruptRun);
  // Review is an isolated turn: the bar's controls run the same extension
  // commands a typed `/review-*` would, without touching the draft.
  const runReviewCommand = useAppStore((state) => state.runReviewCommand);
  const activateTab = useAppStore((state) => state.activateTab);
  const clearQueue = useAppStore((state) => state.clearQueue);
  const restoreQueue = useAppStore((state) => state.restoreQueue);
  const setDraft = useAppStore((state) => state.setDraft);
  const historyStep = useAppStore((state) => state.historyStep);
  const drafts = useAppStore((state) => state.prefs.drafts);
  const loadCommands = useAppStore((state) => state.loadCommands);
  const completeCommandArguments = useAppStore((state) => state.completeCommandArguments);
  const completeAppCommandArguments = useAppStore((state) => state.completeAppCommandArguments);
  const loadFiles = useAppStore((state) => state.loadFiles);
  const modelCatalog = useAppStore((state) => state.modelCatalog);
  const providerAuth = useAppStore((state) => state.providerAuth);
  const thinkingLevels = useAppStore((state) => state.thinkingLevels);
  const picker = useAppStore((state) => state.picker);
  // Which tab the open picker belongs to: several panes can be mounted, so the
  // dialog is gated on this tab rather than on `picker` alone.
  const pickerTabId = useAppStore((state) => state.pickerTabId);
  const pickerError = useAppStore((state) => state.pickerError);
  const pickerSearch = useAppStore((state) => state.pickerSearch);
  const loadModels = useAppStore((state) => state.loadModels);
  const setModel = useAppStore((state) => state.setModel);
  const setThinking = useAppStore((state) => state.setThinking);
  const toggleModelScope = useAppStore((state) => state.toggleModelScope);
  const openPicker = useAppStore((state) => state.openPicker);
  const closePicker = useAppStore((state) => state.closePicker);
  const setView = useAppStore((state) => state.setView);
  const setHint = useAppStore((state) => state.setHint);
  const scopedModels = useAppStore((state) => state.modelScope[tabId]);
  const scopedPatterns = useAppStore((state) => state.modelScopePatterns[tabId]);
  const scopeTarget = useAppStore((state) => state.modelScopeTarget[tabId]);
  const scopeBusyKey = useAppStore((state) => state.modelScopeBusy[tabId] ?? null);
  const scopeDiagnostics = useAppStore(
    (state) => state.modelScopeDiagnostics[tabId] ?? EMPTY_DIAGNOSTICS,
  );
  const defaultModelIssue = useAppStore(selectDefaultModelProblem);
  const extensionUi = useAppStore((state) => state.extensionUi[tabId]);
  // An extension can own long-running work while the parent tab is idle
  // (a manual Review round). That is still "busy" for Escape, even though
  // `tab.status` stays idle; the review row replaces the generic working row
  // while the extension reports a Review phase.
  const extensionWorking = extensionUi?.working;
  const extensionBusy = extensionWorking?.message != null && extensionWorking.visible !== false;
  const workflowStatus = extensionUi?.statuses?.workflow ?? null;
  // Review is a first-class mode since @dieulc/workflow 0.11.0: the status is
  // the authority (and carries the phase), not the working message any more.
  // A running review's message can differ from the mode status, and the handoff
  // phase has no working message at all.
  const workflowMode = parseWorkflowStatus(workflowStatus);
  const reviewMode = workflowMode?.mode === "review";
  const reviewPhase = reviewMode ? (workflowMode?.reviewPhase ?? "running") : null;
  // The desktop row is the extension's own line (the same `workflow-review`
  // status terminal Pi paints); the fallback keeps the hints on an older
  // extension. `WorkingRow` is suppressed while this line owns the turn.
  const reviewLine = reviewPhase
    ? reviewLineText({
        phase: reviewPhase,
        status: extensionUi?.statuses?.[WORKFLOW_REVIEW_STATUS_KEY],
        workingMessage: extensionWorking?.message,
      })
    : null;
  const extensionDialogs = useAppStore((state) => state.extensionDialogs);
  const toolsExpandedState = useAppStore((state) => state.toolsExpanded[tabId]);
  const toggleToolsExpanded = useAppStore((state) => state.toggleToolsExpanded);
  const resizeTuiSurface = useAppStore((state) => state.resizeTuiSurface);
  // The git branch shown in the composer footer comes from the project
  // inspection the sidebar already triggers, so no new fetch is needed.
  const gitBranch = useAppStore((state) =>
    project ? (state.projectInspections[project.path]?.gitBranch ?? null) : null,
  );
  const extensionCompletion = useAppStore((state) => state.extensionCompletion);
  const extensionApplyCompletion = useAppStore((state) => state.extensionApplyCompletion);
  // Extension shortcuts (plan step 15) drive the composer's Tab mode cycle; the
  // store loads them per tab (step 7), so both the list and the invoker are here.
  const shortcuts = useAppStore((state) => state.shortcuts);
  const loadShortcuts = useAppStore((state) => state.loadShortcuts);
  const invokeShortcut = useAppStore((state) => state.invokeShortcut);
  const tuiSurface = useAppStore((state) => state.tuiSurfaces[tabId]);
  const runTodoPanelAction = useAppStore((state) => state.runTodoPanelAction);
  // The native todo bar's view model. The panel stays extension-owned; this
  // adapter only reads the widget frame and the compact status (step 2).
  const todoPanel = resolveTodoPanel({
    frames: tuiSurface?.widgetsAbove ?? [],
    widgets: extensionUi?.widgets ?? [],
    statuses: extensionUi?.statuses ?? {},
  });
  // The bar promotes the compact todo status; the footer must not repeat it.
  const hiddenSessionStatusKeys = useMemo(() => {
    const keys = [
      ...(reviewPhase ? REVIEW_HIDDEN_STATUS_KEYS : []),
      ...(todoPanel.present ? [TODO_STATUS_KEY] : []),
    ];
    return keys.length > 0 ? keys : undefined;
  }, [reviewPhase, todoPanel.present]);
  // Only the count drove a section header; the strip's badges now come from the
  // snapshot and the checkpoint store directly.
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [surfaceFocusToken, setSurfaceFocusToken] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  /** The one explicit wake per mounted pane; status changes never re-trigger it. */
  const ensuredPaneRef = useRef<string | null>(null);

  /**
   * The completion stack for this tab (plan step 7): commands from the host's
   * `commands.list`, files from `files.list` (rooted at this session's cwd),
   * `#` documents (empty until the Office registry arrives in step 20) and the
   * extension providers the host runs (plan step 16) through the same
   * `factory(current)` shape.
   */
  const completion = useMemo(
    () => ({
      provider: createCompletionProvider({
        command: createCommandProvider({
          loadCommands: () => loadCommands(tabId),
          completeCommand: (request) =>
            completeCommandArguments(tabId, request.name, request.prefix),
          completeAppArgument: (request) =>
            completeAppCommandArguments(tabId, request.name, request.prefix),
        }),
        file: createFileProvider({ loadFiles: () => loadFiles(tabId) }),
        document: createDocumentProvider(documentMentionSource(tabId)),
        extension: {
          suggest: (request) => extensionCompletion(tabId, request),
          apply: (request) => extensionApplyCompletion(tabId, request),
        },
      }),
      apply: async (
        item: CompletionItem,
        suggestions: CompletionSuggestions,
        buffer: { lines: string[]; line: number; col: number },
      ) => {
        // Only host-run extension-provider items need the remote apply. An
        // extension *command* item also carries source "extension" but is
        // applied locally, so provenance is the `remote` flag, not the source.
        if (!tabId || item.remote !== true) return null;
        return extensionApplyCompletion(tabId, {
          lines: buffer.lines,
          cursorLine: buffer.line,
          cursorCol: buffer.col,
          item: {
            value: item.value,
            label: item.label,
            ...(item.description === undefined ? {} : { description: item.description }),
            ...(item.source === undefined ? {} : { source: item.source }),
            ...(item.appendSpace === undefined ? {} : { appendSpace: item.appendSpace }),
          },
          prefix: suggestions.prefix,
        });
      },
    }),
    [
      tabId,
      loadCommands,
      completeCommandArguments,
      completeAppCommandArguments,
      loadFiles,
      extensionCompletion,
      extensionApplyCompletion,
    ],
  );

  const active = tabs.find((tab) => tab.id === tabId) ?? null;
  const activeId = active?.id ?? null;
  // The review page is a loopback web tab linked to this session. The bar can
  // focus it; without one it stays command-only (the page may have been closed).
  const reviewTabId =
    reviewMode && active
      ? (tabs.find(
          (tab) =>
            tab.kind === "web" && tab.sessionTabId === active.id && isLoopbackUrl(tab.url ?? null),
        )?.id ?? null)
      : null;
  const [mentionRequest, setMentionRequest] = useState<{
    id: number;
    tabId: string;
    path: string;
    kind: WorkspaceEntryKind;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const mentionSeq = useRef(0);
  const dropDepth = useRef(0);

  // An extension dialog is per-tab and wins over the composer and a docked TUI
  // overlay: it is the newest interaction the extension is blocked on.
  const dialog = extensionDialogs.find((entry) => entry.tabId === active?.id) ?? null;

  // The emulated terminal grid belongs to this session column, not to the TUI
  // surface (2026-10-26 plan, step 1). Reporting the surface's own frame made
  // `terminal.rows` depend on the component's output, which collapsed the
  // workflow questionnaire to a single row. The hook also re-reports when the
  // tab status changes so a freshly spawned host receives the real grid.
  const viewport = useTuiViewport({
    ref: viewportRef,
    tabId: activeId ?? "",
    revision: active?.status ?? null,
    report: resizeTuiSurface,
  });

  // Hooks run before the early return: `messages.get` seeds the transcript of the
  // tab being shown (once per tab; live batches append after that). A web tab has
  // no Pi session to hydrate (plan step 21).
  //
  // The tab status is a dependency so a restored-but-stopped tab (a relaunch)
  // retries hydration once its host resumes; the first attempt can run before the
  // host is ready and must not be cached as "no history" (plan step 25).
  useEffect(() => {
    if (activeId && active?.kind !== "web") void hydrateTranscript(activeId);
  }, [activeId, active?.kind, active?.status, hydrateTranscript]);

  // The extension shortcut list feeds the composer's Tab mode cycle. Like the
  // transcript hydration above, the first attempt can run before the host's
  // session is open and must not be cached as an empty list (2026-10-20
  // startup-tab-cycle plan): `loadShortcuts` retries a tab whose last attempt
  // failed, so re-running it here on status change recovers the Tab cycle once
  // the host resumes. Cheap when the list is already loaded (the store's
  // idempotence guard returns early without a request).
  useEffect(() => {
    // Only the focused pane owns the global shortcut list; a background pane
    // refreshes it the moment it gains focus.
    if (activeId !== null && activeId === focusedTabId && active?.kind === "session") {
      void loadShortcuts();
    }
  }, [activeId, focusedTabId, active?.kind, active?.status, loadShortcuts]);

  // Mounting a pane is the gesture that may wake a stopped host. This replaces
  // the old accidental wake through `tui.resize`: the viewport effect still
  // reports while the host is live, but a status change can no longer spawn a
  // host that was just recycled (2026-11-06 Strata loop).
  useEffect(() => {
    if (!activeId || active?.kind === "web") return;
    if (ensuredPaneRef.current === activeId) return;
    ensuredPaneRef.current = activeId;
    if (active?.status === "stopped") void ensureSession(activeId);
  }, [activeId, active?.kind, active?.status, ensureSession]);

  // Git polling and the checkpoint timeline are seeded by `ProjectRail` (the
  // rail follows the selected project, not this tab — 2026-10-30 plan), so the
  // session view no longer owns a scope of its own.

  // Proactive attachment readiness: metadata-only, debounced and never a send.
  // Hooks must stay above the early return, so the idle predicate is derived
  // from the tab record/state directly instead of the later `attachmentReady`.
  const readinessSessionState = active
    ? (sessionStates[active.id] as
        | {
            idle?: unknown;
            streaming?: unknown;
            compacting?: unknown;
            retrying?: unknown;
          }
        | undefined)
    : undefined;
  const readinessText = active ? (drafts[active.id] ?? "") : "";
  const readinessAvailable = attachmentDraft.available;
  const readiness = attachmentDraft.readiness;
  const hasAttachmentDescriptors = attachmentDraft.state.descriptors.length > 0;
  const attachmentDescriptorIds = attachmentDraft.state.descriptors
    .map((descriptor) => descriptor.id)
    .join(",");
  const attachmentIdleForReadiness =
    active !== null &&
    active.status === "idle" &&
    readinessSessionState?.idle === true &&
    readinessSessionState.streaming !== true &&
    readinessSessionState.compacting !== true &&
    readinessSessionState.retrying !== true &&
    !reviewMode;
  useEffect(() => {
    if (!readinessAvailable || !attachmentIdleForReadiness || !hasAttachmentDescriptors) return;
    const timer = setTimeout(() => {
      void readiness(readinessText);
    }, 300);
    return () => clearTimeout(timer);
  }, [
    readinessAvailable,
    readiness,
    attachmentIdleForReadiness,
    hasAttachmentDescriptors,
    attachmentDescriptorIds,
    readinessText,
  ]);

  if (!active) return <WelcomeView />;

  const transcript = transcripts[active.id];
  const contextUsage = contextUsageOf(sessionStates[active.id]);
  const levels = thinkingLevels[active.id] ?? thinkingLevelsOf(sessionStates[active.id]);
  const activeState = sessionStates[active.id] as
    | {
        model?: unknown;
        thinkingLevel?: unknown;
        tokens?: { cost?: unknown };
        idle?: unknown;
        streaming?: unknown;
        compacting?: unknown;
        retrying?: unknown;
      }
    | undefined;
  const attachmentReadinessBlocked =
    hasAttachmentDescriptors &&
    (attachmentDraft.state.readiness === null ||
      attachmentDraft.state.readiness.outcome !== "ready");
  const attachmentReady =
    active.status === "idle" &&
    activeState?.idle === true &&
    activeState.streaming !== true &&
    activeState.compacting !== true &&
    activeState.retrying !== true &&
    !reviewMode;
  const cost = typeof activeState?.tokens?.cost === "number" ? activeState.tokens.cost : null;
  const thinkingLevel =
    typeof activeState?.thinkingLevel === "string" ? activeState.thinkingLevel : null;
  const currentModelKey = modelKeyOf(activeState?.model);
  // The footer and the composer controls follow the live session state; the tab
  // record is the fallback before the first state frame arrives (plan step 3).
  const modelLabel = modelKeyOf(activeState?.model) ?? active.model;
  const modelId =
    typeof (activeState?.model as { id?: unknown })?.id === "string"
      ? ((activeState?.model as { id: string }).id ?? null)
      : (active.model?.split("/").pop() ?? null);
  // A non-overlay `custom` component owns the composer region. A bottom-anchored
  // full-width overlay (the workflow questionnaire) is a bottom sheet, so it is
  // docked in flow as well: the transcript shrinks and stays scrollable instead
  // of being covered by a popup. Any other overlay floats inside this column.
  const dockedOverlay = Boolean(
    tuiSurface?.custom && tuiSurface.overlay && isDockedOverlay(tuiSurface.bounds, viewport),
  );
  const tuiOwnsComposer = Boolean(tuiSurface?.custom && (!tuiSurface.overlay || dockedOverlay));
  const floatingOverlay = Boolean(tuiSurface?.custom && tuiSurface.overlay && !dockedOverlay);
  // A docked/float surface owns the keyboard while it is up. Clicking the
  // transcript must give the keys back to it, never to the hidden (or inert)
  // composer — otherwise Tab/arrow keys silently stop reaching the extension.
  const surfaceOwnsKeyboard = tuiOwnsComposer || floatingOverlay || dialog !== null;
  const composerUnavailable = surfaceOwnsKeyboard;

  const restoreComposerFocus = (): void => {
    // A dialog owns the keys while it is open; never pull them away from it.
    if (dialog !== null) return;
    if (tuiOwnsComposer || floatingOverlay) setSurfaceFocusToken((token) => token + 1);
    else setComposerFocusToken((token) => token + 1);
  };

  const handleTodoAction = async (action: TodoPanelActionId): Promise<void> => {
    await runTodoPanelAction(active.id, action);
    restoreComposerFocus();
  };

  const resetDrop = (): void => {
    dropDepth.current = 0;
    setDropActive(false);
  };

  const onWorkspaceDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isWorkspaceDrag(event.dataTransfer)) return;
    event.preventDefault();
    dropDepth.current += 1;
    if (!composerUnavailable) setDropActive(true);
  };

  const onWorkspaceDragOver = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isWorkspaceDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onWorkspaceDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!isWorkspaceDrag(event.dataTransfer)) return;
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDropActive(false);
  };

  const onWorkspaceDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    resetDrop();
    // The composer handles a drop on its own surface and calls preventDefault;
    // it still bubbles here so the overlay is cleared.
    if (event.defaultPrevented) return;
    const payload = readWorkspaceDrop(event.dataTransfer);
    if (!payload) return;
    event.preventDefault();
    if (composerUnavailable) {
      setHint("The composer is not available in this session right now.");
      return;
    }
    if (active.status === "crashed" || active.status === "failed") {
      setHint("This session cannot accept prompts right now.");
      return;
    }
    if (!sameFolder(payload.projectPath, active.cwd)) {
      setHint("That file belongs to a different folder.");
      return;
    }
    mentionSeq.current += 1;
    setMentionRequest({
      id: mentionSeq.current,
      tabId: active.id,
      path: payload.path,
      kind: payload.kind,
    });
  };

  // Ctrl+O is the only expand-all control: null leaves each card on its own
  // default, true/false is the explicit app-wide state (2026-10-30 copy plan).
  const effectiveToolsExpanded = toolsExpandedState ?? null;

  // A custom footer owns the footer region, so every widget stays in its strip.
  // Otherwise a one-line widget is a footer column (2026-10-31 UI plan).
  const belowWidgets = tuiSurface?.widgetsBelow ?? [];
  const belowSplit = tuiSurface?.footer
    ? { inline: [], stacked: belowWidgets }
    : splitSingleLineFrames(belowWidgets);

  return (
    <div
      data-testid="session-view"
      className="relative flex h-full flex-col"
      onDragEnter={onWorkspaceDragEnter}
      onDragOver={onWorkspaceDragOver}
      onDragLeave={onWorkspaceDragLeave}
      onDrop={onWorkspaceDrop}
    >
      {/* The tab strip carries the visible title, status and review tabs; the
          only heading this view needs is for assistive tech (minimal-session-ui
          step 4). */}
      <h1 className="sr-only">{active.title}</h1>

      {dropActive && !composerUnavailable ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-surface/70">
          <p className="rounded-md border border-accent bg-surface px-3 py-2 text-xs text-ink shadow-lg">
            Drop to mention this file in the prompt
          </p>
        </div>
      ) : null}

      {active.status === "starting" && !active.error ? (
        <StartingBanner key={active.id} onCancel={() => void cancelSession(active.id)} />
      ) : null}

      {active.memoryOverBudget && active.status !== "crashed" && active.status !== "failed" ? (
        <div
          data-testid="session-memory-warning"
          className="banner banner--warn mx-4 mt-2 flex items-start justify-between gap-3"
          role="status"
        >
          <span>
            This session is using more than the 1 GB host memory budget. It is protected from
            automatic recycling while you are viewing it; restart it to free memory.
          </span>
          <Button size="sm" variant="secondary" onClick={() => void restartTab(active.id)}>
            Restart
          </Button>
        </div>
      ) : null}

      {active.error || active.status === "crashed" || active.status === "failed" ? (
        <div className="banner banner--error mx-4 mt-2 flex items-start justify-between gap-3">
          <MultilineText className="min-w-0">
            {active.error ??
              (active.status === "crashed"
                ? "The session host crashed. History is on disk and returns after a restart."
                : "The session host was stopped after repeated failures.")}
          </MultilineText>
          <Button size="sm" variant="secondary" onClick={() => void restartTab(active.id)}>
            Restart
          </Button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div
          ref={viewportRef}
          data-tui-viewport=""
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <TuiCellProbe />
          <div
            className="min-h-0 flex-1"
            style={{ minHeight: viewport.cell.height }}
            onPointerDown={() => {
              // A ready tab is already awake; a stopped/stale one is repaired
              // here. Crashed/failed stay on the explicit Restart path.
              if (active.status !== "crashed" && active.status !== "failed") {
                void ensureSession(active.id);
              }
            }}
            onClick={(event) => {
              if (surfaceOwnsKeyboard) {
                setSurfaceFocusToken((token) => token + 1);
                return;
              }
              const target = event.target as HTMLElement;
              // Focus only the empty background/empty state: clicking a message
              // row must keep click-to-select and double-click word selection.
              if (
                target.closest(
                  "button, a, input, textarea, select, summary, [contenteditable], [data-testid='transcript-row'], [data-no-composer-focus]",
                )
              ) {
                return;
              }
              if (window.getSelection()?.isCollapsed === false) return;
              setComposerFocusToken((token) => token + 1);
            }}
          >
            <Transcript
              items={transcript?.items ?? []}
              tabId={active.id}
              running={active.status === "running"}
              onAbort={() => void stopRun(active.id)}
              empty={{ cwd: active.cwd, project: project?.path ?? null, model: modelLabel }}
              thinkingLabel={extensionUi?.hiddenThinkingLabel ?? null}
              toolsExpanded={effectiveToolsExpanded}
              onToggleToolsExpanded={() => toggleToolsExpanded(active.id)}
              followPaused={picker !== null}
            />
          </div>
          {transcript?.runStatus ? (
            <RunStatusRow
              status={transcript.runStatus}
              onCancel={() => {
                const store = useAppStore.getState();
                if (transcript.runStatus?.kind === "compacting") {
                  void store.abortCompaction(active.id);
                } else {
                  void store.abortRetry(active.id);
                }
              }}
            />
          ) : null}
          {(active.status === "running" || extensionBusy) && reviewPhase === null ? (
            <WorkingRow
              working={
                extensionUi?.working ?? {
                  message: null,
                  visible: null,
                  frames: null,
                  intervalMs: null,
                }
              }
              startedAt={transcript?.runStartedAt ?? null}
              showCancelHint
            />
          ) : null}
          {tuiSurface?.header ? (
            <TuiSlotFrame
              frame={tuiSurface.header}
              className="shrink-0 border-t border-line py-1"
            />
          ) : null}
          {todoPanel.present ? (
            <TodoPanelBar panel={todoPanel} onAction={handleTodoAction} />
          ) : null}
          <WidgetStrip tabId={active.id} placement="aboveEditor" />
          <TuiWidgetStrip frames={tuiSurface?.widgetsAbove ?? []} placement="aboveEditor" />
          {reviewPhase ? (
            <ReviewBar
              phase={reviewPhase}
              text={reviewLine ?? ""}
              canOpenReview={reviewTabId !== null}
              onPause={() => void runReviewCommand(active.id, "review-pause")}
              onResume={() => void runReviewCommand(active.id, "review-resume")}
              onAbort={() => void runReviewCommand(active.id, "review-abort")}
              onOpenReview={() => {
                if (reviewTabId) void activateTab(reviewTabId);
              }}
            />
          ) : null}
          {dialog ? (
            <ExtensionDialogDock
              dialog={dialog}
              maxHeight={viewport.rows * viewport.cell.height}
              focusToken={surfaceFocusToken}
              active={active.id === focusedTabId}
            />
          ) : tuiOwnsComposer && tuiSurface ? (
            <>
              {attachmentDraft.available && attachmentDraft.state.descriptors.length > 0 ? (
                <div
                  className="flex flex-col gap-1 border-t border-line bg-surface px-2 py-1.5"
                  data-testid="attachment-retained-bar"
                  aria-label="Retained files"
                >
                  <p className="text-[11px] text-ink">
                    {attachmentDraft.state.descriptors.length} file
                    {attachmentDraft.state.descriptors.length === 1 ? "" : "s"} retained this draft;
                    the extension composer cannot send them.
                  </p>
                  <ul className="flex min-w-0 flex-wrap gap-1">
                    {attachmentDraft.state.descriptors.map((descriptor) => (
                      <li
                        key={descriptor.id}
                        className="flex min-w-0 items-center gap-1 rounded-sm border border-line bg-raised/60 px-1.5 py-0.5"
                      >
                        <span className="max-w-40 truncate text-[10px]" title={descriptor.name}>
                          {descriptor.name}
                        </span>
                        {descriptor.reason ? (
                          <span className="text-[10px] text-warn">
                            {descriptor.reason === "conversion_required"
                              ? "needs conversion"
                              : "blocked"}
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="text-[10px] text-ink-muted underline-offset-2 hover:underline"
                          aria-label={`Remove ${descriptor.name} from this draft`}
                          onClick={() => void attachmentDraft.remove(descriptor.id)}
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                  {attachmentDraft.state.readiness?.outcome === "blocked" ? (
                    <p className="text-[10px] text-warn" role="status">
                      Not ready to send. Remove or resolve the files before switching back to the
                      normal composer.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <TuiSurface
                tabId={active.id}
                snapshot={tuiSurface}
                cell={viewport.cell}
                grid={{ rows: viewport.rows, cols: viewport.cols }}
                variant="dock"
                focusToken={surfaceFocusToken}
              />
            </>
          ) : (
            <div className="contents" inert={floatingOverlay || undefined}>
              <Composer
                tabId={active.id}
                running={active.status === "running"}
                enabled={active.status !== "crashed" && active.status !== "failed"}
                sleeping={active.status === "stopped"}
                focusToken={composerFocusToken}
                onWake={() => void ensureSession(active.id)}
                toolsSlot={
                  <>
                    <Button
                      size="icon-md"
                      variant="ghost"
                      data-testid="composer-model"
                      aria-label="Change model"
                      title={
                        modelLabel
                          ? `${modelLabel}${thinkingLevel ? ` · thinking ${thinkingLevel}` : ""}`
                          : "Choose a model"
                      }
                      onClick={() => {
                        openPicker("model", { tabId });
                        void loadModels(active.id);
                      }}
                    >
                      <Cpu className="size-4" aria-hidden />
                    </Button>
                    <Button
                      size="icon-md"
                      variant="ghost"
                      data-testid="composer-thinking"
                      aria-label={
                        thinkingLevel ? `Thinking level: ${thinkingLevel}` : "Thinking level"
                      }
                      title={thinkingLevelTitle(thinkingLevel, levels, modelLabel)}
                      onClick={() => openPicker("thinking", { tabId })}
                    >
                      <ThinkingLevelIcon level={thinkingLevel} />
                    </Button>
                    <ContextRing usage={contextUsage} cost={cost} />
                  </>
                }
                draft={drafts[active.id] ?? ""}
                queue={transcript?.queue ?? { steering: [], followUp: [] }}
                attachmentState={attachmentDraft.available ? attachmentDraft.state : undefined}
                attachmentReady={attachmentReady}
                attachmentReadinessBlocked={attachmentReadinessBlocked}
                onAttachmentFiles={
                  attachmentDraft.available ? attachmentDraft.importFiles : undefined
                }
                onPickAttachments={attachmentDraft.available ? attachmentDraft.pick : undefined}
                onRemoveAttachment={attachmentDraft.available ? attachmentDraft.remove : undefined}
                onPreviewAttachment={
                  attachmentDraft.available ? attachmentDraft.preview : undefined
                }
                onDismissAttachmentIssue={
                  attachmentDraft.available ? attachmentDraft.dismissIssue : undefined
                }
                onDismissAttachmentImport={
                  attachmentDraft.available ? attachmentDraft.dismissImport : undefined
                }
                onRetryAttachmentDelivery={
                  attachmentDraft.available
                    ? () =>
                        sendAttachmentPrompt(active.id, drafts[active.id] ?? "", () =>
                          attachmentDraft.retryDelivery(),
                        )
                    : undefined
                }
                onResetAttachmentDraft={
                  attachmentDraft.available ? attachmentDraft.resetDraft : undefined
                }
                workspaceRoot={active.cwd}
                mentionRequest={mentionRequest?.tabId === active.id ? mentionRequest : null}
                onMentionHandled={(id) =>
                  setMentionRequest((current) => (current?.id === id ? null : current))
                }
                workflowStatus={workflowStatus}
                extensionShortcuts={shortcuts.shortcuts}
                onInvokeShortcut={(key) => void invokeShortcut(key)}
                onRequestShortcuts={() => void loadShortcuts()}
                onDraftChange={(text) => setDraft(active.id, text)}
                onSend={async (text, images, options) => {
                  if (attachmentDraft.state.descriptors.length > 0) {
                    if (images.length > 0) {
                      setHint("Remove legacy image payloads before sending managed files.");
                      return false;
                    }
                    return sendAttachmentPrompt(active.id, text, () =>
                      attachmentDraft.submit(expandPastes(active.id, text)),
                    );
                  }
                  const mode = options?.followUp ? "followUp" : "steer";
                  return sendPrompt(active.id, text, {
                    ...(active.status === "running" ? { mode } : {}),
                    ...(options?.preferredSource
                      ? { preferredSource: options.preferredSource }
                      : {}),
                    ...(images.length > 0
                      ? {
                          images: images.map((image) => ({
                            type: "image" as const,
                            data: image.data,
                            mimeType: image.mimeType,
                          })),
                        }
                      : {}),
                  });
                }}
                completion={completion}
                onStop={() => void stopRun(active.id)}
                // Escape goes through the extension first (plan step 24): a
                // running review pauses instead of aborting. A manual review
                // runs on an idle tab, so `escapeActive` forwards too.
                onEscape={() => void interruptRun(active.id)}
                escapeActive={extensionBusy || reviewMode}
                reviewMode={reviewMode}
                onClearQueue={() => void clearQueue(active.id)}
                onRestoreQueue={() => void restoreQueue(active.id)}
                onHistoryStep={(direction, caret) => historyStep(active.id, direction, caret)}
              />
            </div>
          )}
          <TuiWidgetStrip frames={belowSplit.stacked} placement="belowEditor" />{" "}
          <WidgetStrip tabId={active.id} placement="belowEditor" />
          {/* One footer: an extension's `ctx.ui.setFooter()` replaces the
              built-in Pi-shaped rows instead of stacking above them
              (minimal-session-ui step 7). It renders outside the editor branch,
              so it survives a `custom` UI. */}
          {tuiSurface?.footer ? (
            <TuiSlotFrame
              frame={tuiSurface.footer}
              className="shrink-0 border-t border-line py-1"
            />
          ) : (
            <SessionFooter
              className="shrink-0 px-3 pb-1"
              homeDir={homeDir}
              hiddenStatusKeys={hiddenSessionStatusKeys}
              widgets={
                belowSplit.inline.length > 0 ? <TuiWidgetInline frames={belowSplit.inline} /> : null
              }
              facts={{
                cwd: active.cwd,
                branch: gitBranch,
                model: modelLabel,
                modelId,
                thinking: thinkingLevel,
                context: contextUsage,
                cost,
                usage:
                  activeState &&
                  typeof (activeState.tokens as { input?: unknown })?.input === "number"
                    ? {
                        input: Number((activeState.tokens as { input?: unknown }).input ?? 0),
                        output: Number((activeState.tokens as { output?: unknown }).output ?? 0),
                        cacheRead: Number(
                          (activeState.tokens as { cacheRead?: unknown }).cacheRead ?? 0,
                        ),
                        cacheWrite: Number(
                          (activeState.tokens as { cacheWrite?: unknown }).cacheWrite ?? 0,
                        ),
                      }
                    : null,
                auto: {
                  compaction:
                    (activeState as { autoCompaction?: unknown })?.autoCompaction === true,
                  retry: (activeState as { autoRetry?: unknown })?.autoRetry === true,
                },
                provider:
                  typeof (activeState?.model as { provider?: unknown })?.provider === "string"
                    ? ((activeState?.model as { provider?: string }).provider ?? null)
                    : null,
              }}
              statuses={extensionUi?.statuses}
            />
          )}
          {floatingOverlay && tuiSurface ? (
            <TuiSurface
              tabId={active.id}
              snapshot={tuiSurface}
              cell={viewport.cell}
              grid={{ rows: viewport.rows, cols: viewport.cols }}
              variant="float"
              focusToken={surfaceFocusToken}
            />
          ) : null}
        </div>
      </div>

      <ModelPicker
        key={`${active.id}:${picker === "model" ? `open:${pickerSearch}` : "closed"}`}
        open={picker === "model" && pickerTabId === tabId}
        entries={modelCatalog[active.id] ?? []}
        auth={providerAuth[active.id] ?? {}}
        currentKey={currentModelKey}
        initialQuery={pickerSearch}
        scoped={scopedModels ?? EMPTY_SCOPE}
        patterns={scopedPatterns ?? EMPTY_SCOPE}
        diagnostics={scopeDiagnostics}
        defaultProblem={defaultModelIssue}
        scopeTarget={scopeTarget ?? "global"}
        scopeBusyKey={scopeBusyKey}
        error={pickerError}
        onPick={(entry, options) => void setModel(active.id, entry, options)}
        onToggleScope={(entry) => void toggleModelScope(active.id, entry.provider, entry.id)}
        onSignIn={(provider) => {
          closePicker();
          setView("connections");
          setHint(`${provider} needs credentials — sign in here, then pick the model again.`);
        }}
        onOpenModelsJson={() => {
          closePicker();
          setView("settings");
          setHint("Editing models.json arrives with the Connections work (step 9).");
        }}
        onClose={closePicker}
      />

      <ThinkingPicker
        open={picker === "thinking" && pickerTabId === tabId}
        levels={levels}
        current={thinkingLevel}
        modelLabel={modelLabel}
        onPick={(level, options) => void setThinking(active.id, level, options)}
        onClose={closePicker}
      />
    </div>
  );
}
