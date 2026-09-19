import { randomUUID } from "node:crypto";
import type { HostMethod } from "../shared/host-protocol";
import type { HostHandler } from "./service";

/**
 * The extension-UI request bridge (plan step 4 plumbing, step 16 surface).
 *
 * An extension asking `ctx.ui.select()` blocks until the app answers. The host
 * mints an id, emits `oi.request`, and resolves when `oi.respond` arrives with the
 * same id — the same request/response shape Pi's RPC mode uses, so step 16 only
 * has to render dialogs rather than invent a protocol.
 *
 * Keeping it here (not in the session core) means a control host could serve
 * dialogs too, and that a session shutdown can reject every outstanding request
 * instead of leaving an extension hanging forever.
 */

export interface PendingUiRequest {
  id: string;
  method: string;
  params?: unknown;
}

export interface UiResponse {
  id: string;
  value?: unknown;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface ExtensionUiBridge {
  /** Registers a request, emits `oi.request`, resolves on `oi.respond`. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Outstanding request ids (diagnostics and tests). */
  pendingIds(): string[];
  /** Rejects every pending request, e.g. when its session goes away. */
  dispose(reason: string): void;
  handlers(): Partial<Record<HostMethod, HostHandler>>;
}

export interface ExtensionUiOptions {
  /** Pushes the `oi.request` event to the app. */
  emit(event: string, payload?: unknown): void;
  newId?: () => string;
  /** How long a dialog may stay unanswered before the extension is unblocked. */
  timeoutMs?: number;
}

export const DEFAULT_UI_TIMEOUT_MS = 5 * 60_000;

interface Deferred {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

function parseResponse(params: unknown): UiResponse | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  return {
    id: record.id,
    ...("value" in record ? { value: record.value } : {}),
    ...(typeof record.confirmed === "boolean" ? { confirmed: record.confirmed } : {}),
    ...(record.cancelled === true ? { cancelled: true } : {}),
  };
}

export function createExtensionUiBridge(options: ExtensionUiOptions): ExtensionUiBridge {
  const pending = new Map<string, Deferred>();
  const newId = options.newId ?? ((): string => randomUUID());
  const timeoutMs = options.timeoutMs ?? DEFAULT_UI_TIMEOUT_MS;

  const settle = (id: string): Deferred | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    return entry;
  };

  return {
    request(method, params) {
      const id = newId();
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          // The app never answered: unblock the extension instead of hanging the
          // session, and let step 16 decide how to surface the miss.
          settle(id)?.reject(new Error(`extension UI request ${method} timed out`));
        }, timeoutMs);
        if (typeof timer === "object" && timer && "unref" in timer) timer.unref();
        pending.set(id, { resolve, reject, timer });
        options.emit("oi.request", { id, method, params });
      });
    },

    pendingIds: () => [...pending.keys()],

    dispose(reason) {
      for (const id of [...pending.keys()]) {
        settle(id)?.reject(new Error(reason));
      }
    },

    handlers: () => ({
      "oi.respond": (params) => {
        const response = parseResponse(params);
        if (!response) {
          throw new Error("oi.respond requires an { id } envelope");
        }
        const entry = settle(response.id);
        if (!entry) return { delivered: false };
        if (response.cancelled === true) entry.resolve(undefined);
        else if (typeof response.confirmed === "boolean") entry.resolve(response.confirmed);
        else entry.resolve(response.value);
        return { delivered: true };
      },
    }),
  };
}
