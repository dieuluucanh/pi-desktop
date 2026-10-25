/**
 * Pi's `settings.json`, described once (plan step 12).
 *
 * The desktop app must not invent a second settings vocabulary: every key here
 * comes from Pi's own `docs/settings.md`, and `tests/shared/settings-schema.test.ts`
 * fails when a documented key is missing from this table. The schema is pure data
 * — no SDK import, no Electron — so the renderer can render it and the host can
 * validate against it.
 *
 * Two scope rules follow Pi exactly:
 *  - `scope: "both"` means the key may appear globally (`~/.pi/agent/settings.json`)
 *    and in a project (`<cwd>/.pi/settings.json`), where the project value wins
 *    with nested-merge semantics;
 *  - `scope: "global"` means Pi reads only the global file (e.g. `httpProxy`).
 *
 * The defaults recorded here are the documented ones. A key whose default is
 * "SDK default" or "the environment" carries no `default` and is shown as unset.
 */

export type SettingsScope = "global" | "project";

export type SettingsFieldType =
  | "boolean"
  | "number"
  | "string"
  | "enum"
  | "string-list"
  /** Any JSON value (object/array/union); edited as raw JSON. */
  | "json";

export type SettingsDefaultValue =
  boolean | number | string | readonly string[] | Record<string, unknown>;

export interface SettingsField {
  /** Dotted path in `settings.json`, e.g. `"compaction.reserveTokens"`. */
  key: string;
  group: SettingsGroupId;
  label: string;
  description: string;
  type: SettingsFieldType;
  /** The documented default; absent means "no default / unset". */
  default?: SettingsDefaultValue;
  /** `both` = global + project override; `global` = Pi reads the global file only. */
  scope: "both" | "global";
  /** Allowed values for `enum`. */
  options?: readonly string[];
  min?: number;
  max?: number;
  /** Advanced keys are hidden behind “Show advanced” and edited as raw JSON. */
  advanced?: boolean;
}

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  description: string;
}

