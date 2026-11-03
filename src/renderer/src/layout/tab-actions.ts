/**
 * Dirty-aware tab actions.
 *
 * The stores stay free of each other: app-store owns the tab table, editor-store
 * owns dirty buffers. This module is the one place that combines them for a
 * batch close, so a Close All/Close Others never silently discards an edit.
 */

import type { TabKind } from "../../../shared/session-ipc";
import { useEditorStore } from "../editor/editor-store";
import { useAppStore } from "../state/app-store";

export function closeTabAction(tabId: string): void {
  const tab = useAppStore.getState().tabs.find((entry) => entry.id === tabId);
  if (tab?.kind === "editor") {
    useEditorStore.getState().requestClose(tabId);
    return;
  }
  void useAppStore.getState().closeTab(tabId);
}

export async function closeAllTabsAction(kind: TabKind): Promise<void> {
  const app = useAppStore.getState();
  const targets = app.tabs.filter((tab) => tab.kind === kind && tab.pinned !== true);
  if (targets.length === 0) return;
  if (kind === "editor") {
    const ok = await useEditorStore.getState().resolveDirtyTabs(
      targets.map((tab) => tab.id),
      "close-all",
    );
    if (!ok) return;
  }
  await app.closeAllTabs(kind);
}

export async function closeOtherTabsAction(tabId: string): Promise<void> {
  const app = useAppStore.getState();
  const target = app.tabs.find((tab) => tab.id === tabId);
  if (!target) return;
  const targets = app.tabs.filter(
    (tab) => tab.id !== tabId && tab.kind === target.kind && tab.pinned !== true,
  );
  if (targets.length === 0) return;
  if (target.kind === "editor") {
    const ok = await useEditorStore.getState().resolveDirtyTabs(
      targets.map((tab) => tab.id),
      "close-others",
    );
    if (!ok) return;
  }
  await app.closeOtherTabs(tabId);
}

export async function setTabPinnedAction(tabId: string, pinned: boolean): Promise<void> {
  await useAppStore.getState().setTabPinned(tabId, pinned);
}
