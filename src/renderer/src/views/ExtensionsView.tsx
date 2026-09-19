import { OfficeSetupPanel } from "../office/OfficeSetupPanel";
import { useAppStore } from "../state/app-store";

/**
 * Extensions view (plan step 1): the Integrations section hosts the existing,
 * fully implemented Pi for Office wizard from day one (plan D-A10), so the
 * working setup flow never becomes unreachable while the Pi extension hub is
 * built in step 13.
 */

export function ExtensionsView() {
  const info = useAppStore((state) => state.info);

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-6 overflow-y-auto px-8 py-6">
      <header>
        <h1 className="text-lg font-semibold">Extensions</h1>
        <p className="text-sm text-ink-muted">
          Pi loads extensions, skills, prompt templates and themes from the shared profile and from
          packages, exactly as terminal Pi does.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Integrations</h2>
        <OfficeSetupPanel />
      </section>

      <section className="card flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Pi packages &amp; extensions</h2>
        <p className="text-xs text-ink-muted">
          Step 13 lists every loaded extension with its source, scope, contributed tools and
          commands, load errors, and enable/disable. Step 14 adds install/update/remove from npm,
          git or a path with streaming progress and an explicit consent dialog.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-ink-faint">User extensions</dt>
          <dd className="truncate">{info ? `${info.profileDir}\\extensions` : "unavailable"}</dd>
          <dt className="text-ink-faint">User packages</dt>
          <dd className="truncate">{info ? `${info.profileDir}\\npm` : "unavailable"}</dd>
          <dt className="text-ink-faint">Declared in</dt>
          <dd className="truncate">{info?.settingsFile ?? "unavailable"}</dd>
        </dl>
      </section>
    </div>
  );
}