export const SETTINGS_GROUPS = [
  {
    id: "model-thinking",
    label: "Model & Thinking",
    description: "Startup model, thinking level and reasoning budgets.",
  },
  {
    id: "ui-display",
    label: "UI & Display",
    description: "Theme, editor chrome, tree filters and analytics.",
  },
  {
    id: "network",
    label: "Network",
    description: "Proxy and telemetry-adjacent network settings.",
  },
  {
    id: "warnings",
    label: "Warnings",
    description: "Transcript warnings the agent may show.",
  },
  {
    id: "compaction",
    label: "Compaction",
    description: "When and how the conversation is compacted.",
  },
  {
    id: "branch-summary",
    label: "Branch Summary",
    description: "How branch history is summarised when you navigate the tree.",
  },
  {
    id: "retry",
    label: "Retry",
    description: "Automatic retries for transient provider errors.",
  },
  {
    id: "message-delivery",
    label: "Message Delivery",
    description: "Steering/follow-up modes and transport timeouts.",
  },
  {
    id: "terminal-images",
    label: "Terminal & Images",
    description: "Terminal rendering overrides and image handling.",
  },
  {
    id: "shell",
    label: "Shell",
    description: "The shell and npm used for tools and packages.",
  },
  {
    id: "tools",
    label: "Tools",
    description: "Which built-in tools are enabled at startup.",
  },
  {
    id: "sessions",
    label: "Sessions",
    description: "Where session files are stored.",
  },
  {
    id: "model-cycling",
    label: "Model scope",
    description:
      "Models available to Ctrl+Alt cycling, the model dialog's stars and extension pickers.",
  },
  {
    id: "markdown",
    label: "Markdown",
    description: "Code-block indentation and Mermaid rendering.",
  },
  {
    id: "resources",
    label: "Resources",
    description: "Packages, extensions, skills, prompts and themes Pi loads.",
  },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const SETTINGS_FIELDS: readonly SettingsField[] = [
  // ---- Model & Thinking -------------------------------------------------
  {
    key: "defaultProvider",
    group: "model-thinking",
    label: "Default provider",
    description: "Startup provider, e.g. anthropic or openai.",
    type: "string",
    scope: "both",
  },
  {
    key: "defaultModel",
    group: "model-thinking",
    label: "Default model",
    description: "Startup model id, e.g. claude-sonnet-4-20250514.",
    type: "string",
    scope: "both",
  },
  {
    key: "defaultThinkingLevel",
    group: "model-thinking",
    label: "Default thinking level",
    description: "Startup thinking level.",
    type: "enum",
    options: THINKING_LEVELS,
    scope: "both",
  },
  {
    key: "modelThinkingLevels",
    group: "model-thinking",
    label: "Per-model thinking levels",
    description: 'Startup thinking levels keyed by "provider/modelId".',
    type: "json",
    scope: "both",
    advanced: true,
  },
  {
    key: "hideThinkingBlock",
    group: "model-thinking",
    label: "Hide thinking blocks",
    description: "Hide thinking blocks in output.",
    type: "boolean",
    default: false,
    scope: "both",
  },
  {
    key: "showCacheMissNotices",
    group: "model-thinking",
    label: "Show cache-miss notices",
    description: "Show transcript notices for significant prompt-cache misses and recovery.",
    type: "boolean",
    default: false,
    scope: "both",
  },
  {
    key: "thinkingBudgets",
    group: "model-thinking",
    label: "Thinking budgets",
    description: "Custom token budgets per thinking level.",
    type: "json",
    scope: "both",
    advanced: true,
  },

  // ---- UI & Display -----------------------------------------------------
  {
    key: "theme",
    group: "ui-display",
    label: "Theme",
    description: "Pi theme name (dark, light, or a custom theme).",
    type: "string",
    default: "dark",
    scope: "both",
  },
  {
    key: "externalEditor",
    group: "ui-display",
    label: "External editor",
    description: "Command for the external editor; takes precedence over $VISUAL/$EDITOR.",
    type: "string",
    scope: "both",
  },
  {
    key: "quietStartup",
    group: "ui-display",
    label: "Quiet startup",
    description: "Hide the startup header.",
    type: "boolean",
    default: false,
    scope: "both",
  },
  {
    key: "defaultProjectTrust",
    group: "ui-display",
    label: "Default project trust",
    description: "Fallback trust behaviour for a project without a saved decision.",
    type: "enum",
    options: ["ask", "always", "never"],
    default: "ask",
    scope: "global",
  },
  {
    key: "collapseChangelog",
    group: "ui-display",
    label: "Collapse changelog",
    description: "Show a condensed changelog after updates.",
    type: "boolean",
    default: false,
    scope: "both",
  },
  {
    key: "enableInstallTelemetry",
    group: "ui-display",
    label: "Install telemetry",
    description: "Anonymous install/update ping and provider attribution headers.",
    type: "boolean",
    default: true,
    scope: "both",
  },
  {
    key: "enableAnalytics",
    group: "ui-display",
    label: "Analytics",
    description: "Opt-in analytics data sharing.",
    type: "boolean",
    default: false,
    scope: "both",
  },
  {
    key: "trackingId",
    group: "ui-display",
    label: "Tracking id",
    description: "Analytics identifier, generated when analytics is enabled.",
    type: "string",
    scope: "global",
    advanced: true,
  },
  {
    key: "doubleEscapeAction",
    group: "ui-display",
    label: "Double-escape action",
    description: "What double-escape does.",
    type: "enum",
    options: ["tree", "fork", "none"],
    default: "tree",
    scope: "both",
  },
  {
    key: "treeFilterMode",
    group: "ui-display",
    label: "Tree filter mode",
    description: "Default filter for the session tree.",
    type: "enum",
    options: ["default", "no-tools", "user-only", "labeled-only", "all"],
    default: "default",
    scope: "both",
  },
  {
    key: "editorPaddingX",
    group: "ui-display",
    label: "Editor padding",
    description: "Horizontal padding for the input editor (0-3).",
    type: "number",
    default: 0,
    min: 0,
    max: 3,
    scope: "both",
  },
  {
    key: "outputPad",
    group: "ui-display",
    label: "Output padding",
    description: "Horizontal padding for messages (0 or 1).",
    type: "number",
    default: 1,
    min: 0,
    max: 1,
    scope: "both",
  },
  {
    key: "autocompleteMaxVisible",
    group: "ui-display",
    label: "Autocomplete rows",
    description: "Max visible autocomplete items (3-20).",
    type: "number",
    default: 5,
    min: 3,
    max: 20,
    scope: "both",
  },
  {
    key: "showHardwareCursor",
    group: "ui-display",
    label: "Show hardware cursor",
    description: "Show the terminal cursor while the TUI positions it for IME.",
    type: "boolean",
    default: false,
    scope: "both",
  },
  {
    key: "tuiMode",
    group: "ui-display",
    label: "TUI mode",
    description: "Interactive TUI mode for terminal Pi.",
    type: "enum",
    options: ["regular", "fullscreen"],
    default: "regular",
    scope: "both",
  },
  {
    key: "fullscreenExitOutput",
    group: "ui-display",
    label: "Fullscreen exit output",
    description: "What fullscreen prints on exit.",
    type: "enum",
    options: ["transcript", "resume-hint"],
    default: "transcript",
    scope: "both",
  },
  {
    key: "fullscreenScrollbar",
    group: "ui-display",
    label: "Fullscreen scrollbar",
    description: "Fullscreen transcript scrollbar behaviour.",
    type: "enum",
    options: ["auto", "always", "hidden"],
    default: "auto",
    scope: "both",
  },
  {
    key: "fullscreenCopyOnSelect",
    group: "ui-display",
    label: "Copy on select",
    description: "Automatically copy selected text in fullscreen mode.",
    type: "boolean",
    default: true,
    scope: "both",
  },

  // ---- Network ----------------------------------------------------------
  {
    key: "httpProxy",
    group: "network",
    label: "HTTP proxy",
    description: "Proxy URL applied as HTTP_PROXY and HTTPS_PROXY. Global setting only.",
    type: "string",
    scope: "global",
  },

  // ---- Warnings ---------------------------------------------------------
  {
    key: "warnings.anthropicExtraUsage",
    group: "warnings",
    label: "Anthropic extra-usage warning",
    description: "Warn when Anthropic subscription auth may use paid extra usage.",
    type: "boolean",
    default: true,
    scope: "both",
  },

  // ---- Compaction -------------------------------------------------------
  {
    key: "compaction.enabled",
    group: "compaction",
    label: "Auto-compaction",
    description: "Enable automatic compaction.",
    type: "boolean",
    default: true,
    scope: "both",
  },
  {
    key: "compaction.reserveTokens",
    group: "compaction",
    label: "Reserve tokens",
    description: "Tokens reserved for the LLM response.",
    type: "number",
    default: 16384,
    scope: "both",
  },
  {
    key: "compaction.keepRecentTokens",
    group: "compaction",
    label: "Keep recent tokens",
    description: "Recent tokens kept out of the summary.",
    type: "number",
    default: 20000,
    scope: "both",
  },

  // ---- Branch Summary ---------------------------------------------------
  {
    key: "branchSummary.reserveTokens",
    group: "branch-summary",
    label: "Reserve tokens",
    description: "Tokens reserved when selecting branch history.",
    type: "number",
    default: 16384,
    scope: "both",
  },
  {
    key: "branchSummary.skipPrompt",
    group: "branch-summary",
    label: "Skip summarise prompt",
    description: 'Skip the "Summarize branch?" prompt on tree navigation.',
    type: "boolean",
    default: false,
    scope: "both",
  },

  // ---- Retry ------------------------------------------------------------
  {
    key: "retry.enabled",
    group: "retry",
    label: "Automatic retry",
    description: "Retry transient agent-level errors.",
    type: "boolean",
    default: true,
    scope: "both",
  },
  {
    key: "retry.maxRetries",
    group: "retry",
    label: "Max retries",
    description: "Maximum agent-level retry attempts.",
    type: "number",
    default: 3,
    scope: "both",
  },
  {
    key: "retry.baseDelayMs",
    group: "retry",
    label: "Base delay (ms)",
    description: "Base delay for exponential backoff.",
    type: "number",
    default: 2000,
    scope: "both",
  },
  {
    key: "retry.provider.timeoutMs",
    group: "retry",
    label: "Provider timeout (ms)",
    description: "Provider/SDK request timeout. Unset means the SDK default.",
    type: "number",
    scope: "both",
    advanced: true,
  },
  {
    key: "retry.provider.maxRetries",
    group: "retry",
    label: "Provider retries",
    description: "Provider/SDK retry attempts (0 is the recommended value).",
    type: "number",
    default: 0,
    scope: "both",
    advanced: true,
  },
  {
    key: "retry.provider.maxRetryDelayMs",
    group: "retry",
    label: "Max retry delay (ms)",
    description: "Largest server-requested delay before failing.",
    type: "number",
    default: 60000,
    scope: "both",
    advanced: true,
  },

  // ---- Message Delivery -------------------------------------------------
  {
    key: "steeringMode",
    group: "message-delivery",
    label: "Steering mode",
    description: "How steering messages are sent while streaming.",
    type: "enum",
    options: ["all", "one-at-a-time"],
    default: "one-at-a-time",
    scope: "both",
  },
  {
    key: "followUpMode",
    group: "message-delivery",
    label: "Follow-up mode",
    description: "How follow-up messages are delivered.",
    type: "enum",
    options: ["all", "one-at-a-time"],
    default: "one-at-a-time",
    scope: "both",
  },
  {
    key: "transport",
    group: "message-delivery",
    label: "Transport",
    description: "Preferred transport for providers that support several.",
    type: "enum",
    options: ["auto", "sse", "websocket", "websocket-cached"],
    default: "auto",
    scope: "both",
  },
  {
    key: "httpIdleTimeoutMs",
    group: "message-delivery",
    label: "HTTP idle timeout (ms)",
    description: "HTTP header/body idle timeout; 0 disables it.",
    type: "number",
    default: 300000,
    scope: "both",
  },
  {
    key: "websocketConnectTimeoutMs",
    group: "message-delivery",
    label: "WebSocket connect timeout (ms)",
    description: "WebSocket handshake timeout; 0 disables it.",
    type: "number",
    default: 15000,
    scope: "both",
  },

  // ---- Terminal & Images ------------------------------------------------
  {
    key: "terminal.showImages",
    group: "terminal-images",
    label: "Show images",
    description: "Show images in the terminal (if supported).",
    type: "boolean",
    default: true,
    scope: "both",
  },
  {
    key: "terminal.imageWidthCells",
    group: "terminal-images",
    label: "Image width (cells)",
    description: "Preferred inline image width in terminal cells.",
    type: "number",
    default: 60,
    scope: "both",
  },
  {
    key: "terminal.clearOnShrink",
    group: "terminal-images",
    label: "Clear on shrink",
    description: "Clear empty rows when content shrinks.",
    type: "boolean",
    default: false,
    scope: "both",
  },
  {
    key: "terminal.hyperlinks",
    group: "terminal-images",
    label: "OSC 8 hyperlinks",
    description: 'Override hyperlink support: true, false or "auto".',
    type: "json",
    default: "auto",
    scope: "both",
    advanced: true,
  },
  {
    key: "terminal.images",
    group: "terminal-images",
    label: "Image protocol",
    description: 'Override image support: "kitty", "iterm2", false or "auto".',
    type: "json",
    default: "auto",
    scope: "both",
    advanced: true,
  },
  {
    key: "terminal.trueColor",
    group: "terminal-images",
    label: "Truecolor",
    description: 'Override truecolor support: true, false or "auto".',
    type: "json",
    default: "auto",
    scope: "both",
    advanced: true,
  },
  {
    key: "images.autoResize",
    group: "terminal-images",
    label: "Auto-resize images",
    description: "Resize images to 2000x2000 max before sending them to the model.",
    type: "boolean",
    default: true,
    scope: "both",
  },
  {
    key: "images.blockImages",
    group: "terminal-images",
    label: "Block images",
    description: "Block all images from being sent to the model.",
    type: "boolean",
    default: false,
    scope: "both",
  },

  // ---- Shell ------------------------------------------------------------
  {
    key: "shellPath",
    group: "shell",
    label: "Shell path",
    description: "Custom shell path; supports a leading ~.",
    type: "string",
    scope: "both",
  },
  {
    key: "shellCommandPrefix",
    group: "shell",
    label: "Shell command prefix",
    description: "Prefix for every bash command.",
    type: "string",
    scope: "both",
  },
  {
    key: "npmCommand",
    group: "shell",
    label: "npm command",
    description: "Argv used for npm package operations.",
    type: "string-list",
    scope: "both",
    advanced: true,
  },

  // ---- Tools ------------------------------------------------------------
  {
    key: "defaultTools",
    group: "tools",
    label: "Default tools",
    description: "Built-in tools enabled at startup; an empty array means none.",
    type: "string-list",
    scope: "both",
  },

  // ---- Sessions ---------------------------------------------------------
  {
    key: "sessionDir",
    group: "sessions",
    label: "Session directory",
    description: "Where session files are stored; accepts absolute, relative and ~ paths.",
    type: "string",
    scope: "both",
  },

  // ---- Model scope (Pi's enabledModels) --------------------------------
  {
    key: "enabledModels",
    group: "model-cycling",
    label: "Model scope",
    description:
      "Models in scope for Ctrl+Alt cycling, the model dialog's stars and extension pickers (/profile, /role). Empty means every model.",
    type: "string-list",
    scope: "both",
  },

  // ---- Markdown ---------------------------------------------------------
  {
    key: "markdown.codeBlockIndent",
    group: "markdown",
    label: "Code-block indent",
    description: "Indentation for code blocks.",
    type: "string",
    default: "  ",
    scope: "both",
  },
  {
    key: "markdown.mermaid",
    group: "markdown",
    label: "Mermaid rendering",
    description: "Mermaid rendering mode.",
    type: "enum",
    options: ["off", "final", "streaming"],
    default: "streaming",
    scope: "both",
  },

  // ---- Resources --------------------------------------------------------
  {
    key: "packages",
    group: "resources",
    label: "Packages",
    description: "npm/git packages to load resources from.",
    type: "json",
    default: [],
    scope: "both",
  },
  {
    key: "extensions",
    group: "resources",
    label: "Extensions",
    description: "Local extension paths; supports globs, ! and +/- prefixes.",
    type: "string-list",
    default: [],
    scope: "both",
  },
  {
    key: "skills",
    group: "resources",
    label: "Skills",
    description: "Local skill paths.",
    type: "string-list",
    default: [],
    scope: "both",
  },
  {
    key: "prompts",
    group: "resources",
    label: "Prompts",
    description: "Local prompt template paths.",
    type: "string-list",
    default: [],
    scope: "both",
  },
  {
    key: "themes",
    group: "resources",
    label: "Themes",
    description: "Local theme paths.",
    type: "string-list",
    default: [],
    scope: "both",
  },
  {
    key: "enableSkillCommands",
    group: "resources",
    label: "Skill commands",
    description: "Register skills as /skill:<name> commands.",
    type: "boolean",
    default: true,
    scope: "both",
  },
];

/** The field for a dotted key, if the schema knows it. */
export function findSettingsField(key: string): SettingsField | undefined {
  return SETTINGS_FIELDS.find((field) => field.key === key);
}

/** The group descriptor for an id. */
export function findSettingsGroup(id: SettingsGroupId): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find((group) => group.id === id);
}

