import { useEffect, useMemo, useRef, useState } from "react";
import { Composer } from "../session/Composer";
import { ComposerFooter } from "../session/ComposerFooter";
import { parseWorkflowStatus } from "../../../shared/workflow-mode";
import { Transcript } from "../session/Transcript";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Separator } from "../ui/separator";
import { WelcomeView } from "./WelcomeView";
import { useAppStore } from "../state/app-store";
import { WidgetStrip } from "../extension-ui/WidgetStrip";
import { ExtensionDialogDock } from "../extension-ui/ExtensionDialog";
import { WorkingRow } from "../extension-ui/WorkingRow";
import { RunStatusRow } from "../session/RunStatusRow";
import { TuiCellProbe, TuiSlotFrame, TuiSurface } from "../tui/TuiSurface";
import { TuiWidgetStrip } from "../tui/TuiWidgetStrip";
import { isDockedOverlay } from "../tui/tui-geometry";
import { useTuiViewport } from "../tui/use-tui-viewport";
import { WebTabView } from "../web/WebTabView";
import { createCommandProvider } from "../completion/command-source";
import { createDocumentProvider } from "../completion/document-source";
import { createFileProvider } from "../completion/file-source";
import { documentMentionsForHost } from "../../../shared/office-documents";
import { createCompletionProvider } from "../completion/stack";
import type { CompletionItem, CompletionSuggestions } from "../completion/types";
import { ContextRing } from "../session/ContextRing";
import { ModelPicker } from "../session/ModelPicker";
import { ThinkingPicker } from "../session/ThinkingPicker";
import { contextUsageOf, modelKeyOf, thinkingLevelsOf } from "../session/model-catalog";
import type { ViewMode } from "../../../shared/prefs";
import { SESSION_STATUS_LABEL, type TabStatus } from "../../../shared/session-ipc";

/**
 * Session view (plan step 5).
 *
 * A compact header (status, model, usage, restart) and then the transcript —
 * which is where the session actually lives now. With no open tab it stays the
 * welcome state, so the app never shows an empty chat box with nowhere to send.
 */

const STATUS_TONE: Record<TabStatus, "neutral" | "accent" | "ok" | "warn" | "danger"> = {
  starting: "warn",
  idle: "ok",
  running: "accent",
  crashed: "danger",
  failed: "danger",
  stopped: "neutral",
};

/** Stable empty scope for a tab whose scope has not loaded yet. */
const EMPTY_SCOPE: readonly string[] = [];

/** The transcript density modes, in the order the menu lists them. */
const VIEW_MODES: readonly ViewMode[] = ["normal", "verbose", "summary"];

const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  normal: "Normal",
  verbose: "Verbose",
  summary: "Summary",
};

/**
 * The view-mode control (plan step 6).
 *
 * A native `<select>` was the only unstyled control in the session header: it
 * did not match the buttons beside it, and it could not show which mode was
 * active in the app's own vocabulary. The menu does both — and the marker on
 * the active entry is the same one the extension dialogs use (plan step 4).
 */
