import type { ReactNode } from "react";

import { AnsiLine } from "../tui/AnsiBlock";
import { visibleWidth } from "../../../shared/ansi";
import { statusLineText } from "../../../shared/ansi";
import type { ContributionView } from "../../../shared/extension-contributions-view";
import { cn } from "../ui/cn";
import { contributionTextClass } from "./contribution-tone";
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
 *  - contribution rows (`statusRows` + `progressRows` from the contribution
 *    model) in model order, tone-aware and after the statuses;
 *  - single-line extension widgets (composed by the view);
 *  - `claude-sonnet-4 • high` at the right edge.
 *
 * Long items wrap inside a bounded rail and keep their full value in `title`. A
 * status may grow the rail up to its cap instead of pushing the model off the
 * row; anything past the cap scrolls. The footer renders as a **sibling of the
 * composer**, so it survives an extension `ctx.ui.custom()` editor.
 *
 * Custom-footer fallback: an extension `ctx.ui.setFooter()` replaces the whole
 * built-in footer, so `contributionRows` are deliberately NOT injected into a
 * publisher's custom footer. The rows live only in this component; a publisher
 * that replaces the footer owns its own status/progress presentation.
 *
 * There is deliberately no mode chip: the workflow mode is named inside the
 * composer, and the raw `workflow` status still appears in the status column.
 */

export interface SessionFooterProps {
  facts: FooterFacts;
  /** `extensionUi[tabId].statuses`, keyed by extension. */
  statuses?: Record<string, string>;
  /**
   * `statusRows` and `progressRows` from the contribution model, in the order
   * they should render. Wired live in plan step 6; step 4 owns the rail
   * rendering.
   */
  contributionRows?: ContributionView[];
  /** `info.homeDir`, used to show `~` instead of the user's home prefix. */
  homeDir?: string | null;
  /** Single-line below-editor widgets; multi-line widgets stay in their strip. */
  widgets?: ReactNode;
  className?: string;
}

export function SessionFooter({
  facts,
  statuses,
  contributionRows,
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
  const rows = contributionRows ?? [];
  if (
    !pwd &&
    !stats &&
    !context &&
    !model &&
    entries.length === 0 &&
    rows.length === 0 &&
    !widgets
  ) {
    return null;
  }

  return (
    <div
      data-testid="session-footer"
      className={cn(
        "mt-1 flex min-h-10 max-h-24 min-w-0 flex-wrap items-start gap-x-3 gap-y-0.5 overflow-y-auto overflow-x-hidden pr-1 text-[11px] text-ink-faint",
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
              className="min-w-0 max-w-[72ch] whitespace-pre-wrap break-words"
              title={`Extension status: ${key}\n${statusLineText(text)}`}
            >
              <AnsiLine line={text} width={visibleWidth(text)} wrap />
            </span>
          ))}
        </div>
      ) : null}

      {rows.map((row) => (
        <span
          key={`${row.ownerId}:${row.id}`}
          data-testid={`contribution-row-${row.ownerId}:${row.id}`}
          data-kind={row.kind}
          className={cn("min-w-0 max-w-[72ch] break-words", contributionTextClass(row.tone))}
          title={row.detail ?? row.text}
        >
          {row.text}
          {row.kind === "progress" ? (
            <span className="ml-1 text-ink-faint">
              {row.done !== undefined && row.total !== undefined
                ? `${row.done}/${row.total}`
                : null}
              {row.stale ? " ⚠" : null}
            </span>
          ) : null}
        </span>
      ))}

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
