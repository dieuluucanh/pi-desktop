/**
 * The "Recommended for Pi Desktop" set.
 *
 * A checked-in, reviewed list — not a remote feed — ordered alphabetically by
 * package name, which is the order the hub and the onboarding step render.
 * Only the Office bridge's package name is verifiable inside this repo, so it is
 * pinned to `PI_OFFICE_BRIDGE.packageName` by a test; every other entry is a
 * plain npm source that the package manager must resolve, and a failure to
 * resolve surfaces on the card instead of installing something else silently.
 *
 * **Workflow is deliberately absent.** The app ships the pinned artifact as
 * `builtin:workflow` (plan step 27), so offering an npm install of the same
 * extension would be a duplicate default that competes with the builtin. A user
 * who deliberately wants the npm/git/profile copy can still install it from the
 * package manager above; an installed copy then replaces the builtin through
 * Pi's own `replaceable` rules. Nothing here installs or rewrites packages.
 *
 * `tests/shared/recommended-packages.test.ts` pins the exact ordered id list, so
 * adding or removing an entry is always a deliberate edit in both places.
 *
 * The hub never hides the source: the exact string passed to the package manager
 * is what the consent dialog shows.
 */

import { PI_OFFICE_BRIDGE } from "./office";

export interface RecommendedPackage {
  /** Stable key for the UI and tests. */
  id: string;
  /** The npm package name (used to detect an existing install). */
  name: string;
  /** The source verbatim, as `packages.install` receives it. */
  source: string;
  description: string;
  /** What it adds to the app, shown as a chip. */
  provides: string;
  /**
   * True for the Office bridge: the only entry whose name this repo can prove
   * (`PI_OFFICE_BRIDGE.packageName`), pinned by
   * `tests/shared/recommended-packages.test.ts`.
   */
  verifiableInRepo: boolean;
  /** The Office bridge is an integration, so it is listed but not installed by default. */
  integration?: boolean;
}

export const RECOMMENDED_PACKAGES: readonly RecommendedPackage[] = [
  {
    id: "dieulc-autocompact",
    name: "@dieulc/autocompact",
    source: "npm:@dieulc/autocompact",
    description: "Compact a long session automatically when context pressure builds.",
    provides: "Auto-compaction",
    verifiableInRepo: false,
  },
  {
    id: "pi-office-bridge",
    name: PI_OFFICE_BRIDGE.packageName,
    source: `npm:${PI_OFFICE_BRIDGE.packageName}`,
    description:
      "Connect Word, Excel and PowerPoint documents to a session: # mentions, office tools and the attached-documents panel.",
    provides: "Office integration",
    verifiableInRepo: true,
    integration: true,
  },
  {
    id: "plannotator",
    name: "@plannotator/pi-extension",
    source: "npm:@plannotator/pi-extension",
    description: "Review plans and code in an annotated web surface opened as an in-app tab.",
    provides: "Plan/code review",
    verifiableInRepo: false,
  },
  {
    id: "pi-lens",
    name: "pi-lens",
    source: "npm:pi-lens",
    description:
      "Real-time code feedback: LSP diagnostics, linters, formatters and type-checking on the code the agent touches.",
    provides: "Code intelligence",
    verifiableInRepo: false,
  },
  {
    id: "pi-memory",
    name: "pi-memory",
    source: "npm:pi-memory",
    description:
      "Persistent memory with semantic search across daily logs, long-term memory and a scratchpad.",
    provides: "Memory",
    verifiableInRepo: false,
  },
  {
    id: "pi-web-access",
    name: "pi-web-access",
    source: "npm:pi-web-access",
    description:
      "Web search, URL and PDF fetching, GitHub repo cloning and video analysis as tools.",
    provides: "Web access",
    verifiableInRepo: false,
  },
];

/** Read-only discovery: there is no `npm run gallery`-style check in this repo. */
export const PACKAGE_GALLERY_URL = "https://pi.dev/packages";

/** The Office entry, pinned to the in-repo bridge name. */
export function officeRecommendedPackage(): RecommendedPackage {
  const found = RECOMMENDED_PACKAGES.find((entry) => entry.verifiableInRepo && entry.integration);
  if (!found) throw new Error("the recommended set lost its Office entry");
  return found;
}

/**
 * The package name inside a `packages` setting entry: strips an `npm:` prefix and
 * a trailing `@version`, but keeps a scope's leading `@`.
 */
export function packageNameOf(entry: string): string {
  const trimmed = entry.trim();
  const withoutPrefix = trimmed.startsWith("npm:") ? trimmed.slice(4) : trimmed;
  const at = withoutPrefix.lastIndexOf("@");
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
}

/** True when a recommended package already appears in the `packages` settings. */
export function isRecommendedInstalled(
  entry: RecommendedPackage,
  packages: readonly string[],
): boolean {
  return packages.some((raw) => packageNameOf(raw) === entry.name);
}
