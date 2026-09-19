import { useEffect } from "react";
import { Composer } from "../session/Composer";
import { Transcript } from "../session/Transcript";
import { Badge } from "../ui/badge";
import { WelcomeView } from "./WelcomeView";
import { useAppStore } from "../state/app-store";
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

/** "42% ctx · 12.3k tokens · $0.04" from the host's state snapshot. */
export function usageLine(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const record = state as Record<string, unknown>;
  const parts: string[] = [];
  const usage = record.contextUsage;
  if (usage && typeof usage === "object") {
    const percent = (usage as { percent?: unknown }).percent;
    if (typeof percent === "number") parts.push(`${Math.round(percent * 100)}% ctx`);
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
  const hydrateTranscript = useAppStore((state) => state.hydrateTranscript);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const stopRun = useAppStore((state) => state.stopRun);
  const clearQueue = useAppStore((state) => state.clearQueue);
  const setDraft = useAppStore((state) => state.setDraft);
  const setSendMode = useAppStore((state) => state.setSendMode);
  const historyStep = useAppStore((state) => state.historyStep);
  const drafts = useAppStore((state) => state.prefs.drafts);
  const sendModes = useAppStore((state) => state.sendModes);

  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeId = active?.id ?? null;

  // Hooks run before the early return: `messages.get` seeds the transcript of the
  // tab being shown (once per tab; live batches append after that).
  useEffect(() => {
    if (activeId) void hydrateTranscript(activeId);
  }, [activeId, hydrateTranscript]);

  if (!active) return <WelcomeView />;

  const transcript = transcripts[active.id];
  const usage = usageLine(sessionStates[active.id]);
  const needsRestart =
    active.status === "stopped" || active.status === "crashed" || active.status === "failed";

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <h1 className="truncate text-sm font-semibold">{active.title}</h1>
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
        <span className="ml-auto truncate text-[11px] text-ink-faint" title={active.cwd}>
          {usage ? `${usage} · ` : ""}
          {active.model ?? ""}
        </span>
      </header>

      {active.error ? <div className="banner banner--error mx-4 mt-2">{active.error}</div> : null}

      <div className="min-h-0 flex-1">
        <Transcript
          items={transcript?.items ?? []}
          running={active.status === "running"}
          onAbort={() => void stopRun(active.id)}
          empty={{ cwd: active.cwd, project: project?.path ?? null, model: active.model }}
        />
      </div>

      <Composer
        tabId={active.id}
        running={active.status === "running"}
        enabled={active.status === "running" || active.status === "idle"}
        draft={drafts[active.id] ?? ""}
        queue={transcript?.queue ?? { steering: [], followUp: [] }}
        sendMode={sendModes[active.id] ?? "steer"}
        contextLabel={usage}
        onDraftChange={(text) => setDraft(active.id, text)}
        onSend={async (text, images) => {
          const mode = sendModes[active.id] ?? "steer";
          return sendPrompt(active.id, text, {
            ...(active.status === "running" ? { mode } : {}),
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
        onStop={() => void stopRun(active.id)}
        onClearQueue={() => void clearQueue(active.id)}
        onSendModeChange={(mode) => setSendMode(active.id, mode)}
        onHistoryStep={(direction) => historyStep(active.id, direction)}
      />
    </div>
  );
}
