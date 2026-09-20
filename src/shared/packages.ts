/**
 * Packages: the wire shapes and pure source handling for the package manager
 * (plan step 14).
 *
 * Pi installs packages from `npm:pkg[@ver]`, a bare npm name, a `git:` spec, a
 * hosted Git URL or a local path, and records the exact source string in
 * `settings.json#packages`. The hub never invents an entry the SDK would parse
 * differently, so the same pure parser/normalizer is used by the host port, the
 * parity test against `src/main/packages/*` and (read-only) the renderer.
 *
 * Bare names are the one case that needs care: the SDK treats a bare string as a
 * *local path* (`isLocalPath`), so `@scope/name` must be normalised to
 * `npm:@scope/name` before it reaches `DefaultPackageManager`.
 */

export const PACKAGE_SCOPES = ["user", "project"] as const;
export type PackageScope = (typeof PACKAGE_SCOPES)[number];

export function isPackageScope(value: unknown): value is PackageScope {
  return typeof value === "string" && (PACKAGE_SCOPES as readonly string[]).includes(value);
}

export type PackageSourceKind = "npm" | "git" | "path";

const PACKAGE_SOURCE_KINDS: readonly PackageSourceKind[] = ["npm", "git", "path"];

export function isPackageSourceKind(value: unknown): value is PackageSourceKind {
  return typeof value === "string" && (PACKAGE_SOURCE_KINDS as readonly string[]).includes(value);
}

export interface ParsedPackageSource {
  /** The normalised source, exactly what the package manager receives. */
  source: string;
  kind: PackageSourceKind;
  /** npm package name, Git repo basename, or path basename. */
  name: string;
  /** npm version/range or Git ref; null when the source floats. */
  version: string | null;
  /** Dedupe key ignoring the version: `npm:<name>`, `git:<host>/<path>` or `path:<path>`. */
  identity: string;
  /** True for an exact npm version or an explicit Git ref. */
  pinned: boolean;
}

export class PackageSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageSourceError";
  }
}

/** Exact semver (no ranges), the npm form that is a deliberate pin. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const GIT_PROTOCOL = /^(git:|ssh:|git@)/i;
const GIT_HTTP = /^https?:\/\//i;
/** Hosts whose `https://host/owner/repo` URL is understood as a Git source. */
const HOSTED_GIT =
  /^https?:\/\/(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//i;
const LOCAL_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]|~[\\/]|\.\.?[\\/])/;

/**
 * The npm package-name grammar (scoped or not). It cannot match a path: `/` is
 * only allowed in the `@scope/name` form and every segment must start with an
 * alphanumeric, so `..`, `../../evil` and `@scope/..` all fail.
 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * Refuses a name that is not an npm package name. The point is not tidiness: a
 * dependency key of `../../evil` in the generated npm-root `package.json` is a
 * *local path* dependency, so npm would install from outside the npm root
 * (plan step 23).
 */
function requireNpmName(name: string): string {
  if (!NPM_NAME.test(name)) {
    throw new PackageSourceError(`not a valid npm package name: ${name}`);
  }
  return name;
}

/**
 * Refuses a version/tag that could be read as a path or URL. npm treats a
 * dependency value starting with `.`/`/`, or containing `/`, as a local path or
 * a git spec, so `npm:pkg@../../evil` would escape the npm root the same way.
 */
function requireNpmVersion(version: string): string {
  if (version.startsWith(".") || /[\\/]/.test(version)) {
    throw new PackageSourceError(`not a valid npm version or tag: ${version}`);
  }
  return version;
}

function trimSource(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new PackageSourceError("a package source is required");
  if (/\s/.test(trimmed)) {
    throw new PackageSourceError(`a package source may not contain whitespace: ${raw}`);
  }
  return trimmed;
}

