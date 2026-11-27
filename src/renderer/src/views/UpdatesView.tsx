import { UpdatePanel } from "../updates/UpdatePanel";
import { ViewShell } from "./ViewShell";

/**
 * About & updates (2026-11-08 updates/notifications plan).
 *
 * A top-level view rather than the last card of Settings: app identity and the
 * updater's offer are not "app preferences", and the sidebar item doubles as
 * the attention sign when a newer release exists.
 */
export function UpdatesView() {
  return (
    <div data-testid="view-updates">
      <ViewShell width="standard" gap={5}>
        <header>
          <h1 className="text-lg font-semibold">About &amp; updates</h1>
          <p className="text-sm text-ink-muted">
            Build identity, update status and the release feed. The notification bell and the dot on
            this sidebar item tell you when a newer version is offered.
          </p>
        </header>
        <UpdatePanel />
      </ViewShell>
    </div>
  );
}
