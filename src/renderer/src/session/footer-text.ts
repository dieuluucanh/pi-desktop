/**
 * The session footer's text (minimal-session-ui step 6).
 *
 * Terminal Pi binds its session facts to the editor: a `pwd (branch)` line, a
 * token/cost/context stats line with the model on the right, then the extension
 * statuses. The renderer keeps the same shape, but computes it from the session
 * snapshot it already has rather than from a second host round trip.
 *
 * Pure functions only (no React) so the exact strings are unit-tested; the
 * component (`SessionFooter`) just lays them out.
 */

import { compactPath, tildePath } from "../../../shared/paths";
import { formatTokens, type ContextUsageView } from "./model-catalog";

/** Per-direction totals from the host's `session.stats`. */
export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Everything the footer may display; each field is optional. */
export interface FooterFacts {
  /** Session working directory; shown with `~` for home and compacted if long. */
  cwd?: string | null;
  /** Current git branch of the project, when it is a repository. */
  branch?: string | null;
  /** Full `provider/id`, used in the tooltip and the model picker. */
  model?: string | null;
  /** Short model id shown on the right side of the stats line. */
  modelId?: string | null;
  /** Thinking level from the session snapshot. */
  thinking?: string | null;
  /** Context usage as `contextUsageOf` reports it. */
  context?: ContextUsageView | null;
  /** Session cost total. */
  cost?: number | null;
  /** Per-direction token usage from the session snapshot. */
  usage?: FooterUsage | null;
  /** Auto-compaction / auto-retry markers. */
  auto?: { compaction: boolean; retry: boolean } | null;
  /** Provider behind the selected model, for the tooltip. */
  provider?: string | null;
}

/**
 * `~/work/app (dev)` — the Pi footer's first line.
 *
 * `homeDir` is the app's `info.homeDir`; without it the path is shown as-is.
 */
export function pwdLineText(facts: FooterFacts, homeDir?: string | null): string | null {
  if (!facts.cwd) return null;
  const path = compactPath(tildePath(facts.cwd, homeDir));
  return facts.branch ? `${path} (${facts.branch})` : path;
}

/**
 * `↑12.3k ↓4.6k R1.0k W20 $0.043` — only the parts that exist.
 *
 * The glyphs match Pi's footer (input, output, cache read, cache write, cost).
 * Cost keeps three decimals, the terminal's precision.
 */
export function usageStatsText(facts: FooterFacts): string | null {
  const parts: string[] = [];
  const usage = facts.usage;
  if (usage) {
    if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
    if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
    if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
    if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  }
  if (typeof facts.cost === "number" && facts.cost > 0) parts.push(`$${facts.cost.toFixed(3)}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * `42%/200.0k (auto)` — the context budget, or `?/200.0k` right after a
 * compaction (tokens unknown until the next response).
 */
export function contextUsageText(
  usage: ContextUsageView | null | undefined,
  autoCompaction = false,
): string | null {
  if (!usage) return null;
  const window = usage.contextWindow !== null ? formatTokens(usage.contextWindow) : null;
  if (window === null && usage.percent === null) return null;
  const percent = usage.percent !== null ? `${Math.round(usage.percent)}%` : "?";
  const text = window !== null ? `${percent}/${window}` : percent;
  return autoCompaction ? `${text} (auto)` : text;
}

/** The Pi threshold colours for the context chunk (warn > 70 %, error > 90 %). */
export function contextTone(usage: ContextUsageView | null | undefined): string | null {
  if (!usage || usage.percent === null) return null;
  if (usage.percent >= 90) return "text-danger";
  if (usage.percent >= 70) return "text-warn";
  return null;
}

/** `claude-sonnet-4 • high` — the right side of the stats line. */
export function modelLineText(
  modelId: string | null | undefined,
  thinking: string | null | undefined,
): string | null {
  if (!modelId) return thinking ? `thinking ${thinking}` : null;
  return thinking ? `${modelId} • ${thinking}` : modelId;
}

/**
 * The stats row's tooltip: the per-direction tokens and facts that are too
 * noisy for the one-line footer but exactly what `/session` prints.
 */
export function footerDetailText(facts: FooterFacts): string | null {
  const parts: string[] = [];
  if (facts.usage) {
    parts.push(
      `in ${formatTokens(facts.usage.input)} · out ${formatTokens(facts.usage.output)} · cache r ${formatTokens(facts.usage.cacheRead)} / w ${formatTokens(facts.usage.cacheWrite)}`,
    );
  }
  if (facts.model) parts.push(`model ${facts.model}`);
  if (facts.provider) parts.push(`provider ${facts.provider}`);
  if (facts.auto?.compaction) parts.push("auto-compaction");
  if (facts.auto?.retry) parts.push("auto-retry");
  return parts.length > 0 ? parts.join("\n") : null;
}
