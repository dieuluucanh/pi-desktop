/**
 * Shell-command prefixes, shared by the composer, the completion stack and the
 * send path so the three cannot drift.
 *
 * Pi treats a buffer as a shell command when its first non-whitespace character
 * is `!`; `!!` is the same command with its output excluded from model context.
 * Leading spaces or a leading blank line therefore do not turn a shell command
 * into prose.
 */

/** True when the first non-whitespace character is `!` (`!` or `!!`). */
export function isShellCommand(text: string): boolean {
  return text.trimStart().startsWith("!");
}

/** True when the first non-whitespace characters are `!!`. */
export function isExcludedShellCommand(text: string): boolean {
  return text.trimStart().startsWith("!!");
}