/** Fields of one group, in declaration order. */
export function settingsFieldsForGroup(id: SettingsGroupId): SettingsField[] {
  return SETTINGS_FIELDS.filter((field) => field.group === id);
}

/** Groups with their fields, skipping groups the schema has none for. */
export function groupSettingsFields(): Array<{ group: SettingsGroup; fields: SettingsField[] }> {
  return SETTINGS_GROUPS.map((group) => ({
    group,
    fields: settingsFieldsForGroup(group.id),
  })).filter((entry) => entry.fields.length > 0);
}

/** `"compaction.reserveTokens"` → `["compaction", "reserveTokens"]`. */
export function splitSettingsKey(key: string): string[] {
  return key.split(".").filter((part) => part.length > 0);
}

/** A JSON value read out of a settings document. */
export type SettingsValue =
  | boolean
  | number
  | string
  | null
  | readonly SettingsValue[]
  | { readonly [key: string]: SettingsValue };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a dotted key out of a settings document. */
export function getSettingsValue(document: unknown, key: string): SettingsValue | undefined {
  let current: unknown = document;
  for (const part of splitSettingsKey(key)) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current === undefined ? undefined : (current as SettingsValue);
}

/**
 * Returns a copy of `document` with `key` set to `value`, creating intermediate
 * objects. Setting a nested key never mutates the input or its siblings.
 */
