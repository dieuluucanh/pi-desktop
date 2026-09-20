/**
 * A complete theme `colors` table for tests (plan step 15).
 *
 * Covers every key in `REQUIRED_THEME_COLORS` (`src/shared/themes.ts`), so a
 * document built from it passes `parseThemeDocument`. Light text on dark
 * colours resolves to the `dark` variant.
 */
export const COMPLETE_THEME_COLORS: Record<string, string> = {
  accent: "#111111",
  border: "#111111",
  borderAccent: "#111111",
  borderMuted: "#111111",
  success: "#111111",
  error: "#111111",
  warning: "#111111",
  muted: "#222222",
  dim: "#333333",
  text: "#eeeeee",
  selectedBg: "#111111",
  userMessageBg: "#111111",
  userMessageText: "#eeeeee",
  customMessageBg: "#111111",
  customMessageText: "#eeeeee",
  customMessageLabel: "#111111",
  toolPendingBg: "#111111",
  toolSuccessBg: "#111111",
  toolErrorBg: "#111111",
  toolTitle: "#eeeeee",
  toolOutput: "#222222",
  mdHeading: "#111111",
  mdLink: "#111111",
  mdLinkUrl: "#333333",
  mdCode: "#111111",
  mdCodeBlock: "#111111",
  mdCodeBlockBorder: "#222222",
  mdQuote: "#222222",
  mdQuoteBorder: "#222222",
  mdHr: "#222222",
  mdListBullet: "#111111",
  toolDiffAdded: "#111111",
  toolDiffRemoved: "#111111",
  toolDiffContext: "#222222",
};
