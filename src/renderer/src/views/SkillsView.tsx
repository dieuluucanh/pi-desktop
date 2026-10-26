import { useEffect } from "react";
import { useAppStore } from "../state/app-store";
import { KeybindingsSection } from "../keybindings/KeybindingsSection";
import { DesktopKeymapSection } from "../keybindings/DesktopKeymapSection";
import { ThemesSection } from "../themes/ThemesSection";
import { SkillsSection } from "../skills/SkillsSection";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Separator } from "../ui/separator";

/**
 * Skills, themes and keybindings (plan step 15).
 *
 * Skills and prompt templates insert `/skill:<name>` / `/name` into the active
 * session's composer; the theme catalogue drives the app chrome; the
 * keybindings editor writes the profile's `keybindings.json` with validation;
 * extension shortcuts registered by installed extensions are listed with the
 * chords they resolved to and can be fired from here or from the keyboard.
 */
export function SkillsView() {
  const shortcuts = useAppStore((state) => state.shortcuts);
  const shortcutsLoaded = useAppStore((state) => state.shortcutsLoaded);
  const loadShortcuts = useAppStore((state) => state.loadShortcuts);
  const invokeShortcut = useAppStore((state) => state.invokeShortcut);
  const setShortcutsHelpOpen = useAppStore((state) => state.setShortcutsHelpOpen);

  useEffect(() => {
    void loadShortcuts();
  }, [loadShortcuts]);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Skills, themes &amp; keybindings</h1>
          <p className="text-sm text-ink-muted">
            Pi resources, discovered from the profile, the project and installed packages — exactly
            as terminal Pi loads them.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setShortcutsHelpOpen(true)}>
          <Kbd>Ctrl+/</Kbd> Shortcuts
        </Button>
      </header>

      <SkillsSection />
      <ThemesSection />
      <KeybindingsSection />
      <DesktopKeymapSection />

      <section className="card flex flex-col gap-2" data-testid="extension-shortcuts">
        <div>
          <h2 className="text-sm font-semibold">Extension shortcuts</h2>
          <p className="text-xs text-ink-muted">
            Registered by installed extensions on the live session. They also fire from the keyboard
            while focus is outside a text field.
          </p>
        </div>
        <Separator />
        {!shortcutsLoaded ? (
          <p className="text-xs text-ink-faint">Reading the live session's shortcuts…</p>
        ) : shortcuts.shortcuts.length === 0 ? (
          <p className="text-xs text-ink-faint">
            No session tab is open, or no extension registered a shortcut.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {shortcuts.shortcuts.map((entry) => (
              <li
                key={`${entry.key}:${entry.extensionPath}`}
                className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-xs font-medium text-ink">
                    {entry.description ?? entry.source}
                  </span>
                  <span className="truncate font-mono text-[10px] text-ink-faint">
                    {entry.source}
                  </span>
                </div>
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
        {shortcuts.diagnostics.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs">
            {shortcuts.diagnostics.map((entry, index) => (
              <li key={index} className="text-ink-muted">
                <Badge tone={entry.type === "error" ? "danger" : "warn"}>{entry.type}</Badge>{" "}
                {entry.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
