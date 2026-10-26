import { useAppStore, type SessionInfoView } from "../state/app-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { formatTokens } from "../session/model-catalog";

/**
 * `/session` (2026-10-26 session-parity plan step 12).
 *
 * Terminal Pi prints the session file, id, model, token totals (including cache
 * reads/writes) and cost (`interactive-mode.js:5560-5632`). The desktop's footer
 * only carries the context budget, so this dialog is the complete answer to
 * "where is this session and what has it cost?".
 */

function row(label: string, value: string | null | undefined, title?: string) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-0.5" key={label}>
      <span className="text-ink-faint">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs" title={title ?? value ?? undefined}>
        {value && value.length > 0 ? value : "—"}
      </span>
    </div>
  );
}

function tokenRows(data: SessionInfoView) {
  const tokens = data.tokens;
  if (!tokens) return [row("Tokens", "not reported yet")];
  return [
    row("Input", formatTokens(tokens.input)),
    row("Output", formatTokens(tokens.output)),
    row("Cache read", formatTokens(tokens.cacheRead)),
    row("Cache write", formatTokens(tokens.cacheWrite)),
    row("Total", formatTokens(tokens.total)),
    row("Cost", tokens.cost > 0 ? `$${tokens.cost.toFixed(4)}` : "$0.0000"),
  ];
}

export function SessionInfoDialog() {
  const open = useAppStore((state) => state.sessionInfoOpen);
  const data = useAppStore((state) => state.sessionInfoData);
  const error = useAppStore((state) => state.sessionInfoError);
  const close = useAppStore((state) => state.closeSessionInfo);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent aria-describedby={undefined} data-testid="session-info">
        <DialogTitle>Session</DialogTitle>
        <DialogDescription>
          File, model and usage for this session. Figures come from the live Pi session.
        </DialogDescription>
        <div className="px-4 pb-4 text-xs">
          {error ? (
            <p className="text-danger" role="alert">
              {error}
            </p>
          ) : data ? (
            <div className="space-y-3">
              <section>
                {row("Name", data.sessionName)}
                {row("File", data.sessionFile, data.sessionFile ?? undefined)}
                {row("Session id", data.sessionId)}
                {row("Working dir", data.cwd, data.cwd)}
              </section>
              <section>
                {row(
                  "Model",
                  data.model
                    ? `${data.model.provider ?? "unknown"}/${data.model.id ?? "unknown"}`
                    : null,
                )}
                {row("Thinking", data.thinkingLevel)}
                {row(
                  "Context",
                  data.contextUsage
                    ? `${data.contextUsage.percent === null ? "?" : Math.round(data.contextUsage.percent)}% of ${formatTokens(data.contextUsage.contextWindow)}${data.contextUsage.tokens === null ? "" : ` · ${formatTokens(data.contextUsage.tokens)} tokens`}`
                    : null,
                )}
              </section>
              <section>{tokenRows(data)}</section>
              <section>
                {row("Messages", String(data.messageCount))}
                {row("Tools", String(data.toolCount))}
                {row("Pending messages", String(data.pendingMessages))}
                {row("Status", data.streaming ? "running" : "ready")}
                {row("Steering mode", data.steeringMode)}
                {row("Follow-up mode", data.followUpMode)}
                {row("Auto-compaction", data.autoCompaction ? "on" : "off")}
                {row("Auto-retry", data.autoRetry ? "on" : "off")}
              </section>
            </div>
          ) : (
            <p className="text-ink-faint">Loading session stats…</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
