/**
 * A small, git-compatible `.gitignore` matcher (plan step 7).
 *
 * The host lists workspace files for `@` completion, and Pi's own file tools
 * delegate to the `fd`/`rg` binaries, which the Electron-bundled runtime cannot
 * assume. This module implements the subset of git's rules a walker needs:
 * blanks and `#` comments, `!` negation, a leading `/` anchor, a trailing `/`
 * for directories, `*` (which never crosses `/`), `**`, `?` and `[...]`
 * classes, with **the last matching rule winning**.
 *
 * Git's own caveat is preserved instead of papered over: a file cannot be
 * re-included once a parent directory is excluded. That is exactly what a
 * directory-pruning walker does, so the walker and this matcher agree.
 */

export interface IgnoreRule {
  /** The pattern as written, after `!`, anchors and the trailing slash. */
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

/** Parses one `.gitignore` file into ordered rules. */
export function parseGitignore(contents: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripTrailingSpaces(rawLine);
    if (line.length === 0 || line.startsWith("#")) continue;

    let body = line;
    let negated = false;
    if (body.startsWith("!") && !body.startsWith("\\!")) {
      negated = true;
      body = body.slice(1);
    } else if (body.startsWith("\\!")) {
      body = body.slice(1);
    }
    if (body.length === 0) continue;

    let directoryOnly = false;
    if (body.endsWith("/") && !body.endsWith("\\/")) {
      directoryOnly = true;
      body = body.slice(0, -1);
    }
    if (body.length === 0) continue;

    // A leading slash, or any slash at all, makes the pattern relative to the
    // directory holding the .gitignore file; otherwise it matches at any depth.
    let anchored = false;
    if (body.startsWith("/")) {
      anchored = true;
      body = body.slice(1);
    } else if (body.includes("/")) {
      anchored = true;
    }
    if (body.length === 0) continue;

    const prefix = anchored ? "^" : "(?:^|/)";
    rules.push({
      pattern: body,
      negated,
      directoryOnly,
      anchored,
      regex: new RegExp(`${prefix}${globToRegexSource(body)}$`),
    });
  }
  return rules;
}

/**
 * True when `relativePath` is ignored. Directories are tested with
 * `isDirectory: true` before a walker descends into them, and files also consult
 * their ancestors so the function is correct when called on its own.
 */
export function isIgnored(
  rules: readonly IgnoreRule[],
  relativePath: string,
  isDirectory = false,
): boolean {
  const path = normalizeRelativePath(relativePath);
  if (path.length === 0) return false;
  if (matchesRules(rules, path, isDirectory)) return true;
  if (isDirectory) return false;

  const segments = path.split("/");
  for (let count = segments.length - 1; count > 0; count -= 1) {
    if (matchesRules(rules, segments.slice(0, count).join("/"), true)) return true;
  }
  return false;
}

/** Last matching rule wins; negated matches re-include. */
function matchesRules(rules: readonly IgnoreRule[], path: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (rule.regex.test(path)) ignored = !rule.negated;
  }
  return ignored;
}

/** Translates a gitignore glob into a regular-expression source fragment. */
export function globToRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "\\") {
      const next = pattern[index + 1];
      if (next !== undefined) {
        source += escapeRegExp(next);
        index += 1;
      }
      continue;
    }
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          // `**/` matches zero or more directories.
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end > index + 1) {
        let body = pattern.slice(index + 1, end);
        const negated = body.startsWith("!") || body.startsWith("^");
        if (negated) body = body.slice(1);
        source += `[${negated ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`;
        index = end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return source;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Git strips unescaped trailing spaces; a backslash-protected space stays. */
function stripTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " ") {
    let backslashes = 0;
    for (let index = end - 2; index >= 0 && line[index] === "\\"; index -= 1) backslashes += 1;
    if (backslashes % 2 === 1) break;
    end -= 1;
  }
  return line.slice(0, end);
}

/** POSIX-style, no leading `./`, no trailing slash. */
function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/^\/+/, "");
}
