import { useAppStore } from "./app-store";

/**
 * Clears one pane through the store.
 *
 * A narrow action bridge rather than reaching for the whole `AppStateShape` at
 * every call site: the grid knows only that clearing a pane is async, and the
 * store remains free to grow its shape without every consumer importing it.
 */
export async function clearPane(paneIndex: number): Promise<void> {
  // SAFETY: `AppStateShape.clearPane` is declared in app-store.ts; this narrow
  // bridge is the only shape the grid needs, and `npm run typecheck` enforces it.
  await (
    useAppStore.getState() as unknown as {
      clearPane: (index: number) => Promise<void>;
    }
  ).clearPane(paneIndex);
}