export function setSettingsValue(
  document: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const parts = splitSettingsKey(key);
  if (parts.length === 0) return document;
  const [head, ...rest] = parts;
  if (head === undefined) return document;
  const clone: Record<string, unknown> = { ...document };
  if (rest.length === 0) {
    clone[head] = value;
    return clone;
  }
  const child = isPlainObject(clone[head]) ? (clone[head] as Record<string, unknown>) : {};
  clone[head] = setSettingsValue(child, rest.join("."), value);
  return clone;
}

/**
 * Returns a copy of `document` without `key`, pruning now-empty intermediate
 * objects so `{compaction:{enabled:false}}` minus `compaction.enabled` becomes
 * `{}` rather than an empty object Pi would still read.
 */
export function deleteSettingsValue(
  document: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const parts = splitSettingsKey(key);
  if (parts.length === 0) return document;
  const [head, ...rest] = parts;
  if (head === undefined) return document;
  if (!(head in document)) return document;
  const clone: Record<string, unknown> = { ...document };
  if (rest.length === 0) {
    delete clone[head];
    return clone;
  }
  if (!isPlainObject(clone[head])) return document;
  const child = deleteSettingsValue(clone[head] as Record<string, unknown>, rest.join("."));
  if (Object.keys(child).length === 0) delete clone[head];
  else clone[head] = child;
  return clone;
}

