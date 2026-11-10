/**
 * The "Recommended for Pi Desktop" set (plan step 13).
 *
 * A checked-in, reviewable list — not a remote feed. Only the Office bridge's
 * package name is verifiable inside this repo, so it is pinned to
 * `PI_OFFICE_BRIDGE.packageName` by a test; every other entry is a plain npm
 * source that the package manager (plan step 14) must resolve, and a failure to
 * resolve surfaces on the card instead of installing something else silently.
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
    id: "dieulc-workflow",
    name: "@dieulc/workflow",
    source: "npm:@dieulc/workflow",
    description:
      "Plan, review and build workflows with a questionnaire and a decision gate rendered in the app.",
    provides: "Plan/Review workflow",
    verifiableInRepo: false,
  },
  {
    id: "dieulc-autocompact",
    name: "@dieulc/autocompact",
    source: "npm:@dieulc/autocompact",
    description: "Compact a long session automatically when context pressure builds.",
    provides: "Auto-compaction",
    verifiableInRepo: false,
  },
  {
    id: "dieulc-server-logs",
    name: "@dieulc/server-logs",
    source: "npm:@dieulc/server-logs",
    description: "Tail server logs into the session as a tool.",
    provides: "Server logs",
    verifiableInRepo: false,
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
    id: "commandcode-provider",
    name: "pi-commandcode-provider",
    source: "npm:pi-commandcode-provider",
    description:
      "Command Code provider with per-model wire routing (Responses when advertised), reasoning normalization and redacted diagnostics.",
    provides: "Command Code provider",
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
