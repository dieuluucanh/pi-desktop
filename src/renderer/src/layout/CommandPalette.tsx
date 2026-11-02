import { Command } from "cmdk";
import { useAppStore, type AppView } from "../state/app-store";
import { useEditorStore } from "../editor/editor-store";
import { newSessionAction, openProjectAction } from "../menu-actions";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";

/**
 * Command palette (plan step 1) — the universal entry point: actions first, then
 * navigation. It is intentionally the only place the renderer owns a global
 * shortcut (nothing here duplicates the menu accelerators).
 */

interface GoTarget {
  view: AppView;
  label: string;
}

const GO_TARGETS: readonly GoTarget[] = [
  { view: "settings", label: "Settings" },
  { view: "extensions", label: "Extensions" },
  { view: "connections", label: "Connections (providers & keys)" },
  { view: "skills", label: "Skills, themes & keybindings" },
  { view: "diagnostics", label: "Diagnostics" },
];

export function CommandPalette() {
  const open = useAppStore((state) => state.paletteOpen);
  const closePalette = useAppStore((state) => state.closePalette);
  const setView = useAppStore((state) => state.setView);
  const setHint = useAppStore((state) => state.setHint);
  const toggleSidebar = useAppStore((state) => state.toggleSidebar);
  const openSessionBrowser = useAppStore((state) => state.openSessionBrowser);

  const run = (action: () => void): void => {
    closePalette();
    action();
  };

  // Session-history actions need an open session; the palette says so instead of
  // silently doing nothing (the placeholder UI's failure mode).
  const runSession = (action: (tabId: string) => void): void => {
    const tabId = useAppStore.getState().activeTabId;
    if (!tabId) {
      closePalette();
      setHint("Open a session first — that action applies to a session.");
      return;
    }
    closePalette();
    action(tabId);
  };

  // Editor commands are only meaningful with an editor tab on screen; the
  // palette explains the requirement instead of saving/formatting nothing.
  const runEditor = (action: (tabId: string) => void): void => {
    const state = useAppStore.getState();
    const tab = state.activeTabId
      ? state.tabs.find((entry) => entry.id === state.activeTabId)
      : undefined;
    if (!tab || tab.kind !== "editor") {
      closePalette();
      setHint("Open a file first — that action applies to the editor.");
      return;
    }
    closePalette();
    action(tab.id);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closePalette())}>
      <DialogContent aria-describedby={undefined}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Run an app action or jump to a view.
        </DialogDescription>
        <Command
          label="Command palette"
          className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-faint"
        >
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Command.Input
              autoFocus
              placeholder="Type a command or a view…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
            />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className="max-h-[52vh] overflow-y-auto py-2">
            <Command.Empty className="px-4 py-6 text-sm text-ink-muted">
              No matching command.
            </Command.Empty>

            <Command.Group heading="Actions">
              <PaletteItem
                label="New session"
                shortcut="Ctrl+N"
                onSelect={() => run(newSessionAction)}
              />
              <PaletteItem
                label="Open project…"
                shortcut="Ctrl+O"
                onSelect={() => run(() => void openProjectAction())}
              />
              <PaletteItem
                label="Go to file…"
                shortcut="Ctrl+P"
                onSelect={() =>
                  run(
                    () =>
                      void import("../files/quick-open-store").then((module) =>
                        module.useQuickOpen.getState().openDialog(),
                      ),
                  )
                }
              />
              <PaletteItem
                label="Open URL in a tab…"
                onSelect={() => run(() => useAppStore.getState().openWebUrlDialog())}
              />
              <PaletteItem
                label="Save file"
                shortcut="Ctrl+S"
                onSelect={() => runEditor((tabId) => void useEditorStore.getState().save(tabId))}
              />
              <PaletteItem
                label="Format document"
                shortcut="Shift+Alt+F"
                onSelect={() => runEditor((tabId) => void useEditorStore.getState().format(tabId))}
              />
              <PaletteItem
                label="Browse sessions…"
                shortcut="Ctrl+Shift+O"
                onSelect={() => run(() => void openSessionBrowser())}
              />
              <PaletteItem
                label="Session history tree…"
                onSelect={() =>
                  runSession((tabId) => void useAppStore.getState().openSessionTree(tabId))
                }
              />
              <PaletteItem
                label="Fork from a message…"
                onSelect={() => runSession((tabId) => void useAppStore.getState().openFork(tabId))}
              />
              <PaletteItem
                label="Export session to HTML"
                onSelect={() =>
                  runSession((tabId) => void useAppStore.getState().exportSessionHtml(tabId))
                }
              />
              <PaletteItem
                label="Toggle sidebar"
                shortcut="Ctrl+B"
                onSelect={() => run(toggleSidebar)}
              />
              <PaletteItem
                label="Show keyboard shortcuts"
                shortcut="Ctrl+/"
                onSelect={() => run(() => useAppStore.getState().setShortcutsHelpOpen(true))}
              />
            </Command.Group>

            <Command.Group heading="Go to">
              {GO_TARGETS.map((target) => (
                <PaletteItem
                  key={target.view}
                  label={target.label}
                  onSelect={() => run(() => setView(target.view))}
                />
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function PaletteItem({
  label,
  shortcut,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={label}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 px-4 py-2 text-sm data-[selected=true]:bg-raised"
    >
      <span className="flex-1">{label}</span>
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
    </Command.Item>
  );
}
