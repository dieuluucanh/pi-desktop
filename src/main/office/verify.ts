/**
 * Step 4 of the Pi for Office setup wizard: open Office and verify the bridge.
 *
 * Verification is evidence-based: the app polls the bridge's `GET /health`
 * endpoint until a pane (the task-pane add-in) attaches, and distinguishes
 * "nothing is listening" from "something else owns the port". The checklist is a
 * pure function of the wizard state, so the UI can render progress live.
 */

import {
  PI_FOR_OFFICE,
  PI_OFFICE_BRIDGE,
  officeHostLabel,
  type OfficeHost,
} from "../../shared/office";
import type { BridgeInstallStatus } from "./bridge-install";
import type { OfficeDetectionResult, OfficeOs } from "./types";

export interface BridgePane {
  clientName: string | null;
  host: OfficeHost | null;
  documentId: string | null;
  documentName: string | null;
  focused: boolean;
  visible: boolean;
  windows: number;
  ops: number;
  model: string | null;
  provider: string | null;
}

export interface BridgeHealth {
  serverName: string;
  serverVersion: string | null;
  piVersion: string | null;
  protocolVersion: number | null;
  catalogVersion: number | null;
  capabilities: string[];
  panes: BridgePane[];
  raw: unknown;
}

export interface BridgeHealthCheck {
  status: "ok" | "unreachable" | "not-our-bridge" | "invalid-response";
  url: string;
  httpStatus: number | null;
  health: BridgeHealth | null;
  /** Something answered on the port, but it is not the Pi Office bridge. */
  portConflict: boolean;
  error: string | null;
  durationMs: number;
}

export type FetchLike = (
  url: string,
  options?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json?(): Promise<unknown>;
}>;

export interface VerifyDeps {
  fetch: FetchLike;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function createDefaultVerifyDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    // SAFETY: global fetch matches FetchLike at runtime; the double cast only
    // bridges the wider DOM/undici `Response` return type (non-optional
    // `headers`, `json(): Promise<any>`), which fails structural comparison.
    fetch: globalThis.fetch as unknown as FetchLike,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  };
}

