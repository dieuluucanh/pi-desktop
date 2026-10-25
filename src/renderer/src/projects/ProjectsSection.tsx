import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  GitBranch,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useAppStore } from "../state/app-store";
import { openProjectAction } from "../menu-actions";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import type {
  PiProjectResources,
  ProjectRecord,
  ProjectTrustStatus,
} from "../../../shared/projects";
import type { TabRecord, TabStatus } from "../../../shared/session-ipc";

/**
 * The sidebar's project section (plan step 10, IA per D-A4).
 *
 * Each project is a group: its header shows name, activity and trust, and the
 * expanded body shows the workspace facts the header promises (path, git branch,
 * `.pi/` resources, AGENTS.md, session directory), the per-project defaults, the
 * folder actions, and the sessions that run in it.
 *
 * Everything the group displays comes from `project.inspect` on the control host,
 * so a project with no open session is still described correctly.
 */

const STATUS_TONE: Record<TabStatus, "neutral" | "accent" | "ok" | "warn" | "danger"> = {
  starting: "warn",
  idle: "ok",
  running: "accent",
  crashed: "danger",
  failed: "danger",
  stopped: "neutral",
};

export function ProjectsSection() {
  const projects = useAppStore((state) => state.projects);
  const activePath = useAppStore((state) => state.project?.path ?? null);
  const tabs = useAppStore((state) => state.tabs);
  const projectsLoaded = useAppStore((state) => state.projectsLoaded);

  return (
    <div className="flex flex-col gap-1 px-1" data-testid="projects-section">
      <div className="mt-3 flex items-center justify-between px-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Projects
        </span>
        <Button
          size="sm"
          variant="ghost"
          aria-label="Add project"
          title="Add project folder…"
          onClick={() => void openProjectAction()}
        >
          <FolderOpen className="size-3.5" aria-hidden />
        </Button>
      </div>

      {projects.length === 0 ? (
        <p className="px-2 py-1 text-xs text-ink-muted">
          {projectsLoaded
            ? "No projects yet. Open a folder and sessions run there, the way terminal Pi scopes them to a directory."
            : "Loading projects…"}
        </p>
      ) : (
        projects.map((project, index) => (
          <ProjectGroup
            key={project.path}
            project={project}
            index={index}
            total={projects.length}
            active={project.path === activePath}
            sessions={tabs.filter((tab) => tab.cwd === project.path)}
          />
        ))
      )}
    </div>
  );
}

