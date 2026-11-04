/**
 * Integrations (plan step 19).
 *
 * Pi for Office is the first *integration*: an optional add-on that installs a
 * Pi package, touches the machine (a registry sideload on Windows) and then
 * connects a live bridge. The Extensions hub's Integrations card is the only
 * Office surface in the app (plan D-A10), and everything it shows is derived
 * here from data the app already has — the wizard's `OfficeSetupView` and the
 * package manager's installed list — so the card itself stays presentational.
 *
 * Nothing in this module imports Electron or the host: it is pure, shared
 * between the main process (the app-state record) and the renderer (the card).
 */

import { PI_OFFICE_BRIDGE, bridgeSupportsManualLifecycle } from "./office";
import type { OfficeSetupView } from "./office-setup";
import { packageNameOf } from "./recommended-packages";

/** The stable id of the Office integration in app state. */
export const OFFICE_INTEGRATION_ID = "pi-office";

/**
 * The source the package manager receives for the bridge: the pinned npm spec
 * the wizard installs, so both paths write the same settings entry.
 */
export function officeBridgePackageSource(): string {
  return `npm:${PI_OFFICE_BRIDGE.packageName}@${PI_OFFICE_BRIDGE.pinnedVersion}`;
}

export function officeBridgePackageName(): string {
  return PI_OFFICE_BRIDGE.packageName;
}

/** Where the integration stands, in one word, for the card's badge. */
export type OfficeIntegrationStatus = "not-installed" | "installed" | "connected" | "attention";

/** Whether the installed bridge can be connected/disconnected on demand. */
export type OfficeBridgeLifecycle = "manual" | "legacy" | "unknown";

export interface OfficeIntegrationFacts {
  packageName: string;
  /** The pinned source as the package manager and the consent dialog see it. */
  source: string;
  pinnedVersion: string;
  installed: boolean;
  installedVersion: string | null;
  /** The package scope the bridge lives in, when known. */
  scope: string | null;
  /** The wizard's last bridge-package result, or "unknown" before it has run. */
  bridgeStatus: string;
  /** 0.6+ stays off until connected; older bridges auto-start. */
  lifecycle: OfficeBridgeLifecycle;
  protocolVersion: number | null;
  catalogVersion: number | null;
  sideloaded: boolean;
  port: number;
  /** The last `/health` result: `ok`, `unreachable`, …; null before a probe. */
  healthStatus: string | null;
  healthUrl: string | null;
  /** When detection last ran (the wizard's evidence timestamp), if ever. */
  checkedAt: string | null;
  status: OfficeIntegrationStatus;
}

/**
 * The bridge package as the package manager reports it, if configured at all.
 * A package whose source is the bridge name but which is not installed still
 * counts as configured — the card says "not installed" rather than "unknown".
 */
export interface OfficeBridgePackageLookup {
  configured: boolean;
  installed: boolean;
  version: string | null;
  scope: string | null;
}

