/**
 * Format Document.
 *
 * The provider order is deliberate: a user-configured native formatter wins,
 * then bundled Prettier, then "not configured". This is the desktop-sized
 * answer to VS Code's formatter extensions: one good built-in formatter for web
 * languages and an explicit command adapter for everything else.
 *
 * Main runs the formatter, not the renderer. Prettier is a Node package, and
 * keeping it out of the renderer avoids a large lazy chunk and any CSP doubt.
 * The renderer sends text and a language id; it can never send a command — the
 * command comes from validated user prefs, so a compromised renderer cannot
 * turn Format Document into arbitrary code execution.
 */

import { spawn } from "node:child_process";

import { isKnownLanguageId } from "../shared/languages";
import {
  MAX_EDITOR_WRITE_BYTES,
  workspaceFailure,
  workspaceOk,
  type ResolvedEditorConfig,
  type WorkspaceFormatRequest,
  type WorkspaceFormatResult,
  type WorkspaceResult,
} from "../shared/workspace";

export interface FormatterCommandPolicy {
  /** Null when command formatters are disabled or no command is configured. */
  commandFor(languageId: string): Promise<string | null>;
  /** Explicit user opt-in; checked again here, not only in the UI. */
  commandFormattersAllowed(): Promise<boolean>;
}

export interface EditorFormatDeps {
  policy: FormatterCommandPolicy;
  editorConfig(projectPath: string, path: string): Promise<ResolvedEditorConfig>;
  runCommand(
    executable: string,
    args: readonly string[],
    cwd: string,
    input: string,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

type PrettierParser =
  | "babel"
  | "typescript"
  | "json"
  | "css"
  | "scss"
  | "less"
  | "html"
  | "markdown"
  | "mdx"
  | "yaml"
  | "graphql";

const PRETTIER_PARSERS: Readonly<Record<string, PrettierParser>> = {
  javascript: "babel",
  javascriptreact: "babel",
  typescript: "typescript",
  typescriptreact: "typescript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  vue: "html",
  svelte: "html",
  markdown: "markdown",
  mdx: "mdx",
  yaml: "yaml",
  graphql: "graphql",
};

/** Quote-aware argv split; no shell, so metacharacters are inert. */
export function parseCommandLine(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const character of value.trim()) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

async function formatWithPrettier(
  text: string,
  languageId: string,
  config: ResolvedEditorConfig,
): Promise<string | null> {
  const parser = PRETTIER_PARSERS[languageId];
  if (!parser) return null;
  const prettier = await import("prettier");
  const plugins: unknown[] = [];
  if (parser === "babel" || parser === "json") {
    plugins.push((await import("prettier/plugins/babel")).default);
    plugins.push((await import("prettier/plugins/estree")).default);
  } else if (parser === "typescript") {
    plugins.push((await import("prettier/plugins/typescript")).default);
    plugins.push((await import("prettier/plugins/estree")).default);
  } else if (parser === "css" || parser === "scss" || parser === "less") {
    plugins.push((await import("prettier/plugins/postcss")).default);
  } else if (parser === "html") {
    plugins.push((await import("prettier/plugins/html")).default);
  } else if (parser === "markdown" || parser === "mdx") {
    plugins.push((await import("prettier/plugins/markdown")).default);
  } else if (parser === "yaml") {
    plugins.push((await import("prettier/plugins/yaml")).default);
  } else if (parser === "graphql") {
    plugins.push((await import("prettier/plugins/graphql")).default);
  }
  return prettier.format(text, {
    parser,
    plugins: plugins as never[],
    tabWidth: config.indentSize,
    useTabs: config.indentStyle === "tab",
    endOfLine: config.endOfLine,
  });
}

/** Formats one document, returning a result envelope instead of throwing. */
export async function formatWorkspaceText(
  request: WorkspaceFormatRequest,
  deps: EditorFormatDeps,
): Promise<WorkspaceResult<WorkspaceFormatResult>> {
  if (!isKnownLanguageId(request.languageId)) {
    return workspaceFailure("bad_request", `unknown language: ${String(request.languageId)}`);
  }
  if (typeof request.text !== "string" || request.text.length > MAX_EDITOR_WRITE_BYTES) {
    return workspaceFailure("too_large", "the document is too large to format");
  }
  let config: ResolvedEditorConfig;
  try {
    config = await deps.editorConfig(request.projectPath, request.path);
  } catch {
    config = {
      indentStyle: "space",
      indentSize: 2,
      tabWidth: 2,
      endOfLine: "lf",
      insertFinalNewline: true,
      trimTrailingWhitespace: true,
    };
  }

  try {
    if (await deps.policy.commandFormattersAllowed()) {
      const command = await deps.policy.commandFor(request.languageId);
      if (command) {
        const [executable, ...args] = parseCommandLine(command);
        if (!executable)
          return workspaceFailure("not_configured", "the formatter command is empty");
        const result = await deps.runCommand(executable, args, request.projectPath, request.text);
        if (result.code !== 0) {
          const detail = result.stderr.trim().slice(0, 400) || `exit ${result.code}`;
          return workspaceFailure("formatter_failed", detail);
        }
        if (result.stdout.length === 0) {
          return workspaceFailure("formatter_failed", "the formatter produced no output");
        }
        return workspaceOk({ text: result.stdout, formatter: "command" });
      }
    }

    const formatted = await formatWithPrettier(request.text, request.languageId, config);
    if (formatted === null) {
      return workspaceFailure(
        "not_configured",
        `No formatter for ${request.languageId}. Configure one in Settings → Editor.`,
      );
    }
    return workspaceOk({ text: formatted, formatter: "prettier" });
  } catch (error) {
    return workspaceFailure(
      "formatter_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Node command runner used by the IPC wiring. No shell, bounded output. */
export async function runFormatterCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < 5_000_000) stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 64_000) stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
