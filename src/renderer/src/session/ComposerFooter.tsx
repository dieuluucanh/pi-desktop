import { AnsiLine } from "../tui/AnsiBlock";
import { visibleWidth } from "../../../shared/ansi";
import {
  statusLineText,
  workflowModeLabel,
  type WorkflowModeView,
} from "../../../shared/workflow-mode";
import { contextRingLabel } from "./ContextRing";
import { formatTokens, type ContextUsageView } from "./model-catalog";

/**
 * The composer footer (2026-10-19 UI rework).
 *
 * Terminal Pi binds its session facts to the editor rather than to a global
 * window footer (`dist/modes/interactive/components/footer.js`): the working
 * directory, the model and the context budget sit under the input, because that
 * is where they are read while typing. The app follows the same split — the
 * global status bar keeps app-level facts, and everything session-scoped lives
 * here.
 *
 * Two rows, both optional:
 *
 *  1. `cwd (branch) · model · thinking` on the left and the context budget on the
 *     right. Long values truncate; each carries the full value in its `title`.
 *  2. The extension statuses (`ctx.ui.setStatus`) as one dim line. They are
 *     third-party strings and arrive with ANSI colour (the workflow extension
 *     wraps its label in `theme.fg`), so they render through `AnsiLine` and are
 *     sanitised for the `title`/copy path.
 */

export interface ComposerFooterFacts {
  /** Session working directory; the visible label is compacted, `title` is not. */
  cwd?: string | null;
  /** Current git branch of the project, when it is a repository. */
  branch?: string | null;
  /** Model id from the session snapshot. */
  model?: string | null;
  /** Thinking level from the session snapshot. */
  thinking?: string | null;
  /** Context usage as `contextUsageOf` reports it. */
  context?: ContextUsageView | null;
  /** Session cost total, from `session.stats`. */
  cost?: number | null;
  /** Per-direction token usage, from the session snapshot (`plan step 12`). */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
  /** Auto-compaction / auto-retry markers (`plan step 12`). */
  auto?: { compaction: boolean; retry: boolean } | null;
  /** Provider (or a virtual-model route) behind the selected model. */
  provider?: string | null;
  /**
   * The decoded workflow mode (2026-10-19). Rendered as a labelled chip so the
   * active mode is readable as text in every mode, including `Default`, and
   * survives an extension-owned editor (the footer renders outside `<Composer>`).
   */
  workflow?: WorkflowModeView | null;
}

export interface ComposerFooterProps {
  facts: ComposerFooterFacts;
  /** `extensionUi[tabId].statuses`, keyed by extension. */
  statuses?: Record<string, string>;
  className?: string;
}

/** Longest visible path label before it is compacted to its last segments. */
const MAX_PATH_CHARS = 44;

/**
 * Short visible form of a path: the full value is unreadable in a footer row, so
 * a long path keeps only its last two segments with a `…` marker. The caller
 * keeps the exact value in `title`.
 */
export function compactPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (trimmed.length === 0) return path;
  if (trimmed.length <= MAX_PATH_CHARS) return trimmed;
  const separator = trimmed.includes("\\") ? "\\" : "/";
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0);
  const last = parts[parts.length - 1] ?? trimmed;
  const parent = parts[parts.length - 2];
  if (!parent) return last;
  return `…${separator}${parent}${separator}${last}`;
}

/**
 * The footer's tooltip detail (plan step 12): per-direction tokens are too
 * noisy for the row but exactly what `/session`'s terminal counterpart prints.
 */
