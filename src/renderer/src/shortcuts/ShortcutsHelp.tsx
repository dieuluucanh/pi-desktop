import { useEffect } from "react";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import { Separator } from "../ui/separator";

/**
 * Keyboard shortcuts help (plan step 15, `Ctrl+/`).
 *
 * Three groups: the desktop's own accelerators, Pi's documented `app.*`
 * bindings with the user's remaps applied, and the live extension shortcuts
 * with an invoke action each. Extension shortcuts only exist with a session
 * tab open — the dialog says so instead of showing an empty list.
 */

const DESKTOP_SHORTCUTS: Array<{ keys: string[]; action: string }> = [
  { keys: ["Ctrl/⌘", "N"], action: "New session" },
  { keys: ["Ctrl/⌘", "W"], action: "Close session tab" },
  { keys: ["Ctrl/⌘", "Tab"], action: "Next / previous tab" },
  { keys: ["Shift", "F10"], action: "Tab actions (focused tab)" },
  { keys: ["Ctrl/⌘", "S"], action: "Save file (editor)" },
  { keys: ["Shift", "Alt", "F"], action: "Format document (editor)" },
  { keys: ["Ctrl/⌘", "K"], action: "Command palette" },
  { keys: ["Ctrl/⌘", "B"], action: "Toggle sidebar" },
  { keys: ["Ctrl/⌘", "="], action: "Zoom in" },
  { keys: ["Ctrl/⌘", "-"], action: "Zoom out" },
  { keys: ["Ctrl/⌘", "0"], action: "Actual size (100 %)" },
  { keys: ["Ctrl/⌘", "/"], action: "This help" },
  { keys: ["Esc"], action: "Stop the run / close dialog" },
  { keys: ["Enter"], action: "Send (composer)" },
  { keys: ["Shift", "Enter"], action: "Newline (composer)" },
];

export function ShortcutsHelp() {
  const open = useAppStore((state) => state.shortcutsHelpOpen);
  const setOpen = useAppStore((state) => state.setShortcutsHelpOpen);
  const keybindings = useAppStore((state) => state.keybindings);
  const loadKeybindings = useAppStore((state) => state.loadKeybindings);
  const shortcuts = useAppStore((state) => state.shortcuts);
  const shortcutsLoaded = useAppStore((state) => state.shortcutsLoaded);
  const loadShortcuts = useAppStore((state) => state.loadShortcuts);
  const invokeShortcut = useAppStore((state) => state.invokeShortcut);

  useEffect(() => {
    if (open) {
      void loadKeybindings();
      void loadShortcuts();
    }
  }, [open, loadKeybindings, loadShortcuts]);

  const appBindings = (keybindings?.definitions ?? []).filter((definition) =>
    definition.id.startsWith("app."),
  );
  const effectiveOf = (id: string): string[] =>
    keybindings?.effective[id] ?? appBindings.find((entry) => entry.id === id)?.defaults ?? [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-label="Keyboard shortcuts">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Pi bindings honour your <code className="font-mono">keybindings.json</code> remaps;
          extension shortcuts fire outside text fields so typing is never hijacked.
        </DialogDescription>

        <h3 className="text-xs font-semibold text-ink">Desktop</h3>
        <ul className="flex flex-col gap-1">
          {DESKTOP_SHORTCUTS.map((entry) => (
            <li key={entry.action} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-ink-muted">{entry.action}</span>
              <span className="flex gap-1">
                {entry.keys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <Separator />

        <h3 className="text-xs font-semibold text-ink">Pi actions</h3>
        {appBindings.length === 0 ? (
          <p className="text-xs text-ink-faint">Reading the documented bindings…</p>
        ) : (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {appBindings.map((definition) => (
              <li key={definition.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px] text-ink">
                    {definition.id}
                  </span>
                  <span className="block truncate text-ink-faint">{definition.description}</span>
                </span>
                <span className="flex shrink-0 gap-1">
                  {effectiveOf(definition.id).length === 0 ? (
                    <Badge tone="neutral">unbound</Badge>
                  ) : (
                    effectiveOf(definition.id).map((key) => <Kbd key={key}>{key}</Kbd>)
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Separator />

        <h3 className="text-xs font-semibold text-ink">Extension shortcuts</h3>
        {!shortcutsLoaded ? (
          <p className="text-xs text-ink-faint">
            {shortcutsLoaded
              ? "No session tab is open, or no extension registered a shortcut."
              : "Reading the live session's shortcuts…"}
          </p>
        ) : (
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {shortcuts.shortcuts.map((entry) => (
              <li
                key={`${entry.key}:${entry.extensionPath}`}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="min-w-0">
                  <span className="block truncate text-ink">
                    {entry.description ?? entry.source}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-ink-faint">
                    {entry.source}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Kbd>{entry.key}</Kbd>
                  <Button size="sm" variant="ghost" onClick={() => void invokeShortcut(entry.key)}>
                    Run
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
