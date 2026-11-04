/**
 * The context-usage ring (plan step 8).
 *
 * Pi reports `contextUsage` as `{ tokens, contextWindow, percent }`, where
 * `percent` is already 0–100. `tokens` is null right after a compaction (before
 * the next response), which the ring shows as "unknown" instead of as 0% — an
 * empty ring and an unknown ring mean different things.
 */

import { formatTokens, ringFraction, type ContextUsageView } from "./model-catalog";
import { cn } from "../ui/cn";

export interface ContextRingProps {
  usage: ContextUsageView | null;
  /** Optional cost total for the tooltip, from `session.stats`. */
  cost?: number | null;
  className?: string;
}

export function contextRingLabel(usage: ContextUsageView | null, cost?: number | null): string {
  if (!usage) return "Context usage unknown";
  const parts: string[] = [];
  parts.push(
    usage.percent === null
      ? "context usage unknown"
      : `${Math.round(usage.percent)}% of context used`,
  );
  if (usage.tokens !== null) {
    parts.push(
      usage.contextWindow
        ? `${formatTokens(usage.tokens)} of ${formatTokens(usage.contextWindow)} tokens`
        : `${formatTokens(usage.tokens)} tokens`,
    );
  }
  if (typeof cost === "number" && cost > 0) parts.push(`$${cost.toFixed(4)} spent`);
  return parts.join(" · ");
}

export function ContextRing({ usage, cost = null, className }: ContextRingProps) {
  const fraction = ringFraction(usage);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const label = contextRingLabel(usage, cost);
  const tone =
    fraction === null
      ? "text-ink-faint"
      : fraction >= 0.9
        ? "text-danger"
        : fraction >= 0.7
          ? "text-warn"
          : "text-accent";

  return (
    <span
      data-testid="context-ring"
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-flex size-7 items-center justify-center", className)}
    >
      <svg viewBox="0 0 24 24" className="size-4 -rotate-90" aria-hidden>
        <circle cx="12" cy="12" r={radius} fill="none" strokeWidth="2.5" className="stroke-line" />
        {fraction !== null ? (
          <circle
            data-testid="context-ring-arc"
            cx="12"
            cy="12"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
            className={cn("stroke-current transition-[stroke-dashoffset]", tone)}
          />
        ) : null}
      </svg>
    </span>
  );
}
