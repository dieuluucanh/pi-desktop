import type { ReactNode } from "react";

import { AnsiLine } from "../tui/AnsiBlock";
import { visibleWidth } from "../../../shared/ansi";
import { statusLineText } from "../../../shared/workflow-mode";
import { cn } from "../ui/cn";
import {
  contextTone,
  contextUsageText,
  footerDetailText,
  modelLineText,
  pwdLineText,
  usageStatsText,
  type FooterFacts,
} from "./footer-text";

/**
 * The session footer (minimal-session-ui step 6, compact rail 2026-10-31).
 *
 * One responsive row instead of Pi's three fixed rows. Each item is a column
 * that wraps only when the window is narrow:
 *
 *  - `~/work/app (dev)` — working directory and git branch;
 *  - `↑12.3k ↓4.6k R1.0k $0.043 · 42%/200.0k (auto)` — tokens, cost, context;
 *  - `ctx.ui.setStatus` values, sorted by key and rendered ANSI-aware
 *    (pi-lens, workflow, Office);
 *  - single-line extension widgets (composed by the view);
 *  - `claude-sonnet-4 • high` at the right edge.
 *
 * Long items truncate and keep their full value in `title`, so a long status
 * cannot push the model off the row. The footer renders as a **sibling of the
 * composer**, so it survives an extension `ctx.ui.custom()` editor; an
 * extension `ctx.ui.setFooter()` replaces the whole component.
 *
 * There is deliberately no mode chip: the workflow mode is named inside the
 * composer, and the raw `workflow` status still appears in the status column.
 */

export interface SessionFooterProps {
  facts: FooterFacts;
  /** `extensionUi[tabId].statuses`, keyed by extension. */
  statuses?: Record<string, string>;
  /** `info.homeDir`, used to show `~` instead of the user's home prefix. */
  homeDir?: string | null;
  /** Single-line below-editor widgets; multi-line widgets stay in their strip. */
  widgets?: ReactNode;
  className?: string;
}

export function SessionFooter({
  facts,
  statuses,
  homeDir,
  widgets,
  className,
}: SessionFooterProps) {
  const pwd = pwdLineText(facts, homeDir);
  const stats = usageStatsText(facts);
  const context = contextUsageText(facts.context ?? null, facts.auto?.compaction === true);
  const tone = contextTone(facts.context ?? null);
  const model = modelLineText(facts.modelId ?? null, facts.thinking ?? null);
  const detail = footerDetailText(facts);
  const entries = Object.entries(statuses ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!pwd && !stats && !context && !model && entries.length === 0 && !widgets) return null;

  return (
    <div
      data-testid="session-footer"
      className={cn(
        "mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-ink-faint",
        className,
      )}
    >
      {pwd ? (
        <div
          data-testid="session-footer-pwd"
          className="min-w-0 max-w-[40ch] truncate"
          title={facts.cwd ?? pwd}
        >
          {pwd}
        </div>
      ) : null}

      {stats || context ? (
        <div className="flex shrink-0 items-center gap-2" title={detail ?? undefined}>
          {stats ? <span className="shrink-0">{stats}</span> : null}
          {context ? (
            <span data-testid="session-footer-context" className={cn("shrink-0", tone)}>
              {context}
            </span>
          ) : null}
        </div>
      ) : null}

      {entries.length > 0 ? (
        <div
          data-testid="session-footer-statuses"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5"
        >
          {entries.map(([key, text]) => (
            <span
              key={key}
              data-testid={`extension-status-${key}`}
              className="min-w-0 max-w-[48ch] truncate"
              title={`Extension status: ${key}\n${statusLineText(text)}`}
            >
              <AnsiLine line={text} width={visibleWidth(text)} />
            </span>
          ))}
        </div>
      ) : null}

      {widgets}

      {model ? (
        <div
          data-testid="session-footer-model"
          className="ml-auto min-w-0 max-w-[40ch] truncate"
          title={facts.model ?? model}
        >
          {model}
        </div>
      ) : null}
    </div>
  );
}
