/**
 * Semantic tone → Tailwind utility (orchestrator plan step 11).
 *
 * The contribution contract carries a closed tone enum, never CSS. Tailwind only
 * generates a class it can see as a literal in scanned source, so every tone
 * maps to a complete utility string here (no `"border-" + tone`), and
 * `tests/styles-layering.test.ts` keeps this table equal to the pinned
 * `@source inline(...)` list in `styles.css`.
 */

import type { ContributionTone } from "../../../shared/extension-contributions";

/** Composer border for a mode badge's tone. */
export const CONTRIBUTION_BORDER_CLASS: Record<ContributionTone, string> = {
  neutral: "border-line",
  accent: "border-accent",
  info: "border-info",
  success: "border-ok",
  warning: "border-warn",
  error: "border-danger",
};

/** Text colour for a badge/row of that tone. */
export const CONTRIBUTION_TEXT_CLASS: Record<ContributionTone, string> = {
  neutral: "text-ink-faint",
  accent: "text-accent",
  info: "text-info",
  success: "text-ok",
  warning: "text-warn",
  error: "text-danger",
};

export function contributionBorderClass(tone: ContributionTone | null | undefined): string {
  return (tone ? CONTRIBUTION_BORDER_CLASS[tone] : undefined) ?? "border-line";
}

export function contributionTextClass(tone: ContributionTone | null | undefined): string {
  return (tone ? CONTRIBUTION_TEXT_CLASS[tone] : undefined) ?? "text-ink-faint";
}

/** Every class this module can return (the contract test pins the list). */
export const CONTRIBUTION_TONE_CLASSES: readonly string[] = [
  ...Object.values(CONTRIBUTION_BORDER_CLASS),
  ...Object.values(CONTRIBUTION_TEXT_CLASS),
];
