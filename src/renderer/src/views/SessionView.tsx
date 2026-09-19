import { WelcomeView } from "./WelcomeView";
import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";
import type { TabStatus } from "../../../shared/session-ipc";

/**
 * Session view (plan step 3).
 *
 * The session host is live now, so this view reports what is really running —
 * status, project, session file, model and the event counter that proves the host
 * pipe works. The transcript and composer replace the body in steps 5–6.
 */

const STATUS_TONE: Record<TabStatus, "neutral" | "accent" | "ok" | "warn" | "danger"> = {
  starting: "warn",
  idle: "ok",
  running: "accent",
  crashed: "danger",
  failed: "danger",
  stopped: "neutral",
};

function snapshotFacts(state: unknown): Array<[string, string]> {
  if (!state || typeof state !== "object") return [];
  const record = state as Record<string, unknown>;
  const model = record.model;
  const modelId =
    model && typeof model === "object" && typeof (model as { id?: unknown }).id === "string"
      ? String((model as { id: string }).id)
      : null;
  const facts: Array<[string, string]> = [];
  if (modelId) facts.push(["Model", modelId]);
  if (typeof record.thinkingLevel === "string") facts.push(["Thinking", record.thinkingLevel]);
  if (typeof record.messageCount === "number") {
    facts.push(["Messages", String(record.messageCount)]);
  }
  if (typeof record.streaming === "boolean") {
    facts.push(["Streaming", record.streaming ? "yes" : "no"]);
  }
  return facts;
}

export function SessionView() {
  const project = useAppStore((state) => state.project);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const sessionStates = useAppStore((state) => state.sessionStates);
  const sessionEvents = useAppStore((state) => state.sessionEvents);
  const activateTab = useAppStore((state) => state.activateTab);
  const info = useAppStore((state) => state.info);

  const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
  if (!active) return <WelcomeView />;

  const events = sessionEvents[active.id] ?? { count: 0, last: null };
  const facts: Array<[string, string]> = [
    ["Project", active.cwd],
    ["Session file", active.sessionFile ?? "not created yet"],
    ...snapshotFacts(sessionStates[active.id]),
  ];

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-5 overflow-y-auto px-8 py-6">
      <header className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{active.title}</h1>
        <Badge tone={STATUS_TONE[active.status]}>{active.status}</Badge>
        {active.status === "stopped" ||
        active.status === "crashed" ||
        active.status === "failed" ? (
          <button
            type="button"
            className="text-xs text-accent underline"
            onClick={() => void activateTab(active.id)}
          >
            {active.status === "stopped" ? "Start session" : "Restart session"}
          </button>
        ) : null}
      </header>

      {active.error ? <div className="banner banner--error">{active.error}</div> : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-ink-faint">{label}</dt>
            <dd className="truncate" title={value}>
              {value}
            </dd>
          </div>
        ))}
        <dt className="text-ink-faint">Host events</dt>
        <dd>
          {events.count} received{events.last ? ` · last: ${events.last}` : ""}
        </dd>
      </dl>

      <p className="text-sm text-ink-muted">
        This session runs in its own Pi host process with the shared profile. The transcript and the
        prompt composer arrive with steps 5–6; until then the host is verified here by its state and
        event stream rather than by a chat box that cannot work yet.
      </p>

      {info?.runtimeProblems.length ? (
        <p className="text-xs text-warn">{info.runtimeProblems.join(" · ")}</p>
      ) : null}

      {tabs.length > 1 ? (
        <p className="text-xs text-ink-faint">
          {tabs.length} open sessions. Use Ctrl+Tab, or the sidebar strip, to switch.
        </p>
      ) : null}

      {project && project.path !== active.cwd ? (
        <p className="text-xs text-ink-faint">
          This tab runs in {active.cwd}, not the project selected in the sidebar ({project.path}).
        </p>
      ) : null}
    </div>
  );
}
