import type { UpdateEvent } from "../shared/updates";
import type { UpdatePort } from "./updater";

/**
 * The one place that touches `electron-updater` (plan step 26).
 *
 * `src/main/updater.ts` owns the policy and is Electron-free; this module only
 * translates the library's event names and payloads into the app's
 * {@link UpdateEvent}. It is loaded dynamically so a failure to resolve the
 * library degrades to "updates unsupported" instead of breaking startup, and it
 * is deliberately not unit-tested: only a packaged Electron app can load it.
 */

/** The subset of `AppUpdater` this app calls, typed without importing the lib. */
interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function versionOf(info: unknown): string | null {
  const record = asRecord(info);
  return typeof record.version === "string" && record.version.length > 0 ? record.version : null;
}

/** `releaseNotes` is a string, a list of per-version notes, or absent. */
function releaseNotesOf(info: unknown): string | null {
  const notes = asRecord(info).releaseNotes;
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    const parts = notes
      .map((entry) => {
        const note = asRecord(entry).note;
        return typeof note === "string" ? note : "";
      })
      .filter((entry) => entry.length > 0);
    return parts.length > 0 ? parts.join("\n\n") : null;
  }
  return null;
}

/** The library's `UpdateInfo`/`ProgressInfo` payloads, mapped to our events. */
function toEvent(event: string, payload: unknown): UpdateEvent | null {
  switch (event) {
    case "checking-for-update":
      return { type: "checking" };
    case "update-available":
      return {
        type: "available",
        version: versionOf(payload) ?? "",
        releaseNotes: releaseNotesOf(payload),
      };
    case "update-not-available":
      return { type: "not-available", version: versionOf(payload) };
    case "download-progress": {
      const progress = asRecord(payload);
      const percent = typeof progress.percent === "number" ? progress.percent : 0;
      const bytesPerSecond =
        typeof progress.bytesPerSecond === "number" ? progress.bytesPerSecond : null;
      return { type: "progress", percent, bytesPerSecond };
    }
    case "update-downloaded":
      return { type: "downloaded", version: versionOf(payload) };
    case "error":
      return {
        type: "error",
        message: payload instanceof Error ? payload.message : String(payload ?? "Update failed"),
      };
    default:
      return null;
  }
}

const FORWARDED_EVENTS = [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
] as const;

/** Loads the library through CJS interop; null when it cannot be resolved. */
async function loadUpdater(): Promise<UpdaterLike | null> {
  try {
    const module = (await import("electron-updater")) as {
      autoUpdater?: UpdaterLike;
      default?: { autoUpdater?: UpdaterLike };
    };
    return module.autoUpdater ?? module.default?.autoUpdater ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the updater, or null when the library cannot be loaded. The caller
 * decides whether this build has a feed at all (`app.isPackaged`, safe mode).
 */
export async function createElectronUpdatePort(): Promise<UpdatePort | null> {
  const updater = await loadUpdater();
  if (!updater) return null;
  const resolved: UpdaterLike = updater;

  // Never download behind the user's back; a check only reports (plan step 26).
  try {
    resolved.autoDownload = false;
    resolved.autoInstallOnAppQuit = true;
  } catch {
    // A readonly stub in a test build is not a reason to drop the port.
  }

  return {
    subscribe(listener) {
      const handlers = FORWARDED_EVENTS.map((event) => {
        const handler = (payload: unknown): void => {
          const mapped = toEvent(event, payload);
          if (mapped) listener(mapped);
        };
        resolved.on(event, handler);
        return { event, handler };
      });
      return () => {
        for (const { event, handler } of handlers) resolved.off(event, handler);
      };
    },
    check: () => Promise.resolve(resolved.checkForUpdates()).then(() => undefined),
    download: () => Promise.resolve(resolved.downloadUpdate()).then(() => undefined),
    install: () => resolved.quitAndInstall(),
  };
}
