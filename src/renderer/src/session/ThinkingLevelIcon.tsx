/**
 * The composer's thinking-level brain (2026-10-31 UI plan).
 *
 * Four fill steps are required by the UI (`1/4`, `1/2`, `3/4`, full); Pi exposes
 * seven names, so the mapping is absolute and lives in `shared/thinking.ts`:
 * `off` is an empty outline, `minimal`/`low` a quarter, `medium` half, `high`
 * three quarters, and `xhigh`/`max` full. The surrounding button carries the
 * exact level in its `title`, so the two full levels stay distinguishable.
 *
 * The icon is presentational: it is `aria-hidden` and has no tooltip of its own.
 */

import { useId } from "react";

import { thinkingFillStep } from "../../../shared/thinking";
import { cn } from "../ui/cn";

export interface ThinkingLevelIconProps {
  level: string | null | undefined;
  className?: string;
}

/** A simple symmetric brain silhouette, filled from the bottom for each step. */
const BRAIN_PATH =
  "M12 2.5c-1.4 0-2.7.7-3.5 1.8-1.9.2-3.4 1.8-3.4 3.8 0 .4.1.9.2 1.3A4 4 0 0 0 4 12.9c0 1.8 1.2 3.3 2.9 3.8.5 1.6 2 2.8 3.8 2.8h2.6c1.8 0 3.3-1.2 3.8-2.8 1.7-.5 2.9-2 2.9-3.8 0-1.3-.6-2.5-1.3-3.5.1-.4.2-.9.2-1.3 0-2-1.5-3.6-3.4-3.8A4.2 4.2 0 0 0 12 2.5Z";

export function ThinkingLevelIcon({ level, className }: ThinkingLevelIconProps) {
  const step = thinkingFillStep(level);
  const fraction = step / 4;
  // `useId()` contains colons, which are awkward inside `url(#…)`; keep the id
  // alphanumeric so the clip resolves in every browser.
  const clipId = `brain-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("size-4", className)}
      data-testid="brain"
      data-level={level ?? "none"}
      data-fill={step}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}>
          <rect
            x="0"
            y={24 * (1 - fraction)}
            width="24"
            height={24 * fraction}
            data-fill-step={step}
          />
        </clipPath>
      </defs>
      {/* Always-visible outline. */}
      <path
        d={BRAIN_PATH}
        className="fill-none stroke-current opacity-50"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* The filled portion is the same silhouette clipped from the bottom up. */}
      {step > 0 ? (
        <path d={BRAIN_PATH} className="fill-current" clipPath={`url(#${clipId})`} />
      ) : null}
      {/* Sulci stay visible over the fill so the shape still reads as a brain. */}
      <g className="fill-none stroke-current opacity-40" strokeWidth="0.9" strokeLinecap="round">
        <path d="M12 4.5v13.5" />
        <path d="M9.2 6.4c-1.1.6-1.7 1.6-1.7 2.8 0 1.4.9 2.4 2.2 2.9" />
        <path d="M7 11.2c-.8.5-1.2 1.2-1.2 2 0 1.3 1 2.2 2.4 2.2" />
        <path d="M14.8 6.4c1.1.6 1.7 1.6 1.7 2.8 0 1.4-.9 2.4-2.2 2.9" />
        <path d="M17 11.2c.8.5 1.2 1.2 1.2 2 0 1.3-1 2.2-2.4 2.2" />
      </g>
    </svg>
  );
}
