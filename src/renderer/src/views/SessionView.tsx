import { useEffect, useMemo, useState } from "react";
import { Composer } from "../session/Composer";
import { Transcript } from "../session/Transcript";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WelcomeView } from "./WelcomeView";
import { useAppStore } from "../state/app-store";
import { WidgetStrip } from "../extension-ui/WidgetStrip";
import { DocumentsPanel } from "../office/DocumentsPanel";
import { WorkingRow } from "../extension-ui/WorkingRow";
import { TuiSlotFrame, TuiSurface } from "../tui/TuiSurface";
import { WebTabView } from "../web/WebTabView";
import { createCommandProvider } from "../completion/command-source";
import { createDocumentProvider } from "../completion/document-source";
import { createFileProvider } from "../completion/file-source";
import { toDocumentMentions } from "../../../shared/office-documents";
import { createCompletionProvider } from "../completion/stack";
import type { CompletionItem, CompletionSuggestions } from "../completion/types";
import { ContextRing } from "../session/ContextRing";
import { ModelPicker } from "../session/ModelPicker";
import { ThinkingPicker } from "../session/ThinkingPicker";
import { contextUsageOf, modelKeyOf, thinkingLevelsOf } from "../session/model-catalog";
import type { ViewMode } from "../../../shared/prefs";
import type { TabStatus } from "../../../shared/session-ipc";

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

/**
 * The `#` completion source (plan step 20). It reads the live pane registry from
 * the store on every keystroke, so a document attached or detached mid-session is
 * reflected without rebuilding the completion stack — and it works even when the
 * bridge extension's own provider is absent.
 */
const documentMentionSource = {
  list: () => toDocumentMentions(useAppStore.getState().officeDocuments?.panes ?? []),
};

