import { OfficeSetupPanel } from "../office/OfficeSetupPanel";

/**
 * Pi for Office (plan step 1 placement; step 19 turns this into the Integrations
 * card with bridge status actions). The wizard backend is unchanged and fully
 * functional — only its navigation home is temporary.
 */
export function OfficeView() {
  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto px-8 py-6">
      <header>
        <h1 className="text-lg font-semibold">Pi for Office</h1>
        <p className="text-sm text-ink-muted">
          An optional integration: it installs the Pi for Office bridge as a normal Pi extension,
          sideloads the add-in, and verifies the connection. The app needs no Office setup to be
          used for coding.
        </p>
      </header>
      <OfficeSetupPanel />
    </div>
  );
}
