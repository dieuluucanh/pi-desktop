import type { PiDesktopBridge } from "../../shared/ipc";

declare global {
  interface Window {
    /** Exposed by `src/preload/index.ts`; absent if the preload failed to load. */
    pi: PiDesktopBridge;
  }
}
