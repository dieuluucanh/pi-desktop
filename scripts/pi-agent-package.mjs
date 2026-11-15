/**
 * Pi agent pin arithmetic (2026-11-15 update-channels plan, step 9).
 *
 * Pure helpers for `scripts/pi-agent.mjs`, in the style of
 * `scripts/extension-package.mjs`: **no imports at all**, so the release
 * workflow's `prepare` job can run the status check without `npm ci`.
 *
 * The invariant this module exists to protect: the app pins the SDK family and
 * `typebox` to exactly what `@earendil-works/pi-coding-agent` itself declares.
 * Pi's own manifest is therefore the source of every target version — nothing
 * here guesses a sibling or a typebox bump.
 */

/** The package whose published version is "the Pi agent version". */
export const PI_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";

/** Every package pinned in lockstep with the SDK. */
export const PI_AGENT_FAMILY = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
];

/** The SDK's TypeBox version must match the app's, or extensions see two runtimes. */
export const TYPEBOX_PACKAGE = "typebox";

/** A pin/doc problem the CLI reports instead of guessing. */
export class PiAgentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PiAgentError";
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function semverParts(version) {
  if (typeof version !== "string") return null;
  const match = SEMVER.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** True for an exact version (`1.2.3`, `1.2.3-beta.1`), never a range. */
export function isExactVersion(value) {
  return semverParts(value) !== null;
}

/** The major number of a version, or null when it does not parse. */
export function majorOf(version) {
  return semverParts(version)?.major ?? null;
}

/** The pins declared in an app `package.json`. Missing entries are `null`. */
export function readPiPins(manifest) {
  const dependencies =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? manifest.dependencies
      : undefined;
  const deps =
    dependencies && typeof dependencies === "object" && !Array.isArray(dependencies)
      ? dependencies
      : {};
  /** @type {Record<string, string | null>} */
  const family = {};
  for (const name of PI_AGENT_FAMILY) {
    family[name] = typeof deps[name] === "string" ? deps[name] : null;
  }
  return {
    family,
    typebox: typeof deps[TYPEBOX_PACKAGE] === "string" ? deps[TYPEBOX_PACKAGE] : null,
  };
}

function compareParts(left, right) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * Where the local pin stands relative to the registry's `latest`.
 *
 * - `in-sync`       the pulled version is what ships;
 * - `behind`        a newer minor/patch exists (safe to bump automatically);
 * - `major-behind`  a newer major exists (a human decision);
 * - `local-ahead`   the pin is newer than `latest` (a pre-release branch — never
 *                   downgrade);
 * - `registry-error` one of the two versions does not parse.
 */
export function classifyPiStatus(current, latest) {
  const local = semverParts(current);
  const remote = semverParts(latest);
  if (!local || !remote) return "registry-error";
  const order = compareParts(local, remote);
  if (order === 0) {
    // A stable release supersedes a pre-release with the same numbers.
    return local.prerelease && !remote.prerelease ? "behind" : "in-sync";
  }
  if (order > 0) return "local-ahead";
  return remote.major > local.major ? "major-behind" : "behind";
}

/**
 * The pins to write for a target SDK version, taken from the SDK's own
 * published `dependencies`.
 *
 * Refuses rather than guesses: if the SDK does not pin its siblings to the same
 * version, or no longer pins `typebox` exactly, the safe answer is a human
 * looking at the release notes.
 */
export function resolveTargetPins({ sdkVersion, sdkDependencies }) {
  if (!isExactVersion(sdkVersion)) {
    throw new PiAgentError(`the target Pi agent version is not exact: ${String(sdkVersion)}`);
  }
  if (!sdkDependencies || typeof sdkDependencies !== "object" || Array.isArray(sdkDependencies)) {
    throw new PiAgentError("the SDK manifest has no dependencies object");
  }
  /** @type {Record<string, string>} */
  const family = { [PI_AGENT_PACKAGE]: sdkVersion };
  for (const name of PI_AGENT_FAMILY) {
    if (name === PI_AGENT_PACKAGE) continue;
    const declared = sdkDependencies[name];
    if (typeof declared !== "string" || !isExactVersion(declared)) {
      throw new PiAgentError(
        `${PI_AGENT_PACKAGE}@${sdkVersion} does not pin ${name} to an exact version (got ${String(declared)})`,
      );
    }
    if (declared !== sdkVersion) {
      throw new PiAgentError(
        `${PI_AGENT_PACKAGE}@${sdkVersion} pins ${name}@${declared}; the family must move together`,
      );
    }
    family[name] = declared;
  }
  const typebox = sdkDependencies[TYPEBOX_PACKAGE];
  if (typeof typebox !== "string" || !isExactVersion(typebox)) {
    throw new PiAgentError(
      `${PI_AGENT_PACKAGE}@${sdkVersion} does not pin ${TYPEBOX_PACKAGE} exactly (got ${String(
        typebox,
      )})`,
    );
  }
  return { family, typebox };
}

/** A copy of `manifest` with the family and typebox pins set to `pins`. */
export function rewritePiPins(manifest, pins) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new PiAgentError("package.json is not an object");
  }
  const dependencies = manifest.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new PiAgentError("package.json has no dependencies object");
  }
  const next = structuredClone(manifest);
  /** @type {Array<{ name: string; from: string | null; to: string }>} */
  const changed = [];
  const assign = (name, to) => {
    const from = typeof next.dependencies[name] === "string" ? next.dependencies[name] : null;
    if (from === to) return;
    next.dependencies[name] = to;
    changed.push({ name, from, to });
  };
  for (const name of PI_AGENT_FAMILY) {
    const to = pins.family[name];
    if (typeof to !== "string") throw new PiAgentError(`the target pins are missing ${name}`);
    assign(name, to);
  }
  if (typeof pins.typebox !== "string") {
    throw new PiAgentError(`the target pins are missing ${TYPEBOX_PACKAGE}`);
  }
  assign(TYPEBOX_PACKAGE, pins.typebox);
  return { manifest: next, changed };
}

