import { useMemo } from "react";
import { Check, ChevronDown, FolderOpen } from "lucide-react";

import { isEditorTab, isSessionTab, type TabRecord } from "../../../shared/session-ipc";
import { projectNameOf } from "../../../shared/projects";
import { languageBadge, languageIdForPath } from "../../../shared/languages";
import { useAppStore } from "../state/app-store";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";

/**
 * The chevron in a pane header.
 *
 * The list is classified exactly as asked (2026-11-03 grid plan): **Session
 * tabs**, grouped by project, then **Editor tabs** in their own group, then a
 * route into the existing session browser for a session that is not open.
 *
 * What it lists is `panePickerModel` — a pure function, which is what the tests
 * pin. Radix owns only the popup mechanics: opening a `DropdownMenu` in jsdom
 * needs a pointer-capture dance this repo has already been bitten by, and the
 * grouping/swap rules are the part worth testing (the same split `tabMenuItems`
 * uses for the tab menu).
 *
 * A tab already shown in *another* pane stays selectable — choosing it swaps the
 * two panes (one pane per tab) — and carries a `pane N` hint so the swap is
 * legible rather than surprising.
 */
export function PanePicker({
  paneIndex,
  assignedTabId,
}: {
  paneIndex: number;
  assignedTabId: string | null;
}): React.JSX.Element {
  const tabs = useAppStore((state) => state.tabs);
  const panes = useAppStore((state) => state.prefs.grid.panes);
  const assignPaneTab = useAppStore((state) => state.assignPaneTab);
  const browseSessionsForPane = useAppStore((state) => state.browseSessionsForPane);
  const model = useMemo(
    () => panePickerModel(tabs, panes, assignedTabId),
    [tabs, panes, assignedTabId],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Choose a tab for pane ${paneIndex + 1}`}
          title="Choose a tab for this pane"
          data-testid={`pane-picker-${paneIndex}`}
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel>Session tabs</DropdownMenuLabel>
        {model.sessions.length === 0 ? (
          <DropdownMenuItem disabled>No open sessions</DropdownMenuItem>
        ) : (
          model.sessions.map((group) => (
            <div key={group.path}>
              <DropdownMenuLabel className="text-[10px] font-normal text-ink-faint">
                {group.name}
              </DropdownMenuLabel>
              {group.tabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.id}
                  onSelect={() => void assignPaneTab(paneIndex, tab.id)}
                  data-testid={`pane-pick-${tab.id}`}
                >
                  <CheckSlot on={tab.current} />
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  {tab.paneHint === null ? null : (
                    <span className="shrink-0 text-[10px] text-ink-faint">{tab.paneHint}</span>
                  )}
                </DropdownMenuItem>
              ))}
            </div>
          ))
        )}

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Editor tabs</DropdownMenuLabel>
        {model.editors.length === 0 ? (
          <DropdownMenuItem disabled>No open files</DropdownMenuItem>
        ) : (
          model.editors.map((tab) => (
            <DropdownMenuItem
              key={tab.id}
              onSelect={() => void assignPaneTab(paneIndex, tab.id)}
              data-testid={`pane-pick-${tab.id}`}
            >
              <CheckSlot on={tab.current} />
              <span className="shrink-0 rounded-xs border border-line px-1 font-mono text-[9px] uppercase text-ink-muted">
                {languageBadge(languageIdForPath(tab.filePath))}
              </span>
              <span className="min-w-0 flex-1 truncate">{tab.title}</span>
              {tab.paneHint === null ? null : (
                <span className="shrink-0 text-[10px] text-ink-faint">{tab.paneHint}</span>
              )}
            </DropdownMenuItem>
          ))
        )}

        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => void browseSessionsForPane(paneIndex)}
          data-testid={`pane-browse-${paneIndex}`}
        >
          <FolderOpen className="size-3.5" aria-hidden />
          Browse saved sessions…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CheckSlot({ on }: { on: boolean }): React.JSX.Element {
  return on ? (
    <Check className="size-3 shrink-0 text-accent" aria-hidden />
  ) : (
    <span className="size-3 shrink-0" aria-hidden />
  );
}

/** One pane the picker lists, with the two facts the menu shows about it. */
export interface PanePickerEntry {
  id: string;
  title: string;
  /** True for the tab this pane already holds. */
  current: boolean;
  /** “pane N” when another pane shows the tab (choosing it swaps). */
  paneHint: string | null;
}

/** One project's session tabs, in tab order. */
export interface PanePickerGroup {
  path: string;
  name: string;
  tabs: PanePickerEntry[];
}

export interface PanePickerModel {
  sessions: PanePickerGroup[];
  editors: Array<PanePickerEntry & { filePath: string }>;
}

/**
 * The picker's whole content, as data.
 *
 * Session tabs are grouped by project folder and titled by `projectNameOf` (the
 * folder's own name), so a pane in another project stays readable while the
 * sidebar is scoped elsewhere. A tab with an empty `cwd` has nowhere to belong
 * and is skipped — which is also why `isSessionTab` alone is not enough here.
 */
export function panePickerModel(
  tabs: readonly TabRecord[],
  panes: readonly (string | null)[],
  assignedTabId: string | null,
): PanePickerModel {
  const entry = (tab: TabRecord): PanePickerEntry => {
    const pane = panes.indexOf(tab.id);
    return {
      id: tab.id,
      title: tab.title,
      current: tab.id === assignedTabId,
      paneHint: pane >= 0 && tab.id !== assignedTabId ? `pane ${pane + 1}` : null,
    };
  };

  const groups = new Map<string, PanePickerEntry[]>();
  for (const tab of tabs) {
    if (!isSessionTab(tab) || tab.cwd.length === 0) continue;
    const list = groups.get(tab.cwd);
    const item = entry(tab);
    if (list) list.push(item);
    else groups.set(tab.cwd, [item]);
  }

  return {
    sessions: [...groups.entries()].map(([path, list]) => ({
      path,
      name: projectNameOf(path),
      tabs: list,
    })),
    editors: tabs.filter(isEditorTab).map((tab) => ({
      ...entry(tab),
      filePath: tab.filePath ?? "",
    })),
  };
}
