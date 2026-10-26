/**
 * External-editor command parsing (2026-10-26 session-parity plan step 21).
 *
 * Pi reads `externalEditor` (or `$VISUAL`/`$EDITOR`) as a command line. The
 * desktop cannot hand that string to a shell: a settings value is not trusted
 * input, and `spawn` with `shell: true` would turn a pasted command into code
 * execution. The parser therefore splits the string into argv with quoting
 * support and rejects anything that only makes sense to a shell.
 *
 * Pure and node-free so the rules are unit tested without spawning anything.
 */

export interface EditorCommand {
  command: string;
  args: string[];
}

export interface EditorParseResult {
  editor: EditorCommand | null;
  error: string | null;
}

/** Characters that would require a shell to mean anything. */
const SHELL_METACHARACTERS = /[|&;<>()$`\\\n\r]/;

/**
 * Splits a command line into argv, honouring single and double quotes. Returns
 * an error for an unbalanced quote or a shell metacharacter rather than
 * guessing.
 */
export function parseEditorCommand(raw: string): EditorParseResult {
  const input = raw.trim();
  if (input.length === 0) return { editor: null, error: null };
  if (SHELL_METACHARACTERS.test(input)) {
    return {
      editor: null,
      error:
        "The external editor command cannot use shell syntax (pipes, redirects, variables). Set just the executable and its arguments.",
    };
  }
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of input) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started || current.length > 0) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote) {
    return { editor: null, error: "The external editor command has an unbalanced quote." };
  }
  if (started || current.length > 0) argv.push(current);
  const [command, ...args] = argv;
  if (!command) return { editor: null, error: null };
  return { editor: { command, args }, error: null };
}

/**
 * `externalEditor` wins, then `$VISUAL`, then `$EDITOR` — Pi's own order. An
 * empty result means "no OS editor configured", which is not an error: the app's
 * in-dialog expanded editor is always available.
 */
export function resolveEditorCommand(options: {
  setting?: string | null;
  env?: Record<string, string | undefined>;
}): { editor: EditorCommand | null; error: string | null; source: string | null } {
  const candidates: Array<[string, string | undefined | null]> = [
    ["externalEditor", options.setting],
    ["VISUAL", options.env?.VISUAL],
    ["EDITOR", options.env?.EDITOR],
  ];
  for (const [source, raw] of candidates) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const parsed = parseEditorCommand(raw);
    return { ...parsed, source };
  }
  return { editor: null, error: null, source: null };
}