/** Every dotted key in a document (leaves only), with its value. */
export function flattenSettingsDocument(document: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(document)) return out;
  for (const [key, value] of Object.entries(document)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      Object.assign(out, flattenSettingsDocument(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** Deep merge where the later document wins; objects merge, everything replaces. */
export function mergeSettingsScopes(global: unknown, project: unknown): Record<string, unknown> {
  const base = isPlainObject(global) ? global : {};
  const override = isPlainObject(project) ? project : {};
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeSettingsScopes(existing, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** The documented defaults as a nested settings document. */
export function settingsDefaultsDocument(): Record<string, unknown> {
  let document: Record<string, unknown> = {};
  for (const field of SETTINGS_FIELDS) {
    if (field.default === undefined) continue;
    document = setSettingsValue(document, field.key, field.default);
  }
  return document;
}

export interface SettingsDiffEntry {
  key: string;
  /** The value in the document (undefined when the key is absent). */
  value: unknown;
  /** The documented default (undefined when there is none). */
  defaultValue: unknown;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Keys whose effective value differs from the documented default. `undefined`
 * on either side counts as absent, so an unset key with no default is not noise.
 */
export function diffSettingsDocument(document: unknown): SettingsDiffEntry[] {
  const flat = flattenSettingsDocument(document);
  const defaults = flattenSettingsDocument(settingsDefaultsDocument());
  const keys = new Set([...Object.keys(flat), ...Object.keys(defaults)]);
  const entries: SettingsDiffEntry[] = [];
  for (const key of keys) {
    const value = flat[key];
    const defaultValue = defaults[key];
    if (value === undefined && defaultValue === undefined) continue;
    if (sameValue(value, defaultValue)) continue;
    entries.push({ key, value, defaultValue });
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

export type SettingsValidation = { ok: true; value: unknown } | { ok: false; error: string };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Keys **present** in the document whose value differs from the documented
 * default. This is the raw editor's “what did I change?” view: a key the default
 * has and the document omits is not an override, so it is not listed.
 * `diffSettingsDocument` is the two-way diff (used when comparing whole scopes).
 */
export function settingsChangesFromDefaults(document: unknown): SettingsDiffEntry[] {
  const flat = flattenSettingsDocument(document);
  const defaults = flattenSettingsDocument(settingsDefaultsDocument());
  const entries: SettingsDiffEntry[] = [];
  for (const [key, value] of Object.entries(flat)) {
    const defaultValue = defaults[key];
    if (sameValue(value, defaultValue)) continue;
    entries.push({ key, value, defaultValue });
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Validates one value against its field. An empty string or `null` means
 * “unset” and is returned as `undefined` so the caller can delete the key.
 * Never throws: the UI shows the message inline and the file is untouched.
 */
export function validateSettingsValue(field: SettingsField, raw: unknown): SettingsValidation {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, value: undefined };
  }
  switch (field.type) {
    case "boolean": {
      if (typeof raw !== "boolean")
        return { ok: false, error: `${field.label} must be true or false` };
      return { ok: true, value: raw };
    }
    case "number": {
      const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, error: `${field.label} must be a number` };
      }
      if (field.min !== undefined && value < field.min) {
        return { ok: false, error: `${field.label} must be at least ${field.min}` };
      }
      if (field.max !== undefined && value > field.max) {
        return { ok: false, error: `${field.label} must be at most ${field.max}` };
      }
      return { ok: true, value };
    }
    case "string": {
      if (typeof raw !== "string") return { ok: false, error: `${field.label} must be text` };
      return { ok: true, value: raw };
    }
    case "enum": {
      if (typeof raw !== "string" || !(field.options ?? []).includes(raw)) {
        return {
          ok: false,
          error: `${field.label} must be one of: ${(field.options ?? []).join(", ")}`,
        };
      }
      return { ok: true, value: raw };
    }
    case "string-list": {
      if (!isStringArray(raw)) {
        return { ok: false, error: `${field.label} must be a list of strings` };
      }
      return { ok: true, value: raw };
    }
    case "json": {
      // Any JSON value is accepted; it must survive a round trip.
      try {
        return { ok: true, value: JSON.parse(JSON.stringify(raw)) };
      } catch {
        return { ok: false, error: `${field.label} must be valid JSON` };
      }
    }
  }
}

/** Parses a raw JSON editor's text into a value; used by the raw editor. */
export function parseSettingsJson(text: string): SettingsValidation {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
}