/** "42% ctx · 12.3k tokens · $0.04" from the host's state snapshot. */
export function usageLine(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  const parts: string[] = [];
  const usage = record.contextUsage;
  if (usage && typeof usage === "object") {
    // Pi reports context usage as 0-100 (`(tokens / contextWindow) * 100`), so
    // this is a percentage already — scaling it again claimed "4200% ctx".
    const percent = (usage as { percent?: unknown }).percent;
    if (typeof percent === "number") parts.push(`${Math.round(percent)}% ctx`);
  }
  const tokens = record.tokens;
  if (tokens && typeof tokens === "object") {
    const total = (tokens as { total?: unknown }).total;
    const cost = (tokens as { cost?: unknown }).cost;
    if (typeof total === "number" && total > 0) {
      parts.push(`${total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total} tokens`);
    }
    if (typeof cost === "number" && cost > 0) parts.push(`$${cost.toFixed(4)}`);
  }
  const count = record.messageCount;
  if (typeof count === "number" && count > 0) parts.push(`${count} messages`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function SessionView() {
  const project = useAppStore((state) => state.project);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const sessionStates = useAppStore((state) => state.sessionStates);
  const transcripts = useAppStore((state) => state.transcripts);
  const activateTab = useAppStore((state) => state.activateTab);
  const restartTab = useAppStore((state) => state.restartTab);
  const hydrateTranscript = useAppStore((state) => state.hydrateTranscript);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const stopRun = useAppStore((state) => state.stopRun);
  const clearQueue = useAppStore((state) => state.clearQueue);
  const setDraft = useAppStore((state) => state.setDraft);
  const setSendMode = useAppStore((state) => state.setSendMode);
  const historyStep = useAppStore((state) => state.historyStep);
  const drafts = useAppStore((state) => state.prefs.drafts);
  const sendModes = useAppStore((state) => state.sendModes);
  const loadCommands = useAppStore((state) => state.loadCommands);
  const loadFiles = useAppStore((state) => state.loadFiles);
  const modelCatalog = useAppStore((state) => state.modelCatalog);
  const providerAuth = useAppStore((state) => state.providerAuth);
  const thinkingLevels = useAppStore((state) => state.thinkingLevels);
  const picker = useAppStore((state) => state.picker);
  const loadModels = useAppStore((state) => state.loadModels);
  const setModel = useAppStore((state) => state.setModel);
  const setThinking = useAppStore((state) => state.setThinking);
  const toggleFavorite = useAppStore((state) => state.toggleFavorite);
  const renameSession = useAppStore((state) => state.renameSession);
  const setViewMode = useAppStore((state) => state.setViewMode);
  const openPicker = useAppStore((state) => state.openPicker);
  const closePicker = useAppStore((state) => state.closePicker);
  const setView = useAppStore((state) => state.setView);
  const setHint = useAppStore((state) => state.setHint);
  const favorites = useAppStore((state) => state.prefs.favoriteModels);
  const viewMode = useAppStore((state) => state.prefs.viewMode);
  const extensionUi = useAppStore((state) =>
    activeTabId ? state.extensionUi[activeTabId] : undefined,
  );
  const toolsExpandedState = useAppStore((state) =>
    activeTabId ? state.toolsExpanded[activeTabId] : undefined,
  );
  const toggleToolsExpanded = useAppStore((state) => state.toggleToolsExpanded);
  const extensionCompletion = useAppStore((state) => state.extensionCompletion);
  const extensionApplyCompletion = useAppStore((state) => state.extensionApplyCompletion);
  const tuiSurface = useAppStore((state) =>
    activeTabId ? state.tuiSurfaces[activeTabId] : undefined,
  );
  const officeDocuments = useAppStore((state) => state.officeDocuments);
  const toggleDocumentsPanel = useAppStore((state) => state.toggleDocumentsPanel);
  const webTabStates = useAppStore((state) => state.webTabStates);
  const [editingName, setEditingName] = useState(false);

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
        command: createCommandProvider({ loadCommands: () => loadCommands(activeTabId ?? "") }),
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
        // Only host-run extension items need the remote apply; the built-in
        // sources are applied locally by the provider itself.
        if (!activeTabId || item.source !== "extension") return null;
        return extensionApplyCompletion(activeTabId, {
          lines: buffer.lines,
          cursorLine: buffer.line,
          cursorCol: buffer.col,
          item: {
            value: item.value,
            label: item.label,
            ...(item.description === undefined ? {} : { description: item.description }),
          },
          prefix: suggestions.prefix,
        });
      },
    }),
    [activeTabId, loadCommands, loadFiles, extensionCompletion, extensionApplyCompletion],
  );

  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeId = active?.id ?? null;

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

  if (!active) return <WelcomeView />;
  if (active.kind === "web") return <WebTabView tab={active} />;

  const transcript = transcripts[active.id];
  const usage = usageLine(sessionStates[active.id]);
  const contextUsage = contextUsageOf(sessionStates[active.id]);
  const levels = thinkingLevels[active.id] ?? thinkingLevelsOf(sessionStates[active.id]);
  const activeState = sessionStates[active.id] as
    { model?: unknown; thinkingLevel?: unknown; tokens?: { cost?: unknown } } | undefined;
  const cost = typeof activeState?.tokens?.cost === "number" ? activeState.tokens.cost : null;
  const thinkingLevel =
    typeof activeState?.thinkingLevel === "string" ? activeState.thinkingLevel : null;
  const currentModelKey = modelKeyOf(activeState?.model);
  const needsRestart =
    active.status === "stopped" || active.status === "crashed" || active.status === "failed";
  // A non-overlay `custom`/`editor` component owns the composer region; an
  // overlay floats over the whole view (plan step 17).
  const tuiOwnsEditor = Boolean(
    tuiSurface && (tuiSurface.editor || (tuiSurface.custom && !tuiSurface.overlay)),
  );

  // The view mode is a semantic override (plan step 18): Verbose expands every
  // tool card, Summary collapses them, Normal uses the Ctrl+O state (or each
  // card's own default while the user has not toggled anything).
  const effectiveToolsExpanded =
    viewMode === "verbose" ? true : viewMode === "summary" ? false : (toolsExpandedState ?? null);

  return (
    <div className="relative flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
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
            className="truncate text-sm font-semibold"
            title="Double-click to rename"
            onDoubleClick={() => setEditingName(true)}
          >
            {active.title}
          </h1>
        )}
        <Badge tone={STATUS_TONE[active.status]}>{active.status}</Badge>
        {needsRestart ? (
          <button
            type="button"
            className="text-xs text-accent underline"
            onClick={() => void activateTab(active.id)}
          >
            {active.status === "stopped" ? "Start session" : "Restart session"}
          </button>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-label="Change model"
            title={active.model ?? "Choose a model"}
            onClick={() => {
              openPicker("model");
              void loadModels(active.id);
            }}
          >
            <span className="max-w-40 truncate">{active.model ?? "Choose model"}</span>
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
          <select
            aria-label="View mode"
            value={viewMode}
            onChange={(event) => setViewMode(event.target.value as ViewMode)}
            className="rounded-sm border border-line bg-raised px-1 py-0.5 text-[11px] text-ink-faint"
          >
            <option value="normal">Normal</option>
            <option value="verbose">Verbose</option>
            <option value="summary">Summary</option>
          </select>
          {officeDocuments?.available ? (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Documents"
              title="Attached Office documents"
              onClick={toggleDocumentsPanel}
            >
              Documents
              {officeDocuments.panes.length > 0 ? ` (${officeDocuments.panes.length})` : ""}
            </Button>
          ) : null}
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Transcript
              items={transcript?.items ?? []}
              tabId={active.id}
              running={active.status === "running"}
              onAbort={() => void stopRun(active.id)}
              empty={{ cwd: active.cwd, project: project?.path ?? null, model: active.model }}
              thinkingLabel={extensionUi?.hiddenThinkingLabel ?? null}
              toolsExpanded={effectiveToolsExpanded}
              onToggleToolsExpanded={() => toggleToolsExpanded(active.id)}
            />
          </div>

          {active.status === "running" && extensionUi ? (
            <WorkingRow working={extensionUi.working} />
          ) : null}
          {tuiSurface?.header ? (
            <TuiSlotFrame
              frame={tuiSurface.header}
              className="shrink-0 border-t border-line px-3 py-1"
            />
          ) : null}

          {tuiOwnsEditor && tuiSurface ? (
            <TuiSurface tabId={active.id} snapshot={tuiSurface} />
          ) : (
            <>
              <WidgetStrip tabId={active.id} placement="aboveEditor" />

              <Composer
                tabId={active.id}
                running={active.status === "running"}
                enabled={active.status === "running" || active.status === "idle"}
                draft={drafts[active.id] ?? ""}
                queue={transcript?.queue ?? { steering: [], followUp: [] }}
                sendMode={sendModes[active.id] ?? "steer"}
                contextLabel={usage}
                onDraftChange={(text) => setDraft(active.id, text)}
                onSend={async (text, images, options) => {
                  const mode = sendModes[active.id] ?? "steer";
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
                onSendModeChange={(mode) => setSendMode(active.id, mode)}
                onHistoryStep={(direction) => historyStep(active.id, direction)}
              />

              <WidgetStrip tabId={active.id} placement="belowEditor" />
            </>
          )}

          {tuiSurface?.footer ? (
            <TuiSlotFrame
              frame={tuiSurface.footer}
              className="shrink-0 border-t border-line px-3 py-1"
            />
          ) : null}
        </div>
        <DocumentsPanel />
      </div>
      {tuiSurface?.overlay && tuiSurface.custom ? (
        <TuiSurface tabId={active.id} snapshot={tuiSurface} />
      ) : null}

      <ModelPicker
        open={picker === "model"}
        entries={modelCatalog[active.id] ?? []}
        auth={providerAuth[active.id] ?? {}}
        currentKey={currentModelKey}
        favorites={favorites}
        onPick={(entry, options) => void setModel(active.id, entry, options)}
        onToggleFavorite={toggleFavorite}
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
