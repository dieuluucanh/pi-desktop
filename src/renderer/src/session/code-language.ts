/**
 * Fence-language resolution for code blocks (plan step 5).
 *
 * `@tanstack`-style aliases are common in model output (`ts`, `sh`, `yml`), and
 * shiki only knows the canonical grammar names, so the mapping lives here and is
 * unit-testable without a DOM.
 */

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yml: "yaml",
  md: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  cs: "csharp",
  "c++": "cpp",
  ps1: "powershell",
  console: "shellscript",
};

/** Canonical shiki language for a markdown fence info string. */
export function normalizeLanguage(language: string | undefined): string {
  const raw = (language ?? "").trim().toLowerCase();
  if (raw.length === 0) return "text";
  return LANGUAGE_ALIASES[raw] ?? raw;
}
