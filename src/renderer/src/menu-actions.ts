import type { MenuCommand } from "../../shared/ipc";
import { projectNameOf, useAppStore } from "./state/app-store";

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

export function newSessionAction(): void {
  const { project, setHint } = useAppStore.getState();
  setHint(
    project
      ? SESSION_TABS_HINT
      : "Choose a project first — open a folder with “Open project…”, then start a session.",
  );
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
  useAppStore.getState().openProject(path);
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
      store.setHint("Close Session arrives with session tabs (step 11).");
      return;
    case "next-tab":
    case "previous-tab":
      store.setHint("Tab cycling arrives with session tabs (step 11).");
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
