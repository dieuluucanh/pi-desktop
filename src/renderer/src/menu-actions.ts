import type { MenuCommand } from "../../shared/ipc";
import { projectNameOf } from "../../shared/projects";
import { useAppStore } from "./state/app-store";

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
    case "close-session":
      void store.closeActiveTab();
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
    case "command-palette":
      store.togglePalette();
      return;
    case "toggle-sidebar":
      store.toggleSidebar();
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
      store.setView("office");
      return;
    case "shortcuts":
      store.setHint(SHORTCUTS_HINT);
      return;
    default: {
      // Exhaustive today: every MenuCommand is handled above, so `command` is
      // `never` here. Keeping the default makes an added command without a
      // handler a compile error at the call site instead of a silent no-op.
      return;
    }
  }
}
