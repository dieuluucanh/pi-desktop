/**
 * The app's language vocabulary.
 *
 * One mapping serves three consumers: the file explorer's type badge, the
 * CodeMirror language loader, and the formatter registry. It is deliberately
 * dependency-free so the node project, the renderer and main can all import it.
 *
 * A language id is a *display/formatting* label, not a guarantee that the
 * editor ships a parser. The CodeMirror loader falls back to plain text for an
 * id without a grammar, and the formatter registry falls back to "not
 * configured" for an id without a provider.
 */

export const LANGUAGE_IDS = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "json",
  "jsonc",
  "css",
  "scss",
  "less",
  "html",
  "markdown",
  "mdx",
  "yaml",
  "graphql",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "lua",
  "shellscript",
  "sql",
  "xml",
  "vue",
  "svelte",
  "dockerfile",
  "toml",
  "ini",
  "plaintext",
] as const;

export type LanguageId = (typeof LANGUAGE_IDS)[number];

const LANGUAGE_ID_SET: ReadonlySet<string> = new Set(LANGUAGE_IDS);

/** True when a value is one of the known language ids. */
export function isKnownLanguageId(value: unknown): value is LanguageId {
  return typeof value === "string" && LANGUAGE_ID_SET.has(value);
}

/** Human label used in the editor status row and Settings. */
export const LANGUAGE_LABELS: Record<LanguageId, string> = {
  typescript: "TypeScript",
  typescriptreact: "TypeScript React",
  javascript: "JavaScript",
  javascriptreact: "JavaScript React",
  json: "JSON",
  jsonc: "JSON with Comments",
  css: "CSS",
  scss: "SCSS",
  less: "Less",
  html: "HTML",
  markdown: "Markdown",
  mdx: "MDX",
  yaml: "YAML",
  graphql: "GraphQL",
  python: "Python",
  go: "Go",
  rust: "Rust",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  ruby: "Ruby",
  lua: "Lua",
  shellscript: "Shell",
  sql: "SQL",
  xml: "XML",
  vue: "Vue",
  svelte: "Svelte",
  dockerfile: "Dockerfile",
  toml: "TOML",
  ini: "INI",
  plaintext: "Plain Text",
};

/**
 * The explorer's compact type chip. Kept to at most four characters so the
 * 320 px rail does not lose the file name to a badge.
 */
export const LANGUAGE_BADGES: Record<LanguageId, string> = {
  typescript: "TS",
  typescriptreact: "TSX",
  javascript: "JS",
  javascriptreact: "JSX",
  json: "JSON",
  jsonc: "JSON",
  css: "CSS",
  scss: "SCSS",
  less: "LESS",
  html: "HTML",
  markdown: "MD",
  mdx: "MDX",
  yaml: "YAML",
  graphql: "GQL",
  python: "PY",
  go: "GO",
  rust: "RS",
  java: "JAVA",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  ruby: "RB",
  lua: "LUA",
  shellscript: "SH",
  sql: "SQL",
  xml: "XML",
  vue: "VUE",
  svelte: "SVEL",
  dockerfile: "DF",
  toml: "TOML",
  ini: "INI",
  plaintext: "TXT",
};

/** Extension -> language. Keys are lower-case, without the leading dot. */
const EXTENSION_LANGUAGE: Readonly<Record<string, LanguageId>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  yaml: "yaml",
  yml: "yaml",
  graphql: "graphql",
  gql: "graphql",
  py: "python",
  pyw: "python",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  lua: "lua",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "shellscript",
  sql: "sql",
  xml: "xml",
  vue: "vue",
  svelte: "svelte",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
};

/** Whole-file names that have no useful extension. */
const NAME_LANGUAGE: Readonly<Record<string, LanguageId>> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  makefile: "plaintext",
  cmakelists: "plaintext",
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".editorconfig": "ini",
  ".env": "plaintext",
  ".npmrc": "plaintext",
  ".prettierrc": "json",
  ".eslintrc": "json",
  ".babelrc": "json",
  "tsconfig.json": "jsonc",
  "jsconfig.json": "jsonc",
};

const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "svg",
  "avif",
  "tif",
  "tiff",
]);

/** The last path segment, tolerating both `/` and `\` for display-only input. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** The lower-case extension without the dot, or "" when there is none. */
function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** True for image files (the editor shows a placeholder instead of text). */
export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

/**
 * Resolves a path to a language id. Special file names win over extensions
 * (`.env` has no extension; `tsconfig.json` is JSONC), then the extension map,
 * then `plaintext`.
 */
export function languageIdForPath(path: string): LanguageId {
  const name = baseName(path).toLowerCase();
  const named = NAME_LANGUAGE[name];
  if (named) return named;
  return EXTENSION_LANGUAGE[extensionOf(path)] ?? "plaintext";
}

/** Human label for a language id. */
export function languageLabel(languageId: LanguageId): string {
  return LANGUAGE_LABELS[languageId];
}

/** Compact explorer/tab badge for a language id. */
export function languageBadge(languageId: LanguageId): string {
  return LANGUAGE_BADGES[languageId];
}
