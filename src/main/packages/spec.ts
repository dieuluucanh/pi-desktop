/**
 * Pi package source parsing.
 *
 * Mirrors the source forms Pi accepts (`docs/packages.md`): `npm:`, `git:`,
 * plain protocol URLs, local paths, and bare npm names. The parsed `identity`
 * matches Pi's dedupe rule (npm name / git URL without ref / absolute path) so
 * the app never adds a duplicate of a package the terminal already has.
 */

export type PackageSourceKind = "npm" | "git" | "url" | "path";

export interface ParsedPackageSource {
  /** Normalized source string, exactly as it should be written to settings.json. */
  source: string;
  kind: PackageSourceKind;
  /** Dedupe key: npm name, git/url origin without ref, or absolute-ish path. */
  identity: string;
  name: string;
  version: string | null;
  ref: string | null;
  /** True when the spec cannot drift on `pi update` (explicit version or ref). */
  pinned: boolean;
}

export class PackageSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageSourceError";
  }
}

const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function splitNpmSpec(body: string): { name: string; version: string | null } {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw new PackageSourceError("Empty npm package name");

  // Scoped packages: the scope may itself contain '@', so look for a second one.
  const at = trimmed.lastIndexOf("@");
  if (at > 0) {
    const name = trimmed.slice(0, at);
    const version = trimmed.slice(at + 1);
    if (NPM_NAME_RE.test(name) && version.length > 0) return { name, version };
  }
  if (!NPM_NAME_RE.test(trimmed)) {
    throw new PackageSourceError(`Not a valid npm package name: ${trimmed}`);
  }
  return { name: trimmed, version: null };
}

function splitRef(spec: string): { base: string; ref: string | null } {
  const at = spec.lastIndexOf("@");
  // Keep `git@github.com:user/repo` intact: only treat '@' as a ref separator
  // when it is not the leading ssh user marker.
  if (at > 0 && !spec.slice(0, at).endsWith("git")) {
    const ref = spec.slice(at + 1);
    if (ref.length > 0) return { base: spec.slice(0, at), ref };
  }
  return { base: spec, ref: null };
}

function isLocalPath(input: string): boolean {
  return (
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("~/") ||
    input.startsWith("/") ||
    input.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(input)
  );
}

export function parsePackageSource(input: string): ParsedPackageSource {
  const raw = input.trim();
  if (raw.length === 0) throw new PackageSourceError("Empty package source");

  if (raw.startsWith("npm:")) {
    const { name, version } = splitNpmSpec(raw.slice(4));
    return {
      source: `npm:${name}${version ? `@${version}` : ""}`,
      kind: "npm",
      identity: `npm:${name}`,
      name,
      version,
      ref: null,
      pinned: version !== null,
    };
  }

  if (raw.startsWith("git:")) {
    const body = raw.slice(4);
    if (body.length === 0) throw new PackageSourceError("Empty git source");
    const { base, ref } = splitRef(body);
    return {
      source: `git:${base}${ref ? `@${ref}` : ""}`,
      kind: "git",
      identity: `git:${base.replace(/\.git$/i, "").toLowerCase()}`,
      name: base,
      version: null,
      ref,
      pinned: ref !== null,
    };
  }

  if (/^(https?|ssh|git):\/\//i.test(raw)) {
    const { base, ref } = splitRef(raw);
    let identity = base;
    try {
      const parsed = new URL(base);
      // Strip a trailing .git so `repo` and `repo.git` dedupe together.
      identity = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\.git$/i, "")}`;
    } catch {
      identity = base.replace(/\.git$/i, "");
    }
    return {
      source: `${base}${ref ? `@${ref}` : ""}`,
      kind: "url",
      identity: `url:${identity.toLowerCase()}`,
      name: base,
      version: null,
      ref,
      pinned: ref !== null,
    };
  }

  if (isLocalPath(raw)) {
    return {
      source: raw,
      kind: "path",
      identity: `path:${raw.replace(/[\\/]+$/, "")}`,
      name: raw,
      version: null,
      ref: null,
      pinned: true,
    };
  }

  const { name, version } = splitNpmSpec(raw);
  return {
    source: `npm:${name}${version ? `@${version}` : ""}`,
    kind: "npm",
    identity: `npm:${name}`,
    name,
    version,
    ref: null,
    pinned: version !== null,
  };
}

export function tryParsePackageSource(input: string): ParsedPackageSource | null {
  try {
    return parsePackageSource(input);
  } catch {
    return null;
  }
}

/** True when both strings refer to the same package (Pi's dedupe identity). */
export function samePackage(a: string, b: string): boolean {
  const left = tryParsePackageSource(a);
  const right = tryParsePackageSource(b);
  if (!left || !right) return a.trim() === b.trim();
  return left.identity === right.identity;
}

/**
 * Returns the source with an explicit version range. Only npm sources carry a
 * version this way; anything else is returned unchanged.
 */
export function withPinnedVersion(source: string, range: string): string {
  const parsed = parsePackageSource(source);
  if (parsed.kind !== "npm") return parsed.source;
  return `npm:${parsed.name}@${range}`;
}
