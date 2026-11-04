/**
 * The canonical thinking-level vocabulary (2026-10-31 composer/footer/theme plan).
 *
 * Pi's thinking levels are one ordered set: `off` → `max`. The SDK derives the
 * per-model subset (`getSupportedThinkingLevels`), but every app surface needs
 * the same names, descriptions, ordering and brain-fill mapping. Keeping them
 * here means a new level is a one-file change instead of four copies that drift
 * (the previous copies had already lost `max` in two places).
 *
 * Pure: no SDK, React or DOM imports, so the node and renderer projects share it.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Short descriptions shown by the picker and the composer tooltip. */
export const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning; fastest",
  minimal: "Minimal reasoning",
  low: "Light reasoning for simple work",
  medium: "Balanced reasoning",
  high: "Deep reasoning for hard problems",
  xhigh: "Extra-high reasoning effort",
  max: "Maximum reasoning effort",
};

/** A brain fill step: 0 = empty outline, 4 = completely filled. */
export type ThinkingFillStep = 0 | 1 | 2 | 3 | 4;

export const THINKING_FILL_LABELS = ["empty", "1/4", "1/2", "3/4", "full"] as const;

/**
 * Absolute fill mapping (never relative to the model's supported set): `off` is
 * an empty outline, `minimal`/`low` a quarter, `medium` half, `high` three
 * quarters, and `xhigh`/`max` full. The tooltip names the exact level, so the
 * two full-fill levels are never ambiguous.
 */
const FILL_STEPS: Record<ThinkingLevel, ThinkingFillStep> = {
  off: 0,
  minimal: 1,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 4,
};

export function thinkingFillStep(level: string | null | undefined): ThinkingFillStep {
  return isThinkingLevel(level) ? FILL_STEPS[level] : 0;
}

export function thinkingFillLabel(level: string | null | undefined): string {
  return THINKING_FILL_LABELS[thinkingFillStep(level)];
}

/** One row of the thinking picker: a level and whether this model exposes it. */
export interface ThinkingLevelOption {
  level: string;
  supported: boolean;
}

/**
 * The picker's full scale: every canonical level plus any custom level the host
 * reported, in canonical order and marked with whether the selected model
 * supports it.
 *
 * Unsupported levels stay in the list so the user can see the whole vocabulary;
 * the picker renders them disabled. `levels` is the host's per-model list, so
 * the enabled set follows the selected model.
 */
export function thinkingLevelOptions(supportedLevels: readonly string[]): ThinkingLevelOption[] {
  const supported = new Set(supportedLevels);
  const levels = [...new Set([...THINKING_LEVELS, ...supportedLevels])];
  return orderThinkingLevels(levels).map((level) => ({ level, supported: supported.has(level) }));
}

/** Canonical order; unknown levels keep their input order after the known ones. */
export function orderThinkingLevels(levels: readonly string[]): string[] {
  const rank = (level: string): number => {
    const index = (THINKING_LEVELS as readonly string[]).indexOf(level);
    return index === -1 ? THINKING_LEVELS.length : index;
  };
  return levels
    .map((level, index) => ({ level, index }))
    .sort((a, b) => rank(a.level) - rank(b.level) || a.index - b.index)
    .map((entry) => entry.level);
}

/**
 * The composer's thinking tooltip: the exact level, its fill, the description,
 * the model it belongs to and the model's supported set.
 */
export function thinkingLevelTitle(
  level: string | null | undefined,
  supported: readonly string[] = [],
  modelLabel?: string | null,
): string {
  const lines: string[] = [];
  if (!level) {
    lines.push("Thinking level", "This model does not report a thinking level.");
  } else {
    const description = isThinkingLevel(level) ? THINKING_DESCRIPTIONS[level] : "Custom level";
    lines.push(`Thinking: ${level} (${thinkingFillLabel(level)})`, description);
  }
  if (modelLabel) lines.push(`Model: ${modelLabel}`);
  if (supported.length > 0)
    lines.push(`Supports: ${orderThinkingLevels([...supported]).join(", ")}`);
  return lines.join("\n");
}