function looksLikeGit(source: string): boolean {
  if (GIT_PROTOCOL.test(source)) return true;
  if (HOSTED_GIT.test(source)) return true;
  // A generic `.git` URL is a Git source even off the well-known hosts.
  return GIT_HTTP.test(source) && /\.git(?:#.*)?$/i.test(source);
}

function splitNpm(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { name: spec, version: null };
  const version = spec.slice(at + 1);
  if (version.length === 0) return { name: spec.slice(0, at), version: null };
  return { name: spec.slice(0, at), version };
}

/**
 * Normalises a user-supplied source into the string the package manager needs.
 * Bare names become `npm:`; everything already qualified (npm/git/URL/path) is
 * kept verbatim so the settings entry stays readable and terminal-Pi compatible.
 */
export function normalizePackageSource(raw: string): string {
  const source = trimSource(raw);
  if (source.startsWith("npm:")) return source;
  if (looksLikeGit(source)) return source;
  if (LOCAL_PATH.test(source)) return source;
  return `npm:${source}`;
}

function parseGit(source: string): ParsedPackageSource {
  const withoutPrefix =
    GIT_PROTOCOL.test(source) && !source.startsWith("git@") ? source.replace(/^git:/i, "") : source;
  const [repoPart = "", ref = null] = withoutPrefix.split("#", 2);
  const repo = repoPart.replace(/\.git$/i, "");
  const segments = repo.split(/[/:]/).filter((part) => part.length > 0);
  const basename = segments[segments.length - 1] ?? repo;
  const host = segments.find((part) => part.includes(".")) ?? "";
  return {
    source,
    kind: "git",
    name: basename,
    version: ref,
    identity: `git:${host}/${segments.slice(segments.indexOf(host) + 1).join("/")}`,
    pinned: typeof ref === "string" && ref.length > 0,
  };
}

/**
 * Parses a source the way the SDK's `parseSource` does after normalisation. The
 * returned `source` is normalised, so callers can persist it directly.
 */
export function parsePackageSource(raw: string): ParsedPackageSource {
  const source = normalizePackageSource(raw);
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    if (spec.length === 0) throw new PackageSourceError("an npm package name is required");
    const { name, version } = splitNpm(spec);
    if (name.length === 0) throw new PackageSourceError(`invalid npm source: ${raw}`);
    requireNpmName(name);
    if (version !== null) requireNpmVersion(version);
    return {
      source,
      kind: "npm",
      name,
      version,
      identity: `npm:${name}`,
      pinned: version !== null && EXACT_VERSION.test(version),
    };
  }
  if (looksLikeGit(source)) return parseGit(source);

  const basename =
    source
      .split(/[\\/]/)
      .filter((part) => part.length > 0)
      .pop() ?? source;
  return {
    source,
    kind: "path",
    name: basename,
    version: null,
    identity: `path:${source}`,
    pinned: false,
  };
}

export function tryParsePackageSource(raw: string): ParsedPackageSource | null {
  try {
    return parsePackageSource(raw);
  } catch {
    return null;
  }
}

/** A configured package as the hub shows it (never the raw SDK object). */
export interface PackageSummary {
  /** The verbatim settings entry. */
  source: string;
  name: string;
  kind: PackageSourceKind;
  scope: PackageScope;
  /** True when the entry carries per-package resource filters (`extensions`, …). */
  filtered: boolean;
  /** Installed version read from the package's own `package.json`, when available. */
  version: string | null;
  /** True when the source pins an exact npm version or Git ref. */
  pinned: boolean;
  installedPath: string | null;
  /** True when the manager found it under the scope's npm root / Git root. */
  installed: boolean;
}

