import { useAppStore } from "../state/app-store";

/**
 * Skills, themes and keybindings (plan step 1 stub with real paths; the browsers
 * and editors land in step 15).
 */
export function SkillsView() {
  const info = useAppStore((state) => state.info);
  const profile = info?.profileDir ?? "unavailable";

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-8 py-6">
      <header>
        <h1 className="text-lg font-semibold">Skills, themes &amp; keybindings</h1>
        <p className="text-sm text-ink-muted">
          These are Pi resources, discovered from the profile, the project's{" "}
          <code className="font-mono text-xs">.pi/</code> directory and installed packages.
        </p>
      </header>

      <section className="card flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Locations</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-ink-faint">Skills</dt>
          <dd className="truncate">{`${profile}\\skills`}</dd>
          <dt className="text-ink-faint">Prompt templates</dt>
          <dd className="truncate">{`${profile}\\prompts`}</dd>
          <dt className="text-ink-faint">Themes</dt>
          <dd className="truncate">{`${profile}\\themes`}</dd>
          <dt className="text-ink-faint">Keybindings</dt>
          <dd className="truncate">{`${profile}\\keybindings.json`}</dd>
        </dl>
        <p className="text-xs text-ink-muted">
          Step 15 adds browsing, previews, an import action, conflict detection for keybindings, and
          dispatch of shortcuts registered by extensions.
        </p>
      </section>
    </div>
  );
}
