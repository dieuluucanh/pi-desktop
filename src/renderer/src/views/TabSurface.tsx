import { lazy, Suspense } from "react";

import type { TabRecord } from "../../../shared/session-ipc";
import { useAppStore } from "../state/app-store";
import { WebTabView } from "../web/WebTabView";
import { SessionView } from "./SessionView";
import { WelcomeView } from "./WelcomeView";

const EditorTabView = lazy(async () => {
  const module = await import("./EditorTabView");
  return { default: module.EditorTabView };
});

/**
 * One tab's content, by id.
 *
 * This is the one place that dispatches on `TabKind`. Keeping it above
 * `SessionView` means an editor tab never mounts the transcript, the composer or
 * a session host — and a web tab does not either.
 *
 * It takes a **tab id** rather than reading the selection (2026-11-03 grid plan):
 * the session view grid mounts several of these at once, and the solo view is
 * just the one-tab case. `null` (or a tab that closed between render and read)
 * falls back to Welcome, which is what the content area showed before.
 */
export function TabSurface({ tabId }: { tabId: string | null }): React.JSX.Element {
  const tab = useAppStore((state) =>
    tabId === null ? undefined : state.tabs.find((entry) => entry.id === tabId),
  );
  if (!tab) return <WelcomeView />;
  return <TabSurfaceBody tab={tab} />;
}

/** The kind switch, split out so the hook above is never called conditionally. */
function TabSurfaceBody({ tab }: { tab: TabRecord }): React.JSX.Element {
  if (tab.kind === "web") return <WebTabView tab={tab} />;
  if (tab.kind === "editor") {
    return (
      <Suspense fallback={<p className="p-4 text-xs text-ink-muted">Opening editor…</p>}>
        <EditorTabView tab={tab} />
      </Suspense>
    );
  }
  return <SessionView tabId={tab.id} />;
}
