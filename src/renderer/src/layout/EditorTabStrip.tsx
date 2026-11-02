import { useMemo } from "react";

import { isEditorTab } from "../../../shared/session-ipc";
import { useAppStore } from "../state/app-store";
import { TabList } from "./TabList";

/**
 * Editor tabs, in their own row under the session strip.
 *
 * The row is mounted unconditionally by the shell but renders nothing until at
 * least one file is open, so a session-only workspace keeps exactly one 36 px
 * strip. It is still inside `<main>`, which means the sidebar bounds it on the
 * left and the panel rail bounds it on the right, exactly like the session row.
 *
 * One `activeTabId` is shared with the session strip: clicking a file replaces
 * the main view, clicking a session leaves the editor row visible but
 * unselected.
 */
export function EditorTabStrip(): React.JSX.Element | null {
  const allTabs = useAppStore((state) => state.tabs);
  const tabs = useMemo(() => allTabs.filter(isEditorTab), [allTabs]);

  if (tabs.length === 0) return null;

  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-sunken px-1"
      data-testid="editor-tab-strip"
    >
      <TabList tabs={tabs} label="Editor tabs" />
    </div>
  );
}