function ProjectGroup({
  project,
  index,
  total,
  active,
  sessions,
}: {
  project: ProjectRecord;
  index: number;
  total: number;
  active: boolean;
  sessions: TabRecord[];
}) {
  // The active project expands by default, but an explicit toggle wins (no
  // effect-driven setState, which would cascade renders).
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const expanded = expandedOverride ?? active;
  const inspection = useAppStore((state) => state.projectInspections[project.path]);
  const inspectionError = useAppStore((state) => state.projectInspectionErrors[project.path]);
  const trustPrompt = useAppStore((state) => state.trustPrompt);
  const activateProject = useAppStore((state) => state.activateProject);
  const inspectProject = useAppStore((state) => state.inspectProject);
  const removeProject = useAppStore((state) => state.removeProject);
  const reorderProject = useAppStore((state) => state.reorderProject);
  const setProjectSettingsEnabled = useAppStore((state) => state.setProjectSettingsEnabled);
  const settingsBusy = useAppStore((state) => state.projectSettingsBusy[project.path] === true);
  const trustReady = inspection?.trust?.trusted === true;

  useEffect(() => {
    if (expanded && !inspection && !inspectionError) void inspectProject(project.path);
  }, [expanded, inspection, inspectionError, inspectProject, project.path]);

  const running = sessions.some((tab) => tab.status === "running");

  return (
    <div
      className={`rounded-sm border ${active ? "border-accent/50" : "border-line"} bg-raised/40`}
      data-testid={`project-${project.name}`}
    >
      <div className="flex items-center gap-1 px-1 py-1">
        <button
          type="button"
          className="rounded-xs p-0.5 text-ink-muted hover:text-ink"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
          onClick={() => setExpandedOverride(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm"
          title={`${project.path}${active ? " (active)" : ""}`}
          onClick={() => void activateProject(project.path)}
        >
          <span className={active ? "font-semibold" : ""}>{project.name}</span>
        </button>
        {running ? (
          <span
            className="size-1.5 rounded-full bg-accent"
            aria-label="running session"
            data-testid="project-running"
          />
        ) : null}
        <TrustChip cwd={project.path} trust={inspection?.trust} prompted={Boolean(trustPrompt)} />
      </div>

      {expanded ? (
        <div className="flex flex-col gap-2 border-t border-line px-2 py-2 text-[11px] text-ink-muted">
          <Row label="Path">
            <span className="truncate font-mono" title={project.path}>
              {project.path}
            </span>
            <IconButton
              label="Copy path"
              onClick={() => void useAppStore.getState().projectAction(project.path, "copy-path")}
            >
              <Copy className="size-3" aria-hidden />
            </IconButton>
          </Row>

          <Row label="Branch">
            {inspection?.gitBranch ? (
              <span className="flex items-center gap-1">
                <GitBranch className="size-3" aria-hidden />
                {inspection.gitBranch}
              </span>
            ) : (
              <span className="text-ink-faint">not a git repository</span>
            )}
          </Row>

          <Row label="Resources">
            {inspection ? <ResourceChips resources={inspection.resources} /> : null}
            {!inspection && !inspectionError ? <span>inspecting…</span> : null}
            {inspectionError ? (
              <span className="flex items-center gap-1 text-danger">
                {inspectionError}
                <IconButton
                  label="Retry inspection"
                  onClick={() => void inspectProject(project.path)}
                >
                  <RefreshCw className="size-3" aria-hidden />
                </IconButton>
              </span>
            ) : null}
          </Row>

          <Row label="Sessions">
            <span className="truncate font-mono" title={inspection?.sessionDir}>
              {inspection?.sessionDir ?? "—"}
            </span>
          </Row>

          <Row label="Settings">
            <span className="flex flex-wrap items-center gap-1">
              <Switch
                checked={project.useProjectSettings === true}
                disabled={settingsBusy || !trustReady}
                aria-label={`Use project settings for ${project.name}`}
                title={
                  trustReady
                    ? "Off: shared global settings. On: this project's .pi/settings.json."
                    : "Trust this project before using project settings"
                }
                onCheckedChange={(enabled) => void setProjectSettingsEnabled(project.path, enabled)}
              />
              <Badge tone={project.useProjectSettings ? "accent" : "neutral"}>
                {project.useProjectSettings ? "project" : "global"}
              </Badge>
              {project.useProjectSettings ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!trustReady}
                  onClick={() => setSettingsOpen(true)}
                >
                  Edit JSON…
                </Button>
              ) : null}
              {settingsBusy ? <span className="text-ink-faint">saving…</span> : null}
            </span>
          </Row>

          <ProjectSettingsDialog
            open={settingsOpen}
            project={project}
            onClose={() => setSettingsOpen(false)}
          />

          <div className="flex flex-wrap items-center gap-1">
            <IconButton
              label="Reveal in file manager"
              onClick={() => void useAppStore.getState().projectAction(project.path, "reveal")}
            >
              <FolderOpen className="size-3" aria-hidden />
            </IconButton>
            <IconButton
              label="Open external terminal"
              onClick={() => void useAppStore.getState().projectAction(project.path, "terminal")}
            >
              <Terminal className="size-3" aria-hidden />
            </IconButton>
            {index > 0 ? (
              <IconButton
                label="Move project up"
                onClick={() => void reorderProject(project.path, index - 1)}
              >
                <ArrowUp className="size-3" aria-hidden />
              </IconButton>
            ) : null}
            {index < total - 1 ? (
              <IconButton
                label="Move project down"
                onClick={() => void reorderProject(project.path, index + 1)}
              >
                <ArrowDown className="size-3" aria-hidden />
              </IconButton>
            ) : null}
            <IconButton
              label={`Remove ${project.name} from the project list`}
              onClick={() => void removeProject(project.path)}
            >
              <Trash2 className="size-3" aria-hidden />
            </IconButton>
          </div>

          <div className="flex flex-col gap-0.5">
            {sessions.map((session) => (
              <SessionRow key={session.id} session={session} />
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="justify-start text-xs"
              onClick={async () => {
                await activateProject(project.path);
                await useAppStore.getState().createSessionTab();
              }}
            >
              <Plus className="size-3.5" aria-hidden />
              New session here
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SessionRow({ session }: { session: TabRecord }) {
  const activeTabId = useAppStore((state) => state.activeTabId);
  const activateTab = useAppStore((state) => state.activateTab);
  return (
    <button
      type="button"
      className={`flex items-center gap-1.5 rounded-xs px-1 py-0.5 text-left text-xs ${
        session.id === activeTabId ? "bg-surface text-ink" : "text-ink-muted hover:text-ink"
      }`}
      onClick={() => void activateTab(session.id)}
      title={session.sessionFile ?? session.title}
    >
      <Badge tone={STATUS_TONE[session.status]} className="px-1 py-0 leading-3">
        {session.status === "running" ? "●" : "○"}
      </Badge>
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
    </button>
  );
}

function TrustChip({
  cwd,
  trust,
  prompted,
}: {
  cwd: string;
  trust: ProjectTrustStatus | undefined;
  prompted: boolean;
}) {
  const openTrustPrompt = useAppStore((state) => state.openTrustPrompt);
  if (!trust || !trust.requiresTrust) return null;
  const tone = trust.needsPrompt ? "warn" : trust.trusted ? "ok" : "danger";
  const label = trust.needsPrompt ? "trust?" : trust.trusted ? "trusted" : "untrusted";
  return (
    <button
      type="button"
      title={`Project trust: ${label}`}
      aria-label={`Project trust: ${label}`}
      data-testid="project-trust"
      onClick={(event) => {
        event.stopPropagation();
        if (prompted) return;
        void openTrustPrompt(cwd);
      }}
    >
      <Badge tone={tone}>{label}</Badge>
    </button>
  );
}

function ResourceChips({ resources }: { resources?: Partial<PiProjectResources> | undefined }) {
  const value = resources ?? {};
  const chips: string[] = [];
  if (value.settings) chips.push("settings.json");
  if (value.agentsMd) chips.push("AGENTS.md");
  if (value.extensions) chips.push("extensions");
  if (value.skills) chips.push("skills");
  if (value.prompts) chips.push("prompts");
  if (value.themes) chips.push("themes");
  if (value.packages) chips.push("packages");
  if (chips.length === 0) return <span className="text-ink-faint">none</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <Badge key={chip} tone="neutral" className="px-1.5 py-0 font-mono">
          {chip}
        </Badge>
      ))}
    </span>
  );
}

/** Sets a project default from the active session, or clears it. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 shrink-0 text-ink-faint">{label}</span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{children}</span>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="rounded-xs px-1 py-0.5 text-ink-muted hover:bg-surface hover:text-ink"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