/** Looks the bridge up in a package list, tolerating any pinned/loose source. */
export function findOfficeBridgePackage(
  packages: readonly {
    name: string;
    version?: string | null;
    scope?: string;
    installed?: boolean;
  }[],
): OfficeBridgePackageLookup {
  const name = PI_OFFICE_BRIDGE.packageName;
  for (const entry of packages) {
    if (packageNameOf(entry.name) !== name) continue;
    return {
      configured: true,
      installed: entry.installed === true,
      version: entry.version ?? null,
      scope: entry.scope ?? null,
    };
  }
  return { configured: false, installed: false, version: null, scope: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Derives the card's facts from the wizard view (which may be null before any
 * setup has run) and the installed package list.
 *
 * The package list is the *durable* install state: the wizard installs through
 * the same package manager, so a bridge installed by terminal Pi is picked up
 * here without the wizard having run in this app session.
 */
export function deriveOfficeIntegrationFacts(input: {
  view: OfficeSetupView | null;
  packages: readonly {
    name: string;
    version?: string | null;
    scope?: string;
    installed?: boolean;
  }[];
}): OfficeIntegrationFacts {
  const lookup = findOfficeBridgePackage(input.packages);
  const view = input.view;

  const installed =
    lookup.installed || (view?.bridge?.status != null && view.bridge.status !== "failed");
  const installedVersion = view?.bridge?.version ?? lookup.version;
  const lifecycleVersion = view?.health?.serverVersion ?? installedVersion;
  const lifecycle: OfficeBridgeLifecycle = !installed
    ? "unknown"
    : lifecycleVersion === null
      ? "unknown"
      : bridgeSupportsManualLifecycle(lifecycleVersion)
        ? "manual"
        : "legacy";
  const bridgeStatus = view?.bridge?.status ?? (lookup.installed ? "installed" : "unknown");
  const healthStatus = stringOrNull(view?.health?.status);
  const port = typeof view?.port === "number" ? view.port : PI_OFFICE_BRIDGE.defaultPort;
  const sideloaded = view?.detection?.sideloaded === true;

  let status: OfficeIntegrationStatus;
  if (!installed) {
    status = "not-installed";
  } else if (healthStatus === "ok") {
    status = "connected";
  } else if (
    view?.status === "failed" ||
    view?.health?.portConflict === true ||
    (healthStatus !== null && healthStatus !== "ok") ||
    view?.compatibility?.shape === "unsupported"
  ) {
    status = "attention";
  } else {
    status = "installed";
  }

  return {
    packageName: PI_OFFICE_BRIDGE.packageName,
    source: officeBridgePackageSource(),
    pinnedVersion: PI_OFFICE_BRIDGE.pinnedVersion,
    installed,
    installedVersion: installedVersion ?? null,
    scope: lookup.scope,
    bridgeStatus,
    lifecycle,
    protocolVersion: numberOrNull(view?.health?.protocolVersion),
    catalogVersion: numberOrNull(view?.health?.catalogVersion),
    sideloaded,
    port,
    healthStatus,
    healthUrl: stringOrNull(view?.health?.url),
    checkedAt: stringOrNull(view?.detection?.checkedAt),
    status,
  };
}

/**
 * The app-state record of the Office integration (plan step 19).
 *
 * The package manager already records *whether* the bridge is installed (it is
 * a `packages` entry in Pi's settings.json). This record is the app's own note
 * that the user consented to that install and when the wizard last completed,
 * so the card can be honest about "installed by this app" without re-reading a
 * timestamp from npm.
 */
export interface OfficeIntegrationRecord {
  /** ISO timestamp of the consented bridge install, or null. */
  bridgeInstalledAt: string | null;
  /** ISO timestamp the setup wizard last reached its final step, or null. */
  lastSetupAt: string | null;
}

export interface IntegrationsState {
  office: OfficeIntegrationRecord;
}

export const EMPTY_OFFICE_INTEGRATION: OfficeIntegrationRecord = {
  bridgeInstalledAt: null,
  lastSetupAt: null,
};

export function emptyIntegrationsState(): IntegrationsState {
  return { office: { ...EMPTY_OFFICE_INTEGRATION } };
}

/** Keeps only an ISO-looking, bounded timestamp; anything else is dropped. */
function sanitizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (Number.isNaN(Date.parse(trimmed))) return null;
  return trimmed;
}

export function sanitizeOfficeIntegrationRecord(input: unknown): OfficeIntegrationRecord {
  const source = asRecord(input);
  return {
    bridgeInstalledAt: sanitizeTimestamp(source.bridgeInstalledAt),
    lastSetupAt: sanitizeTimestamp(source.lastSetupAt),
  };
}

export function sanitizeIntegrationsState(input: unknown): IntegrationsState {
  const source = asRecord(input);
  return { office: sanitizeOfficeIntegrationRecord(source.office) };
}

export type OfficeIntegrationRecordPatch = Partial<OfficeIntegrationRecord>;

/**
 * Applies a validated patch, where `undefined` keeps the current value and a
 * timestamp (or null) replaces it. Unknown keys never reach the store.
 */
export function applyOfficeIntegrationPatch(
  current: OfficeIntegrationRecord,
  patch: unknown,
): OfficeIntegrationRecord {
  const record = asRecord(patch);
  const next: OfficeIntegrationRecord = { ...current };
  if ("bridgeInstalledAt" in record) {
    next.bridgeInstalledAt = sanitizeTimestamp(record.bridgeInstalledAt);
  }
  if ("lastSetupAt" in record) {
    next.lastSetupAt = sanitizeTimestamp(record.lastSetupAt);
  }
  return next;
}