function ViewModeMenu({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="View mode" title={`View mode: ${value}`}>
          {VIEW_MODE_LABELS[value]}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {VIEW_MODES.map((mode) => (
          <DropdownMenuItem key={mode} onSelect={() => onChange(mode)}>
            <span
              aria-hidden
              className={cn(
                "w-3 shrink-0 text-center font-mono",
                mode === value ? "text-accent" : "text-transparent",
              )}
            >
              {mode === value ? "✓" : " "}
            </span>
            {VIEW_MODE_LABELS[mode]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
const documentMentionSource = {
  list: () => {
    const state = useAppStore.getState();
    return documentMentionsForHost(
      state.officeDocuments?.panes ?? [],
      state.tabs,
      state.activeTabId,
    );
  },
};

/**
 * The session-scoped facts line that used to summarize context usage moved to
 * `ComposerFooter` (`contextFooterText`), which the composer renders under the
 * input. `usageLine` was removed with it; the percentage-not-fraction guard now
 * lives in `tests/renderer/composer-footer.test.tsx`.
 */

export function SessionView() {
  const project = useAppStore((state) => state.project);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const sessionStates = useAppStore((state) => state.sessionStates);
  const transcripts = useAppStore((state) => state.transcripts);
  const activateTab = useAppStore((state) => state.activateTab);
  const ensureSession = useAppStore((state) => state.ensureSession);
  const restartTab = useAppStore((state) => state.restartTab);
  const hydrateTranscript = useAppStore((state) => state.hydrateTranscript);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const stopRun = useAppStore((state) => state.stopRun);
  const clearQueue = useAppStore((state) => state.clearQueue);
  const restoreQueue = useAppStore((state) => state.restoreQueue);
  const setDraft = useAppStore((state) => state.setDraft);
  const setSendMode = useAppStore((state) => state.setSendMode);
  const historyStep = useAppStore((state) => state.historyStep);
  const drafts = useAppStore((state) => state.prefs.drafts);
  const sendModes = useAppStore((state) => state.sendModes);
  const loadCommands = useAppStore((state) => state.loadCommands);
  const completeCommandArguments = useAppStore((state) => state.completeCommandArguments);
  const completeAppCommandArguments = useAppStore((state) => state.completeAppCommandArguments);
  const loadFiles = useAppStore((state) => state.loadFiles);
  const modelCatalog = useAppStore((state) => state.modelCatalog);
  const providerAuth = useAppStore((state) => state.providerAuth);
  const thinkingLevels = useAppStore((state) => state.thinkingLevels);
  const picker = useAppStore((state) => state.picker);
  const pickerError = useAppStore((state) => state.pickerError);
  const pickerSearch = useAppStore((state) => state.pickerSearch);
  const loadModels = useAppStore((state) => state.loadModels);
  const setModel = useAppStore((state) => state.setModel);
  const setThinking = useAppStore((state) => state.setThinking);
  const toggleModelScope = useAppStore((state) => state.toggleModelScope);
  const renameSession = useAppStore((state) => state.renameSession);
  const setViewMode = useAppStore((state) => state.setViewMode);
  const openPicker = useAppStore((state) => state.openPicker);
  const closePicker = useAppStore((state) => state.closePicker);
  const setView = useAppStore((state) => state.setView);
  const setHint = useAppStore((state) => state.setHint);
  const scopedModels = useAppStore((state) =>
    activeTabId ? state.modelScope[activeTabId] : undefined,
  );
  const scopedPatterns = useAppStore((state) =>
    activeTabId ? state.modelScopePatterns[activeTabId] : undefined,
  );
  const scopeTarget = useAppStore((state) =>
    activeTabId ? state.modelScopeTarget[activeTabId] : undefined,
  );
  const scopeBusyKey = useAppStore((state) =>
    activeTabId ? (state.modelScopeBusy[activeTabId] ?? null) : null,
  );
  const viewMode = useAppStore((state) => state.prefs.viewMode);
  const extensionUi = useAppStore((state) =>
    activeTabId ? state.extensionUi[activeTabId] : undefined,
  );
  const extensionDialogs = useAppStore((state) => state.extensionDialogs);
  const toolsExpandedState = useAppStore((state) =>
    activeTabId ? state.toolsExpanded[activeTabId] : undefined,
  );
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
  const tuiSurface = useAppStore((state) =>
    activeTabId ? state.tuiSurfaces[activeTabId] : undefined,
  );
  // Only the count drove a section header; the strip's badges now come from the
  // snapshot and the checkpoint store directly.
  const webTabStates = useAppStore((state) => state.webTabStates);
  const [editingName, setEditingName] = useState(false);
  const [composerFocusToken, setComposerFocusToken] = useState(0);
  const [surfaceFocusToken, setSurfaceFocusToken] = useState(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

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
          loadCommands: () => loadCommands(activeTabId ?? ""),
          completeCommand: (request) =>
            completeCommandArguments(activeTabId ?? "", request.name, request.prefix),
          completeAppArgument: (request) =>
            completeAppCommandArguments(activeTabId ?? "", request.name, request.prefix),
        }),
        file: createFileProvider({ loadFiles: () => loadFiles(activeTabId ?? "") }),
        document: createDocumentProvider(documentMentionSource),
        extension: activeTabId
          ? {
              suggest: (request) => extensionCompletion(activeTabId, request),
              apply: (request) => extensionApplyCompletion(activeTabId, request),
            }
          : null,
      }),
      apply: async (
        item: CompletionItem,
        suggestions: CompletionSuggestions,
        buffer: { lines: string[]; line: number; col: number },
      ) => {
        // Only host-run extension-provider items need the remote apply. An
        // extension *command* item also carries source "extension" but is
        // applied locally, so provenance is the `remote` flag, not the source.
        if (!activeTabId || item.remote !== true) return null;
        return extensionApplyCompletion(activeTabId, {
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
      activeTabId,
      loadCommands,
      completeCommandArguments,
      completeAppCommandArguments,
      loadFiles,
      extensionCompletion,
      extensionApplyCompletion,
    ],
  );

  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeId = active?.id ?? null;

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
    if (activeId && active?.kind === "session") void loadShortcuts();
  }, [activeId, active?.kind, active?.status, loadShortcuts]);

  // Git polling and the checkpoint timeline are seeded by `ProjectRail` (the
  // rail follows the selected project, not this tab — 2026-10-30 plan), so the
  // session view no longer owns a scope of its own.

  if (!active) return <WelcomeView />;
  if (active.kind === "web") return <WebTabView tab={active} />;

  const transcript = transcripts[active.id];
  const contextUsage = contextUsageOf(sessionStates[active.id]);
  const levels = thinkingLevels[active.id] ?? thinkingLevelsOf(sessionStates[active.id]);
  const activeState = sessionStates[active.id] as
    { model?: unknown; thinkingLevel?: unknown; tokens?: { cost?: unknown } } | undefined;
  const cost = typeof activeState?.tokens?.cost === "number" ? activeState.tokens.cost : null;
  const thinkingLevel =
    typeof activeState?.thinkingLevel === "string" ? activeState.thinkingLevel : null;
  const currentModelKey = modelKeyOf(activeState?.model);
  // The header/footer follow the live session state; the tab record is the
  // fallback before the first state frame arrives (plan step 3).
  const modelLabel = modelKeyOf(activeState?.model) ?? active.model;
  const needsRestart =
    active.status === "stopped" || active.status === "crashed" || active.status === "failed";
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

  // The view mode is a semantic override (plan step 18): Verbose expands every
  // tool card, Summary collapses them, Normal uses the Ctrl+O state (or each
  // card's own default while the user has not toggled anything).
  const effectiveToolsExpanded =
    viewMode === "verbose" ? true : viewMode === "summary" ? false : (toolsExpandedState ?? null);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        {/* The session's identity on the left: the title truncates rather than
            pushing the controls off the row (plan step 6). */}
        <div className="flex min-w-0 shrink items-center gap-2">
          {editingName ? (
            <input
              aria-label="Session name"
              autoFocus
              defaultValue={active.title}
              onBlur={(event) => {
                setEditingName(false);
                void renameSession(active.id, event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  setEditingName(false);
                  void renameSession(active.id, event.currentTarget.value);
                }
                if (event.key === "Escape") setEditingName(false);
              }}
              className="min-w-0 flex-1 rounded-sm border border-line bg-raised px-2 py-0.5 text-sm text-ink outline-none"
            />
          ) : (
            <h1
              className="min-w-0 truncate text-sm font-semibold"
              title="Double-click to rename"
              onDoubleClick={() => setEditingName(true)}
            >
              {active.title}
            </h1>
          )}
          <Badge
            tone={STATUS_TONE[active.status]}
            title={`Session status: ${SESSION_STATUS_LABEL[active.status]}`}
          >
            {SESSION_STATUS_LABEL[active.status]}
          </Badge>
          {needsRestart ? (
            <button
              type="button"
              className="shrink-0 text-xs text-accent underline"
              onClick={() => {
                if (active.status === "stopped") void ensureSession(active.id, { force: true });
                else void activateTab(active.id);
              }}
            >
              {active.status === "stopped" ? "Start session" : "Restart session"}
            </button>
          ) : null}
        </div>

        {/* The controls on the right: one row of equally-weighted buttons,
            split into the session's facts and the session's actions by a thin
            rule, so the cluster reads as one group (plan step 6). */}
        <div className="ml-auto flex min-w-0 shrink items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Change model"
            title={modelLabel ?? "Choose a model"}
            onClick={() => {
              openPicker("model");
              void loadModels(active.id);
            }}
          >
            <span className="max-w-40 truncate">{modelLabel ?? "Choose model"}</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label="Change thinking level"
            title={thinkingLevel ? `Thinking: ${thinkingLevel}` : "Thinking level"}
            onClick={() => openPicker("thinking")}
          >
            {thinkingLevel ?? "thinking"}
          </Button>
          <ContextRing usage={contextUsage} cost={cost} />
          <Separator orientation="vertical" className="mx-1" />
          <ViewModeMenu value={viewMode} onChange={(mode) => setViewMode(mode)} />
          {/* A review opened from this session stays linked to it (plan step 21). */}
          {tabs
            .filter((tab) => tab.kind === "web" && tab.sessionTabId === active.id)
            .map((tab) => (
              <Button
                key={tab.id}
                size="sm"
                variant="ghost"
                aria-label={`Open review ${webTabStates[tab.id]?.title ?? tab.title}`}
                title={tab.url ?? ""}
                onClick={() => void activateTab(tab.id)}
              >
                Review: {webTabStates[tab.id]?.title ?? tab.title}
              </Button>
            ))}
          {active.status === "running" ? (
            <Button size="sm" variant="secondary" onClick={() => void stopRun(active.id)}>
              Stop
            </Button>
          ) : null}
        </div>
      </header>

      {active.error || active.status === "crashed" || active.status === "failed" ? (
        <div className="banner banner--error mx-4 mt-2 flex items-start justify-between gap-3">
          <span>
            {active.error ??
              (active.status === "crashed"
                ? "The session host crashed. History is on disk and returns after a restart."
                : "The session host was stopped after repeated failures.")}
          </span>
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

          {active.status === "running" ? (
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

          <WidgetStrip tabId={active.id} placement="aboveEditor" />
          <TuiWidgetStrip frames={tuiSurface?.widgetsAbove ?? []} placement="aboveEditor" />

          {dialog ? (
            <ExtensionDialogDock
              dialog={dialog}
              maxHeight={viewport.rows * viewport.cell.height}
              focusToken={surfaceFocusToken}
            />
          ) : tuiOwnsComposer && tuiSurface ? (
            <TuiSurface
              tabId={active.id}
              snapshot={tuiSurface}
              cell={viewport.cell}
              grid={{ rows: viewport.rows, cols: viewport.cols }}
              variant="dock"
              focusToken={surfaceFocusToken}
            />
          ) : (
            <div className="contents" inert={floatingOverlay || undefined}>
              <Composer
                tabId={active.id}
                running={active.status === "running"}
                enabled={active.status !== "crashed" && active.status !== "failed"}
                sleeping={active.status === "stopped"}
                focusToken={composerFocusToken}
                onWake={() => void ensureSession(active.id)}
                draft={drafts[active.id] ?? ""}
                queue={transcript?.queue ?? { steering: [], followUp: [] }}
                sendMode={sendModes[active.id] ?? "steer"}
                workflowStatus={extensionUi?.statuses?.workflow ?? null}
                extensionShortcuts={shortcuts.shortcuts}
                onInvokeShortcut={(key) => void invokeShortcut(key)}
                onRequestShortcuts={() => void loadShortcuts()}
                onDraftChange={(text) => setDraft(active.id, text)}
                onSend={async (text, images, options) => {
                  const mode = options?.followUp ? "followUp" : (sendModes[active.id] ?? "steer");
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
                onClearQueue={() => void clearQueue(active.id)}
                onRestoreQueue={() => void restoreQueue(active.id)}
                onSendModeChange={(mode) => setSendMode(active.id, mode)}
                onHistoryStep={(direction) => historyStep(active.id, direction)}
              />
            </div>
          )}

          <TuiWidgetStrip frames={tuiSurface?.widgetsBelow ?? []} placement="belowEditor" />
          <WidgetStrip tabId={active.id} placement="belowEditor" />

          {tuiSurface?.footer ? (
            <TuiSlotFrame
              frame={tuiSurface.footer}
              className="shrink-0 border-t border-line py-1"
            />
          ) : null}

          {/* The session footer renders *outside* the editor branch above, so the
              mode chip and extension statuses survive when an extension shows a
              non-overlay `custom` UI (`tuiOwnsComposer`) and replaces `<Composer>`. */}
          <ComposerFooter
            className="shrink-0 px-3 pb-1"
            facts={{
              cwd: active.cwd,
              branch: gitBranch,
              model: modelLabel,
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
                compaction: (activeState as { autoCompaction?: unknown })?.autoCompaction === true,
                retry: (activeState as { autoRetry?: unknown })?.autoRetry === true,
              },
              provider:
                typeof (activeState?.model as { provider?: unknown })?.provider === "string"
                  ? ((activeState?.model as { provider?: string }).provider ?? null)
                  : null,
              workflow: parseWorkflowStatus(extensionUi?.statuses?.workflow ?? null),
            }}
            statuses={extensionUi?.statuses}
          />

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
        open={picker === "model"}
        entries={modelCatalog[active.id] ?? []}
        auth={providerAuth[active.id] ?? {}}
        currentKey={currentModelKey}
        initialQuery={pickerSearch}
        scoped={scopedModels ?? EMPTY_SCOPE}
        patterns={scopedPatterns ?? EMPTY_SCOPE}
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
        open={picker === "thinking"}
        levels={levels}
        current={thinkingLevel}
        onPick={(level, options) => void setThinking(active.id, level, options)}
        onClose={closePicker}
      />
    </div>
  );
}
