/**
 * A small `.editorconfig` reader.
 *
 * It implements the subset the editor needs: `root`, `[*]`/glob sections,
 * `indent_style`, `indent_size`, `tab_width`, `end_of_line`,
 * `insert_final_newline` and `trim_trailing_whitespace`. No dependency, no
 * code execution, and unknown keys are ignored rather than rejected (the spec
 * is forward-compatible).
 *
 * Matching is intentionally approximate for exotic globs: `*`, `**`, `?`,
 * `{a,b}` and simple `[...]` classes are supported. A pattern without a `/`
 * matches the file name at any depth, exactly like editorconfig.
 */

import { join } from "node:path";

import type { ResolvedEditorConfig } from "../shared/workspace";

export interface EditorConfigIo {
  readTextFile(target: string): Promise<string | null>;
}

export interface ParsedEditorConfig {
  /** `root = true` in the preamble. */
  root: boolean;
  /** Keys before the first section (global to the file). */
  globals: Record<string, string>;
  sections: { pattern: string; values: Record<string, string> }[];
}

export const DEFAULT_EDITOR_CONFIG: ResolvedEditorConfig = {
  indentStyle: "space",
  indentSize: 2,
  tabWidth: 2,
  endOfLine: "lf",
  insertFinalNewline: true,
  trimTrailingWhitespace: true,
};

/** Parses one `.editorconfig` file. */
export function parseEditorConfig(text: string): ParsedEditorConfig {
  const parsed: ParsedEditorConfig = { root: false, globals: {}, sections: [] };
  let current: Record<string, string> | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const pattern = line.slice(1, -1).trim();
      if (pattern.length === 0) continue;
      const section = { pattern, values: {} as Record<string, string> };
      parsed.sections.push(section);
      current = section.values;
      continue;
    }

    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key.length === 0) continue;
    if (key === "root") {
      if (value.toLowerCase() === "true") parsed.root = true;
      continue;
    }
    if (current === null) {
      parsed.globals[key] = value;
    } else {
      current[key] = value;
    }
  }

  return parsed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Translates an editorconfig glob into a regular expression source. */
export function editorConfigGlobToRegex(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    if (character === "{") {
      const end = pattern.indexOf("}", index + 1);
      if (end !== -1) {
        const alternatives = pattern
          .slice(index + 1, end)
          .split(",")
          .map((part) => editorConfigGlobToRegex(part));
        source += `(?:${alternatives.join("|")})`;
        index = end;
        continue;
      }
    }
    if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end !== -1) {
        const body = pattern.slice(index + 1, end);
        const negated = body.startsWith("!") || body.startsWith("^");
        const classBody = negated ? body.slice(1) : body;
        source += `[${negated ? "^" : ""}${classBody.replace(/\\/g, "\\\\")}]`;
        index = end;
        continue;
      }
    }
    source += escapeRegExp(character);
  }
  return source;
}

/** True when an editorconfig section pattern matches a project-relative path. */
export function editorConfigPatternMatches(pattern: string, relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const target = pattern.includes("/") ? normalized : (normalized.split("/").pop() ?? normalized);
  try {
    return new RegExp(`^${editorConfigGlobToRegex(pattern)}$`).test(target);
  } catch {
    return false;
  }
}

function asInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function asBoolean(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const lowered = value.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  return null;
}

function directoryOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash <= 0 ? "" : relativePath.slice(0, slash);
}

/**
 * Resolves the effective config for one file. Config files are read from the
 * project root down to the file's directory; a nested `root = true` discards
 * everything above it.
 */
export async function resolveEditorConfig(
  io: EditorConfigIo,
  root: string,
  relativePath: string,
): Promise<ResolvedEditorConfig> {
  const directory = directoryOf(relativePath.replace(/\\/g, "/"));
  const segments = directory.length === 0 ? [] : directory.split("/");
  const configs: { base: string; parsed: ParsedEditorConfig }[] = [];

  for (let count = 0; count <= segments.length; count += 1) {
    const base = segments.slice(0, count).join("/");
    const target = join(root, base, ".editorconfig");
    const text = await io.readTextFile(target).catch(() => null);
    if (text === null) continue;
    const parsed = parseEditorConfig(text);
    if (parsed.root) configs.length = 0;
    configs.push({ base, parsed });
  }

  const resolved: ResolvedEditorConfig = { ...DEFAULT_EDITOR_CONFIG };
  const apply = (values: Record<string, string>): void => {
    const style = values.indent_style?.toLowerCase();
    if (style === "space" || style === "tab") resolved.indentStyle = style;

    const tabWidth = asInteger(values.tab_width);
    if (tabWidth !== null) resolved.tabWidth = tabWidth;

    const indentSize = asInteger(values.indent_size);
    if (indentSize !== null) {
      resolved.indentSize = indentSize;
    } else if (values.indent_size?.toLowerCase() === "tab") {
      resolved.indentSize = resolved.tabWidth;
    }

    const eol = values.end_of_line?.toLowerCase();
    if (eol === "lf" || eol === "crlf") resolved.endOfLine = eol;

    const finalNewline = asBoolean(values.insert_final_newline);
    if (finalNewline !== null) resolved.insertFinalNewline = finalNewline;

    const trim = asBoolean(values.trim_trailing_whitespace);
    if (trim !== null) resolved.trimTrailingWhitespace = trim;
  };

  for (const config of configs) {
    apply(config.parsed.globals);
    const relativeToBase =
      config.base.length === 0
        ? relativePath.replace(/\\/g, "/")
        : relativePath.replace(/\\/g, "/").slice(config.base.length).replace(/^\//, "");
    for (const section of config.parsed.sections) {
      if (editorConfigPatternMatches(section.pattern, relativeToBase)) apply(section.values);
    }
  }

  // A tab-indented file with no explicit size uses tab_width, not a stale 2.
  if (resolved.indentStyle === "tab" && resolved.indentSize === DEFAULT_EDITOR_CONFIG.indentSize) {
    resolved.indentSize = resolved.tabWidth;
  }
  return resolved;
}

/**
 * Applies the two whitespace rules an editor can enforce without a formatter.
 * The text is assumed LF-normalized; EOL is applied by the content writer.
 */
export function applyEditorStyle(
  text: string,
  config: Pick<ResolvedEditorConfig, "insertFinalNewline" | "trimTrailingWhitespace">,
): string {
  let next = text.replace(/\r\n?/g, "\n");
  if (config.trimTrailingWhitespace) next = next.replace(/[ \t]+$/gm, "");
  if (config.insertFinalNewline && next.length > 0 && !next.endsWith("\n")) next += "\n";
  return next;
}

export interface DetectedIndent {
  indentStyle: "space" | "tab";
  indentSize: number;
  tabWidth: number;
}

/**
 * Guesses indentation from the document itself, used when no `.editorconfig`
 * applies. The smallest positive space indent is the unit; tabs win when more
 * indented lines use tabs than spaces.
 */
export function detectIndent(text: string): DetectedIndent {
  let tabLines = 0;
  let spaceLines = 0;
  let smallest = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match = /^([ \t]+)/.exec(line);
    if (!match) continue;
    const whitespace = match[1]!;
    if (whitespace.startsWith("\t")) {
      tabLines += 1;
      continue;
    }
    spaceLines += 1;
    if (smallest === 0 || whitespace.length < smallest) smallest = whitespace.length;
  }
  if (tabLines > spaceLines) {
    return { indentStyle: "tab", indentSize: 4, tabWidth: 4 };
  }
  const indentSize = smallest >= 2 && smallest <= 8 ? smallest : 2;
  return { indentStyle: "space", indentSize, tabWidth: indentSize };
}
