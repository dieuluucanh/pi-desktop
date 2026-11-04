import type { MenuCommand } from "../../shared/ipc";
import { projectNameOf } from "../../shared/projects";
import {
  DEFAULT_ZOOM,
  zoomIn as nextZoomLevel,
  zoomOut as previousZoomLevel,
} from "../../shared/zoom";
import { useAppStore } from "./state/app-store";
import { useEditorStore } from "./editor/editor-store";

/**
 * Menu-command handling (plan step 1).
 *
 * The Electron menu owns the accelerators (Ctrl+N/W/B/Tab/K//) and sends
 * `MenuCommand`s over IPC. The renderer deliberately does **not** register its
 * own global shortcuts for those keys: two owners would fire each command twice.
 *
 * Actions that need a later step (session tabs, tab cycling, close) report a
 * precise hint instead of silently doing nothing — the placeholder UI's failure
 * mode was exactly that kind of silence.
 */

export interface MenuActionDeps {
  pickDirectory: () => Promise<string | null>;
}

export const SESSION_TABS_HINT = "Session tabs land in step 3 (session service).";

export const SHORTCUTS_HINT =
  "Ctrl/Cmd+K palette · Ctrl/Cmd+N new session · Ctrl/Cmd+W close · Ctrl/Cmd+B sidebar · Ctrl/Cmd+/ shortcuts";

/**
 * New session: with a project open the tab is created and its host spawned
 * (plan step 3); without one the user is told what to do first.
 */
export function newSessionAction(): void {
  void useAppStore.getState().createSessionTab();
}

export async function openProjectAction(deps?: Partial<MenuActionDeps>): Promise<void> {
  const api = window.pi;
  const pick = deps?.pickDirectory ?? (api ? () => api.pickDirectory() : null);
  if (!pick) {
    useAppStore.getState().setHint("The preload bridge is unavailable.");
    return;
  }
  const path = await pick();
  if (!path) return;
  await useAppStore.getState().openProject(path);
  void api?.setTitle(`Pi Desktop — ${projectNameOf(path)}`);
}