export interface PackagesSnapshot {
  packages: PackageSummary[];
  loadedAt: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Coerces one untrusted summary (a host response) into a `PackageSummary`. */
export function sanitizePackageSummary(value: unknown): PackageSummary | null {
  const source = record(value);
  const raw = stringOrNull(source.source);
  if (!raw) return null;
  const parsed = tryParsePackageSource(raw);
  if (!parsed) return null;
  return {
    source: parsed.source,
    name: stringOrNull(source.name) ?? parsed.name,
    kind: isPackageSourceKind(source.kind) ? source.kind : parsed.kind,
    scope: isPackageScope(source.scope) ? source.scope : "user",
    filtered: source.filtered === true,
    version: stringOrNull(source.version),
    pinned: source.pinned === true || parsed.pinned,
    installedPath: stringOrNull(source.installedPath),
    installed: source.installed === true,
  };
}

export function sanitizePackageSummaries(value: unknown): PackageSummary[] {
  if (!Array.isArray(value)) return [];
  const summaries: PackageSummary[] = [];
  for (const entry of value) {
    const summary = sanitizePackageSummary(entry);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

export function sanitizePackagesSnapshot(value: unknown): PackagesSnapshot {
  const source = record(value);
  return {
    packages: sanitizePackageSummaries(source.packages),
    loadedAt: typeof source.loadedAt === "number" ? source.loadedAt : 0,
  };
}

/** Progress frames are pushed as `packages.progress` (plan step 14). */
export const PACKAGE_PROGRESS_EVENT = "packages.progress";
/** Pushed after a successful mutation so every open hub can re-read (plan step 14). */
export const PACKAGES_CHANGED_EVENT = "packages.changed";

export type PackageAction = "install" | "remove" | "update" | "clone" | "pull";
export type PackagePhase = "start" | "progress" | "complete" | "error";

const PACKAGE_ACTIONS: readonly PackageAction[] = ["install", "remove", "update", "clone", "pull"];
const PACKAGE_PHASES: readonly PackagePhase[] = ["start", "progress", "complete", "error"];

export interface PackageProgressEvent {
  operationId: string;
  action: PackageAction;
  phase: PackagePhase;
  source: string;
  message?: string;
  /**
   * 0–100 when the phase implies it, `null` while npm reports nothing. npm has
   * no machine-readable percentage, so this is deliberately coarse.
   */
  percent: number | null;
}

export function sanitizePackageProgress(value: unknown): PackageProgressEvent | null {
  const source = record(value);
  if (typeof source.operationId !== "string" || source.operationId.length === 0) return null;
  if (!PACKAGE_ACTIONS.includes(source.action as PackageAction)) return null;
  if (!PACKAGE_PHASES.includes(source.phase as PackagePhase)) return null;
  if (typeof source.source !== "string") return null;
  return {
    operationId: source.operationId,
    action: source.action as PackageAction,
    phase: source.phase as PackagePhase,
    source: source.source,
    ...(typeof source.message === "string" ? { message: source.message } : {}),
    percent: typeof source.percent === "number" ? source.percent : null,
  };
}

/**
 * The acknowledged acknowledgement the installer requires before it touches the system.
 *
 * Extensions run with full system access, so `packages.install`/`packages.update`
 * refuse unless the caller echoes the exact source it showed the user — a
 * "consent dialog cannot be bypassed" is enforced here, not only in the UI.
 */
export interface PackageConsent {
  source: string;
  systemAccess: true;
}

export function isPackageConsent(value: unknown): value is PackageConsent {
  const source = record(value);
  return (
    typeof source.source === "string" && source.source.length > 0 && source.systemAccess === true
  );
}

/**
 * The pinned form of a configured npm package: `npm:name@<installed version>`.
 * A Git or path source has no version to pin to (its ref is already in the
 * source), so this returns null and the UI hides the action.
 */
export function pinnedPackageSource(summary: PackageSummary): string | null {
  if (summary.kind !== "npm" || !summary.version) return null;
  return `npm:${summary.name}@${summary.version}`;
}

/** The floating form of a configured npm package: `npm:name`. */
export function unpinnedPackageSource(summary: PackageSummary): string | null {
  if (summary.kind !== "npm") return null;
  return `npm:${summary.name}`;
}