export function usageDetailText(facts: ComposerFooterFacts): string | null {
  const parts: string[] = [];
  const usage = facts.usage;
  if (usage) {
    parts.push(
      `in ${formatTokens(usage.input)} · out ${formatTokens(usage.output)} · cache r ${formatTokens(usage.cacheRead)} / w ${formatTokens(usage.cacheWrite)}`,
    );
  }
  if (facts.provider) parts.push(`provider ${facts.provider}`);
  if (facts.auto) {
    const on = [
      facts.auto.compaction ? "auto-compaction" : null,
      facts.auto.retry ? "auto-retry" : null,
    ].filter((value): value is string => value !== null);
    if (on.length > 0) parts.push(on.join(" · "));
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** `42% of 200k · 12.3k tokens · $0.0400` — the compact right-hand side. */
export function contextFooterText(
  usage: ContextUsageView | null | undefined,
  cost: number | null | undefined,
): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.percent !== null) {
    parts.push(`${Math.round(usage.percent)}% of ${formatTokens(usage.contextWindow)}`);
  } else if (usage.contextWindow !== null) {
    parts.push(`? of ${formatTokens(usage.contextWindow)}`);
  }
  if (usage.tokens !== null) parts.push(`${formatTokens(usage.tokens)} tokens`);
  if (typeof cost === "number" && cost > 0) parts.push(`$${cost.toFixed(4)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The left-hand script: `cwd (branch) · model · thinking`.
 *
 * Thinking is shown as a bare level (`medium`) rather than prose because the
 * composer border already encodes it as a colour, exactly like Pi.
 */
export function sessionFactsText(facts: ComposerFooterFacts): string | null {
  const parts: string[] = [];
  if (facts.cwd) {
    const path = compactPath(facts.cwd);
    parts.push(facts.branch ? `${path} (${facts.branch})` : path);
  }
  if (facts.model) parts.push(facts.model);
  if (facts.thinking) parts.push(`thinking ${facts.thinking}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The labelled mode chip text, or null when the status is absent/unrecognised.
 *
 * This is the footer's textual mode indicator: it names every known mode
 * (including `Default`) so the active mode never depends on colour alone.
 */
function modeChipText(facts: ComposerFooterFacts): string | null {
  const label = workflowModeLabel(facts.workflow ?? null);
  return label ? `mode: ${label}` : null;
}

export function ComposerFooter({ facts, statuses, className }: ComposerFooterProps) {
  const factsText = sessionFactsText(facts);
  const contextText = contextFooterText(facts.context, facts.cost);
  const modeText = modeChipText(facts);
  const detail = usageDetailText(facts);
  const contextTitle = [contextRingLabel(facts.context ?? null, facts.cost), detail]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const entries = Object.entries(statuses ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (!factsText && !contextText && !modeText && entries.length === 0) return null;

  return (
    <div
      data-testid="composer-footer"
      className={`mt-1 flex flex-col gap-0.5 text-[11px] text-ink-faint ${className ?? ""}`}
    >
      {modeText ? (
        <div className="flex items-center gap-2">
          <span
            data-testid="composer-mode"
            // `status`/`aria-live` so a Tab cycle is announced, not just seen.
            role="status"
            aria-live="polite"
            className="shrink-0 rounded-xs border border-line bg-raised px-1.5 font-medium text-ink-muted"
          >
            {modeText}
          </span>
        </div>
      ) : null}

      {factsText || contextText ? (
        <div className="flex items-center gap-3">
          {factsText ? (
            <span className="min-w-0 truncate" title={facts.cwd ?? factsText}>
              {factsText}
            </span>
          ) : null}
          {contextText ? (
            <span className="ml-auto flex shrink-0 items-center gap-1.5" title={contextTitle}>
              {facts.auto?.compaction || facts.auto?.retry ? (
                <span
                  data-testid="composer-auto-marker"
                  className="rounded-xs border border-line px-1 text-ink-faint"
                  title={detail ?? undefined}
                >
                  auto
                </span>
              ) : null}
              <span>{contextText}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {entries.length > 0 ? (
        <div
          data-testid="composer-footer-statuses"
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5"
        >
          {entries.map(([key, text]) => (
            <span
              key={key}
              data-testid={`extension-status-${key}`}
              className="min-w-0 max-w-full truncate"
              title={`Extension status: ${key}\n${statusLineText(text)}`}
            >
              <AnsiLine line={text} width={visibleWidth(text)} />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