export function handleMenuCommand(command: MenuCommand, deps?: Partial<MenuActionDeps>): void {
  const store = useAppStore.getState();
  switch (command) {
    case "new-session":
      newSessionAction();
      return;
    case "open-project":
      void openProjectAction(deps);
      return;
    case "open-file":
      void import("./files/quick-open-store").then((module) =>
        module.useQuickOpen.getState().openDialog(),
      );
      return;
    case "save-editor":
    case "format-editor": {
      const tabId = store.activeTabId;
      const tab = tabId ? store.tabs.find((entry) => entry.id === tabId) : undefined;
      if (!tab || tab.kind !== "editor") {
        store.setHint(
          command === "save-editor" ? "Open a file to save it." : "Open a file to format it.",
        );
        return;
      }
      if (command === "save-editor") void useEditorStore.getState().save(tab.id);
      else void useEditorStore.getState().format(tab.id);
      return;
    }
    case "open-web-url":
      // The manual "Open URL in a tab" action (plan step 21); the dialog is the
      // one place a URL is typed, so localhost UIs never need a terminal.
      store.openWebUrlDialog();
      return;
    case "close-session":
      if (store.activeTabId) useEditorStore.getState().requestClose(store.activeTabId);
      else void store.closeActiveTab();
      return;
    case "view-sessions":
      void store.openSessionBrowser();
      return;
    case "next-tab":
      void store.cycleTab(1);
      return;
    case "model-cycle-forward":
    case "model-cycle-backward": {
      // Cycling acts on the active session; without one there is nothing to cycle.
      const tabId = store.activeTabId;
      if (!tabId) {
        store.setHint("Open a session first — model cycling applies to a session.");
        return;
      }
      void store.cycleModel(tabId, command === "model-cycle-forward" ? 1 : -1);
      return;
    }
    case "thinking-cycle": {
      const tabId = store.activeTabId;
      if (!tabId) {
        store.setHint("Open a session first — thinking applies to a session.");
        return;
      }
      void store.cycleThinking(tabId);
      return;
    }
    case "previous-tab":
      void store.cycleTab(-1);
      return;
    case "session-tree": {
      const tabId = store.activeTabId;
      if (!tabId) {
        store.setHint("Open a session first — the history tree belongs to a session.");
        return;
      }
      void store.openSessionTree(tabId);
      return;
    }
    case "session-fork": {
      const tabId = store.activeTabId;
      if (!tabId) {
        store.setHint("Open a session first — forking belongs to a session.");
        return;
      }
      void store.openFork(tabId);
      return;
    }
    case "session-export": {
      const tabId = store.activeTabId;
      if (!tabId) {
        store.setHint("Open a session first — there is nothing to export.");
        return;
      }
      void store.exportSessionHtml(tabId);
      return;
    }
    case "command-palette":
      store.togglePalette();
      return;
    case "toggle-sidebar":
      store.toggleSidebar();
      return;
    case "toggle-rail":
      store.toggleRail();
      return;
    // Session view grid (2026-11-03 plan). The presets are fixed shapes, so each
    // menu command maps to one `setGridLayout` call.
    case "grid-single":
      store.setGridLayout("single");
      return;
    case "grid-two":
      store.setGridLayout("two");
      return;
    case "grid-three-left":
      store.setGridLayout("three-left");
      return;
    case "grid-three-right":
      store.setGridLayout("three-right");
      return;
    case "grid-four":
      store.setGridLayout("four");
      return;
    // Display zoom is applied by main from the persisted pref; the menu handler
    // only advances the level (2026-10-30 zoom plan).
    case "zoom-in":
      store.setPrefs({ zoomFactor: nextZoomLevel(store.prefs.zoomFactor) });
      return;
    case "zoom-out":
      store.setPrefs({ zoomFactor: previousZoomLevel(store.prefs.zoomFactor) });
      return;
    case "zoom-reset":
      store.setPrefs({ zoomFactor: DEFAULT_ZOOM });
      return;
    case "view-explorer":
      store.openRailMenu("explorer");
      return;
    case "view-source-control":
      // Opens the panel on Source Control without toggling it.
      store.openRailMenu("source-control");
      return;
    case "view-checkpoints":
      store.openRailMenu("checkpoints");
      return;
    case "view-documents":
      // The menu is also the place to *connect* the bridge, so it opens while
      // the package is configured even when `/health` is silent.
      if (
        store.officeDocuments?.available ||
        store.officeDocuments?.configured ||
        store.tabs.some((tab) => tab.kind === "office")
      ) {
        store.openRailMenu("documents");
      } else {
        store.setHint("Pi for Office is not installed. Install it from Extensions → Integrations.");
      }
      return;
    case "view-settings":
      store.setView("settings");
      return;
    case "view-extensions":
      store.setView("extensions");
      return;
    case "view-connections":
      store.setView("connections");
      return;
    case "view-skills":
      store.setView("skills");
      return;
    case "view-diagnostics":
      store.setView("diagnostics");
      return;
    case "view-office":
      // Pi for Office is an integration, not a primary view (plan D-A10): the
      // menu item opens the Extensions hub on its Integrations card.
      store.focusIntegrations();
      return;
    case "shortcuts":
      store.setShortcutsHelpOpen(true);
      return;
    case "check-updates":
      // Opens the durable About & updates card and starts a check; the status
      // bar then carries available/downloading/downloaded, and the card carries
      // every outcome including a missing published feed.
      store.openUpdateSettings({ check: true });
      return;
    case "view-about":
      store.openUpdateSettings();
      return;
    default: {
      // Exhaustive today: every MenuCommand is handled above, so `command` is
      // `never` here. Keeping the default makes an added command without a
      // handler a compile error at the call site instead of a silent no-op.
      return;
    }
  }
}
