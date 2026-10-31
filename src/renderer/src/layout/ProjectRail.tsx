/**
 * The docked panel rail, mounted as app chrome.
 *
 * The rail used to live inside `SessionView`, which meant it existed only while a
 * session tab was on screen and it could only be scoped to that tab's `cwd`. The
 * panel is a **project** panel, so it now belongs to the shell: one host, one
 * scope, one place that seeds the data behind it (`2026-10-30 plan`).
 *
 * Three rules this file exists to hold:
 *
 *  - **The scope is the selected project** (`railScopeFolder`), falling back to the
 *    active session's folder. A project click moves the whole panel even when the
 *    session column is still showing Welcome.
 *  - **It appears where a session column exists** — the session view and Welcome —
 *    and disappears on Settings, Diagnostics and the other product views, which
 *    get the full width. Collapsed to the strip, it is still there to reopen.
 *  - **It seeds what it shows.** `watchGit` drives main's polling (the strip's
 *    badge is visible while the panel is closed), so the seeding lives with the
 *    strip rather than with whichever body happens to be expanded.
 */

import { useEffect } from "react";
import { useAppStore } from "../state/app-store";
import { RightRail, type RailMenuSpec } from "../rail/RightRail";
import { SourceControlPanel } from "../rail/SourceControlPanel";
import { CheckpointsSection } from "../rail/CheckpointsSection";
import { DocumentsSection } from "../rail/DocumentsSection";
import { DocumentsScope } from "../rail/DocumentsScope";
import { officeDocumentScope } from "../../../shared/office-documents";
import { railScopeFolder } from "../../../shared/rail-scope";

/** The views that own a session column, and therefore the rail beside it. */
const RAIL_VIEWS = new Set(["session", "welcome"]);

export function ProjectRail(): React.JSX.Element | null {
  const view = useAppStore((state) => state.view);
  const projectPath = useAppStore((state) => state.project?.path ?? null);
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const officeDocuments = useAppStore((state) => state.officeDocuments);
  const gitSnapshot = useAppStore((state) => state.git);
  const checkpoints = useAppStore((state) => state.checkpoints);
  const activeEntryIds = useAppStore((state) =>
    activeTabId ? state.transcripts[activeTabId]?.entryIds : undefined,
  );
  const watchGit = useAppStore((state) => state.watchGit);
  const loadGit = useAppStore((state) => state.loadGit);
  const loadCheckpoints = useAppStore((state) => state.loadCheckpoints);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const folder = railScopeFolder({ projectPath, activeTab });

  // Polling and seeding follow the **folder**, not the panel's open state: the
  // strip's changed-file badge is visible while the body is collapsed, so the
  // snapshot has to be live then too. Main already pauses polling while the
  // window is unfocused.
  useEffect(() => {
    void watchGit(folder);
  }, [folder, watchGit]);

  useEffect(() => {
    if (folder) void loadGit(folder);
  }, [folder, loadGit]);

  // The checkpoint badge counts a store the panel has not necessarily opened yet;
  // `loadCheckpoints` is idempotent per folder.
  useEffect(() => {
    if (folder) void loadCheckpoints(folder);
  }, [folder, loadCheckpoints]);

  if (!RAIL_VIEWS.has(view) || !folder) return null;

  const scope = officeDocumentScope(officeDocuments ?? [], tabs, activeTabId, folder);
  const snapshot = gitSnapshot[folder];
  const timeline = checkpoints[folder];
  const officeTab = tabs.find((tab) => tab.kind === "office") ?? null;
  // The Documents menu is a **presence** decision, not a probe reading
  // (2026-10-30 rail-headers plan). One failed `/health` during a host restart
  // must not make the entry vanish, so three independent facts keep it: the
  // install fact from settings, a bridge that answers right now, and an Office
  // tab that will bind the port in a moment.
  const showDocuments =
    officeDocuments?.available === true ||
    officeDocuments?.configured === true ||
    officeTab !== null;

  const menus: RailMenuSpec[] = [
    {
      id: "source-control",
      count: (snapshot?.staged.length ?? 0) + (snapshot?.changed.length ?? 0),
      // Source Control pins the composer and the sync verbs and scrolls the lists
      // itself, so the host must not wrap it in a scroller.
      scroll: "self",
      scopeTitle: folder,
      content: <SourceControlPanel projectPath={folder} />,
    },
    {
      id: "checkpoints",
      count: timeline?.checkpoints.length ?? 0,
      scopeTitle: folder,
      content: <CheckpointsSection projectPath={folder} entryIds={activeEntryIds} />,
    },
    ...(showDocuments
      ? [
          {
            id: "documents" as const,
            count: officeDocuments?.panes.length ?? 0,
            // Documents is app-wide, so its scope row names the session that owns
            // the bridge and offers the way to move it.
            scope: (
              <DocumentsScope
                view={officeDocuments}
                railFolder={folder}
                activeKind={activeTab?.kind ?? null}
              />
            ),
            content: <DocumentsSection isHost={scope.isHost} />,
          },
        ]
      : []),
  ];

  return <RightRail menus={menus} />;
}