/** The row name prefixes `docs/architecture/versions.md` is expected to carry. */
const VERSIONS_DOC_ROWS = [
  `\`${PI_AGENT_PACKAGE}\``,
  "`@earendil-works/pi-agent-core`",
  `\`${TYPEBOX_PACKAGE}\``,
];

/** Replaces the second cell of one markdown table row, keeping the width. */
function replaceVersionCell(line, value) {
  const parts = line.split("|");
  if (parts.length < 4) return line;
  const current = parts[2] ?? "";
  const formatted = ` \`${value}\` (exact) `;
  parts[2] =
    formatted.length >= current.length
      ? formatted
      : formatted + " ".repeat(current.length - formatted.length);
  return parts.join("|");
}

/**
 * Rewrites the three pin rows in the versions document.
 *
 * The rows are matched by their first cell, so a wording change elsewhere in
 * the table does not matter. A missing row throws: the document is the pin
 * registry, and letting it drift silently is the failure this plan fixes.
 */
export function renderVersionsDoc(text, pins) {
  if (typeof text !== "string") throw new PiAgentError("the versions document is not text");
  const familyVersion = pins.family[PI_AGENT_PACKAGE];
  if (typeof familyVersion !== "string" || typeof pins.typebox !== "string") {
    throw new PiAgentError("the target pins are incomplete");
  }
  const lines = text.split("\n");
  const wanted = new Map([
    [VERSIONS_DOC_ROWS[0], familyVersion],
    [VERSIONS_DOC_ROWS[1], familyVersion],
    [VERSIONS_DOC_ROWS[2], pins.typebox],
  ]);
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("|")) continue;
    for (const [prefix, version] of wanted) {
      if (!line.startsWith(`| ${prefix}`)) continue;
      lines[index] = replaceVersionCell(line, version);
      seen.add(prefix);
    }
  }
  for (const prefix of wanted.keys()) {
    if (!seen.has(prefix)) {
      throw new PiAgentError(`docs/architecture/versions.md is missing the ${prefix} row`);
    }
  }
  return lines.join("\n");
}

/**
 * The lowest Node version an `engines.node` range admits, for the bundled
 * runtime comparison. Only the comparators the SDK actually uses are parsed; an
 * unrecognised range returns `null` so the caller can warn instead of guess.
 */
export function enginesFloor(range) {
  if (typeof range !== "string") return null;
  const match = /^(>=|>|\^|~|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\s|$)/.exec(range.trim());
  if (!match) return null;
  const major = Number(match[2]);
  const minor = Number(match[3] ?? 0);
  const patch = Number(match[4] ?? 0);
  if (![major, minor, patch].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return { operator: match[1] ?? "=", version: `${major}.${minor}.${patch}` };
}

/**
 * Whether `nodeVersion` satisfies `range`.
 *
 * `null` means "cannot decide" (an unparseable range or version), which the CLI
 * reports as a warning rather than failing a bump on a range it does not know.
 */
export function satisfiesFloor(nodeVersion, range) {
  const node = semverParts(nodeVersion);
  const floor = enginesFloor(range);
  if (!node || !floor) return null;
  const target = semverParts(floor.version);
  if (!target) return null;
  const order = compareParts(node, target);
  switch (floor.operator) {
    case ">":
      return order > 0;
    case "=":
      return order === 0;
    case "^":
      return node.major === target.major && order >= 0;
    case "~":
      return node.major === target.major && node.minor === target.minor && order >= 0;
    default:
      return order >= 0;
  }
}