export function bridgeHealthUrl(port: number = PI_OFFICE_BRIDGE.defaultPort): string {
  return `http://127.0.0.1:${port}${PI_OFFICE_BRIDGE.healthPath}`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asHost(value: unknown): OfficeHost | null {
  return value === "excel" || value === "word" || value === "powerpoint" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Parses the bridge's `/health` payload (protocol v2 shape). */
export function parseBridgeHealth(payload: unknown): BridgeHealth | null {
  const root = asRecord(payload);
  if (!root) return null;

  const rawPanes = Array.isArray(root.panes) ? root.panes : [];
  const panes: BridgePane[] = [];
  for (const candidate of rawPanes) {
    const pane = asRecord(candidate);
    if (!pane) continue;
    panes.push({
      clientName: asString(pane.clientName),
      host: asHost(pane.host),
      documentId: asString(pane.documentId),
      documentName: asString(pane.documentName),
      focused: asBoolean(pane.focused),
      visible: asBoolean(pane.visible),
      windows: asNumber(pane.windows) ?? 1,
      ops: asNumber(pane.ops) ?? (Array.isArray(pane.ops) ? pane.ops.length : 0),
      model: asString(pane.model),
      provider: asString(pane.provider),
    });
  }

  const capabilities = Array.isArray(root.capabilities)
    ? root.capabilities.filter((entry): entry is string => typeof entry === "string")
    : [];

  return {
    // The bridge reports its identity as `service` in the HTTP health payload
    // (bridge 0.5.0) and as `serverName` in the welcome/handshake shape; accept
    // both so a version skew cannot make the app disown its own bridge.
    serverName: asString(root.serverName) ?? asString(root.service) ?? "",
    serverVersion: asString(root.serverVersion),
    piVersion: asString(root.piVersion),
    protocolVersion: asNumber(root.protocolVersion),
    catalogVersion: asNumber(root.catalogVersion),
    capabilities,
    panes,
    raw: payload,
  };
}

export async function checkBridgeHealth(
  deps: VerifyDeps,
  options: { port?: number; timeoutMs?: number } = {},
): Promise<BridgeHealthCheck> {
  const port = options.port ?? PI_OFFICE_BRIDGE.defaultPort;
  const url = bridgeHealthUrl(port);
  const startedAt = deps.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);

  const finish = (
    status: BridgeHealthCheck["status"],
    extra: Partial<BridgeHealthCheck> = {},
  ): BridgeHealthCheck => ({
    status,
    url,
    httpStatus: extra.httpStatus ?? null,
    health: extra.health ?? null,
    portConflict: extra.portConflict ?? false,
    error: extra.error ?? null,
    durationMs: deps.now() - startedAt,
  });

  try {
    const response = await deps.fetch(url, { signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }

    const health = parseBridgeHealth(payload);
    if (!health || health.serverName !== "pi-office-bridge") {
      const source = health?.serverName ?? "(unknown)";
      return finish("not-our-bridge", {
        httpStatus: response.status,
        health,
        portConflict: true,
        error:
          response.status === 200 && !health
            ? `Port ${port} answered with a non-JSON body; another program may be using it.`
            : `Port ${port} is served by "${source}" instead of the Pi Office bridge.`,
      });
    }

    return finish("ok", { httpStatus: response.status, health });
  } catch (error) {
    const aborted = controller.signal.aborted;
    return finish("unreachable", {
      error: aborted
        ? `No response from ${url} within the timeout (the Pi session may not be running the bridge).`
        : `${url} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export interface WaitForPaneOptions {
  port?: number;
  /** Only accept a pane from one of these Office hosts. */
  hosts?: readonly OfficeHost[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onPoll?: (check: BridgeHealthCheck, elapsedMs: number) => void;
  requestTimeoutMs?: number;
}

export interface WaitForPaneResult {
  status: "attached" | "timeout" | "aborted";
  check: BridgeHealthCheck | null;
  panes: BridgePane[];
  polls: number;
  waitedMs: number;
  error: string | null;
}

/** Polls `/health` until the task pane connects (or the deadline passes). */
export async function waitForPane(
  deps: VerifyDeps,
  options: WaitForPaneOptions = {},
): Promise<WaitForPaneResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const startedAt = deps.now();
  let polls = 0;
  let lastCheck: BridgeHealthCheck | null = null;

  for (;;) {
    if (options.signal?.aborted) {
      return {
        status: "aborted",
        check: lastCheck,
        panes: lastCheck?.health?.panes ?? [],
        polls,
        waitedMs: deps.now() - startedAt,
        error: "Verification was cancelled.",
      };
    }

    lastCheck = await checkBridgeHealth(deps, {
      port: options.port,
      ...(options.requestTimeoutMs !== undefined ? { timeoutMs: options.requestTimeoutMs } : {}),
    });
    polls += 1;
    const elapsed = deps.now() - startedAt;
    options.onPoll?.(lastCheck, elapsed);

    const panes = lastCheck.health?.panes ?? [];
    const matching =
      options.hosts && options.hosts.length > 0
        ? panes.filter((pane) => pane.host !== null && options.hosts?.includes(pane.host))
        : panes;
    if (matching.length > 0) {
      return {
        status: "attached",
        check: lastCheck,
        panes: matching,
        polls,
        waitedMs: elapsed,
        error: null,
      };
    }

    if (elapsed >= timeoutMs) {
      return {
        status: "timeout",
        check: lastCheck,
        panes,
        polls,
        waitedMs: elapsed,
        error: lastCheck.portConflict
          ? lastCheck.error
          : `No Office document connected to the Pi bridge within ${Math.round(timeoutMs / 1000)}s.`,
      };
    }

    await deps.sleep(pollIntervalMs);
  }
}

export interface OpenOfficeResult {
  ok: boolean;
  host: OfficeHost;
  path: string | null;
  usedWebFallback: boolean;
  note: string | null;
  error: string | null;
}

export interface OpenOfficeOptions {
  host: OfficeHost;
  detection: OfficeDetectionResult;
  /** Electron's `shell.openPath`; resolves to "" on success. */
  openPath?: (path: string) => Promise<string>;
  /** Electron's `shell.openExternal`. */
  openExternal?: (url: string) => Promise<void>;
}

export async function openOfficeHost(options: OpenOfficeOptions): Promise<OpenOfficeResult> {
  const label = officeHostLabel(options.host);
  const app = options.detection.apps.find((candidate) => candidate.host === options.host) ?? null;
  const base: Pick<OpenOfficeResult, "host"> = { host: options.host };

  if (app?.installed && app.executablePath && options.openPath) {
    try {
      const failure = await options.openPath(app.executablePath);
      if (!failure) {
        return {
          ...base,
          ok: true,
          path: app.executablePath,
          usedWebFallback: false,
          note: null,
          error: null,
        };
      }
      return {
        ...base,
        ok: false,
        path: app.executablePath,
        usedWebFallback: false,
        note: null,
        error: `Could not launch ${label}: ${failure}`,
      };
    } catch (error) {
      return {
        ...base,
        ok: false,
        path: app.executablePath,
        usedWebFallback: false,
        note: null,
        error: `Could not launch ${label}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const webNote = app?.installed
    ? `${label} is installed but its executable path is unknown; opened Office on the web instead.`
    : `${label} was not detected on this machine; opened Office on the web instead.`;

  if (options.openExternal) {
    try {
      await options.openExternal(PI_FOR_OFFICE.officeOnTheWebUrl);
      return {
        ...base,
        ok: true,
        path: null,
        usedWebFallback: true,
        note: webNote,
        error: null,
      };
    } catch (error) {
      return {
        ...base,
        ok: false,
        path: null,
        usedWebFallback: true,
        note: webNote,
        error: `Could not open ${PI_FOR_OFFICE.officeOnTheWebUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return {
    ...base,
    ok: false,
    path: null,
    usedWebFallback: false,
    note: webNote,
    error: `No way to open ${label}.`,
  };
}

/* --------------------------------------------------------------- checklist */

export type ChecklistStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export interface ChecklistStep {
  id:
    "detect" | "bridge-package" | "sideload" | "open-office" | "bridge-listening" | "pane-attached";
  title: string;
  status: ChecklistStatus;
  detail: string;
  actions: string[];
}

export interface ChecklistInput {
  detection: OfficeDetectionResult | null;
  bridge: {
    status: BridgeInstallStatus;
    packageName: string;
    version: string | null;
    error: string | null;
  } | null;
  sideload: {
    ok: boolean;
    verified: boolean;
    error: string | null;
    platform: OfficeOs;
  } | null;
  openOffice: OpenOfficeResult | null;
  health: BridgeHealthCheck | null;
  panes: readonly BridgePane[];
}

/** Pure projection of wizard state into the live checklist the panel renders. */
export function buildSetupChecklist(input: ChecklistInput): ChecklistStep[] {
  const steps: ChecklistStep[] = [];
  const detection = input.detection;

  steps.push({
    id: "detect",
    title: "Detect Office on this machine",
    status: detection === null ? "pending" : detection.supported ? "ok" : "failed",
    detail: detection
      ? detection.supported
        ? `${
            detection.apps
              .filter((app) => app.installed)
              .map((app) => app.label)
              .join(", ") || "no Office apps"
          } detected${detection.office.version ? ` (Office ${detection.office.version})` : ""}`
        : "Desktop Office is unavailable on this platform."
      : "Not started.",
    actions: detection?.officeOnTheWeb.recommended
      ? [`Install or open Office: ${PI_FOR_OFFICE.officeOnTheWebUrl}`]
      : [],
  });

  const bridge = input.bridge;
  steps.push({
    id: "bridge-package",
    title: `Install ${PI_OFFICE_BRIDGE.packageName}`,
    status:
      bridge === null
        ? "pending"
        : bridge.status === "failed"
          ? "failed"
          : bridge.status === "already-installed"
            ? "ok"
            : "ok",
    detail:
      bridge === null
        ? "Not started."
        : bridge.status === "failed"
          ? (bridge.error ?? "Install failed.")
          : `${bridge.packageName}${bridge.version ? `@${bridge.version}` : ""} is installed and pinned.`,
    actions:
      bridge?.status === "failed"
        ? ["Check your network/proxy and retry.", "Then re-run this step."]
        : [],
  });

  const sideload = input.sideload;
  steps.push({
    id: "sideload",
    title:
      sideload?.platform === "macos"
        ? "Add the add-in to Office (macOS wef folder)"
        : "Add the add-in to Office (sideload)",
    status: sideload === null ? "pending" : sideload.ok && sideload.verified ? "ok" : "failed",
    detail:
      sideload === null
        ? "Not started."
        : sideload.ok && sideload.verified
          ? "The add-in manifest is registered and detected."
          : (sideload.error ?? "Sideloading did not complete."),
    actions:
      sideload && !(sideload.ok && sideload.verified)
        ? [
            "Re-run the sideload step (it is idempotent).",
            `Manual fallback: Insert → My Add-ins → Upload My Add-in… in ${officeHostLabel("excel")}/Word/PowerPoint.`,
          ]
        : [],
  });

  const opened = input.openOffice;
  steps.push({
    id: "open-office",
    title: "Open an Office app",
    status: opened === null ? "pending" : opened.ok ? "ok" : "failed",
    detail:
      opened === null
        ? "Not started."
        : opened.ok
          ? opened.usedWebFallback
            ? (opened.note ?? "Opened Office on the web.")
            : `Launched ${officeHostLabel(opened.host)}.`
          : (opened.error ?? "Could not open Office."),
    actions: opened && !opened.ok ? ["Open the Office app manually and continue."] : [],
  });

  const health = input.health;
  steps.push({
    id: "bridge-listening",
    title: `Bridge listening on port ${PI_OFFICE_BRIDGE.defaultPort}`,
    status:
      health === null
        ? "pending"
        : health.status === "ok"
          ? "ok"
          : health.status === "not-our-bridge"
            ? "failed"
            : "running",
    detail:
      health === null
        ? "Waiting for the Pi session to start the bridge."
        : health.status === "ok"
          ? `${health.health?.serverName}${health.health?.serverVersion ? ` v${health.health.serverVersion}` : ""} (protocol v${health.health?.protocolVersion ?? "?"}, catalog v${health.health?.catalogVersion ?? "?"})`
          : (health.error ?? "Not reachable yet."),
    actions: health?.portConflict
      ? [
          `Something else is using port ${PI_OFFICE_BRIDGE.defaultPort}. Close it, or set ${PI_OFFICE_BRIDGE.envPort} for the Office session.`,
        ]
      : health && health.status === "unreachable"
        ? ["Make sure the Pi for Office session is running (a session hosts the bridge)."]
        : [],
  });

  const panes = input.panes;
  steps.push({
    id: "pane-attached",
    title: "Task pane connected",
    status: panes.length > 0 ? "ok" : input.openOffice?.ok ? "running" : "pending",
    detail:
      panes.length > 0
        ? panes
            .map((pane) => {
              const host = pane.host ? officeHostLabel(pane.host) : "Office";
              const name = pane.documentName ?? pane.documentId ?? "document";
              return `${host} · ${name}${pane.focused ? " (focused)" : ""}`;
            })
            .join("; ")
        : "Open Pi for Office from Insert → My Add-ins (or the Home-ribbon Add-ins button) in an Office app.",
    actions:
      panes.length === 0 && input.openOffice?.ok
        ? [
            "Insert → My Add-ins → Pi for Office.",
            "If it is missing, restart the Office app so the manifest is re-read.",
          ]
        : [],
  });

  return steps;
}

export function checklistFailed(step: ChecklistStep): boolean {
  return step.status === "failed";
}
