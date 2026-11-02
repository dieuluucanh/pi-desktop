import { lazy, Suspense } from "react";

import { useAppStore } from "../state/app-store";
import { WebTabView } from "../web/WebTabView";
import { SessionView } from "./SessionView";
import { WelcomeView } from "./WelcomeView";

const EditorTabView = lazy(async () => {
  const module = await import("./EditorTabView");
  return { default: module.EditorTabView };
});

/**
 * The active tab's content.
 *
 * This is the one place that dispatches on `TabKind`. Keeping it above
 * `SessionView` means an editor tab never mounts the transcript, the composer
 * or a session host — and a web tab does not either.
 */
export function ActiveTabView(): React.JSX.Element {
  const active = useAppStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  if (!active) return <WelcomeView />;
  if (active.kind === "web") return <WebTabView tab={active} />;
  if (active.kind === "editor") {
    return (
      <Suspense fallback={<p className="p-4 text-xs text-ink-muted">Opening editor…</p>}>
        <EditorTabView tab={active} />
      </Suspense>
    );
  }
  return <SessionView />;
}
