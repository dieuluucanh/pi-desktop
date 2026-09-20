/**
 * Live Office pane registry (plan step 20).
 *
 * The bridge extension publishes its attached panes on `GET /health`. The
 * Documents panel, the `#` completion source and the office tool cards all need
 * that registry continuously, not only while the setup wizard is open, so this
 * service owns one background poll of the Office host's port and pushes the
 * projected view (`parseOfficeDocumentsView`) to the renderer.
 *
 * Electron-free (AGENTS rule 1): the probe goes through the same injected
 * `VerifyDeps` the wizard uses, and the timer is the only platform dependency.
 */

import {
  emptyOfficeDocumentsView,
  parseOfficeDocumentsView,
  type OfficeDocumentsView,
} from "../../shared/office-documents";
import { PI_OFFICE_BRIDGE } from "../../shared/office";
import { checkBridgeHealth, createDefaultVerifyDeps, type VerifyDeps } from "./verify";

/** How often the registry is re-probed while the app runs. */
export const DEFAULT_DOCUMENTS_POLL_MS = 5_000;

export interface OfficeDocumentsServiceOptions {
  /** Bridge port to probe. Defaults to the Office host's port (38617). */
  port?: number;
  /** Injected probe (tests substitute a fake fetch/clock). */
  verify?: VerifyDeps;
  /** Injectable clock; must agree with `verify.now` when both are given. */
  now?: () => number;
  /** Poll interval in ms. */
  intervalMs?: number;
  /** Called whenever the projected view changes. */
  onView?: (view: OfficeDocumentsView) => void;
}

export interface OfficeDocumentsService {
  readonly port: number;
  /** The last projected view; never null (an empty view before the first probe). */
  get(): OfficeDocumentsView;
  /** Probes once and resolves with the new view. */
  refresh(): Promise<OfficeDocumentsView>;
  /** Starts the background poll (idempotent). */
  start(): void;
  /** Stops the background poll (idempotent). */
  stop(): void;
  dispose(): void;
}

/** A cheap change signature: everything except the probe timestamp. */
function signatureOf(view: OfficeDocumentsView): string {
  return JSON.stringify({
    available: view.available,
    status: view.status,
    serverVersion: view.serverVersion,
    protocolVersion: view.protocolVersion,
    catalogVersion: view.catalogVersion,
    error: view.error,
    panes: view.panes,
  });
}

export function createOfficeDocumentsService(
  options: OfficeDocumentsServiceOptions = {},
): OfficeDocumentsService {
  const port = options.port ?? PI_OFFICE_BRIDGE.defaultPort;
  const verify = options.verify ?? createDefaultVerifyDeps();
  const now = options.now ?? ((): number => Date.now());
  const intervalMs = options.intervalMs ?? DEFAULT_DOCUMENTS_POLL_MS;

  let current = emptyOfficeDocumentsView(port);
  let signature = signatureOf(current);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let disposed = false;

  const emit = (view: OfficeDocumentsView): void => {
    const next = signatureOf(view);
    if (next === signature) return;
    signature = next;
    options.onView?.(view);
  };

  const probe = async (): Promise<OfficeDocumentsView> => {
    const check = await checkBridgeHealth(verify, { port });
    const view = parseOfficeDocumentsView({
      // Only a bridge that identified itself contributes panes: another program
      // squatting on the port must not populate the panel.
      payload: check.status === "ok" ? (check.health?.raw ?? null) : null,
      status: check.status,
      port,
      error: check.error,
      fetchedAt: new Date(now()).toISOString(),
    });
    current = view;
    emit(view);
    return view;
  };

  const schedule = (): void => {
    if (!running || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void probe().finally(schedule);
    }, intervalMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  };

  return {
    port,
    get: () => current,
    refresh: probe,
    start() {
      if (running || disposed) return;
      running = true;
      void probe().finally(schedule);
    },
    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    dispose() {
      disposed = true;
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
