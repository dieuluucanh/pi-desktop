/**
 * The Workflow todo panel, decoded from the extension's widget and status
 * (2026-11-18 todo-panel-all-states plan, step 2).
 *
 * `@dieulc/workflow` owns the list. It publishes the panel in three ways:
 *
 *  - a component widget keyed `workflow-todos` (the live panel; the host now
 *    keeps the key on the TUI frame);
 *  - a string widget with the same key (older hosts that only carry lines);
 *  - a compact `workflow-todos` status (`☐ Todos 3/12 · expanded`) while the
 *    panel is hidden or Review owns the turn, plus the existing `workflow`
 *    progress in Plan/Build/Default.
 *
 * The desktop must not import the extension. Parsing is therefore tolerant: an
 * unknown shape degrades to “no panel” rather than throwing or mislabelling
 * another extension's widget. The strings pinned here are the contract.
 */

import { stripAnsi } from "./ansi";
import type { ExtensionWidget } from "./extension-ui";
import type { TuiFrame } from "./tui-surface";
import { parseWorkflowStatus } from "./workflow-mode";

/** The extension's `ctx.ui.setWidget` key (also the status key; separate maps). */
export const TODO_PANEL_WIDGET_KEY = "workflow-todos";
/** The extension's `ctx.ui.setStatus` key for the compact hidden/review line. */
export const TODO_STATUS_KEY = "workflow-todos";

export const TODO_PANEL_STATES = ["expanded", "collapsed", "hidden"] as const;
export type TodoPanelState = (typeof TODO_PANEL_STATES)[number];

export type TodoPanelActionId = "auto" | "expand" | "collapse" | "hide";

export type TodoPanelSource = "status" | "frame" | "widget" | "workflow" | "none";

export interface TodoPanelSnapshot {
  /** True when any source proves a list exists (even when it is hidden). */
  present: boolean;
  /** Effective display state; null when only progress is known. */
  state: TodoPanelState | null;
  done: number | null;
  total: number | null;
  cancelled: number | null;
  /** True when every item is complete/cancelled, when the source says so. */
  settled: boolean | null;
  stale: boolean;
  source: TodoPanelSource;
}

export interface TodoPanelSources {
  /** `tuiSurface.widgetsAbove`. */
  frames?: readonly TuiFrame[];
  /** `extensionUi.widgets`; only the above-editor entries are considered. */
  widgets?: readonly ExtensionWidget[];
  /** `extensionUi.statuses`. */
  statuses?: Readonly<Record<string, string>>;
}

export interface TodoPanelActionDefinition {
  id: TodoPanelActionId;
  label: string;
  description: string;
  /** The `/todos` argument. `show` is the extension's alias for `expand`. */
  args: TodoPanelActionId;
}

/**
 * The four display actions, in menu order. `auto` is the absence of a sticky
 * choice; the extension resolves the effective state from the plan.
 */
export const TODO_PANEL_ACTIONS: readonly TodoPanelActionDefinition[] = [
  {
    id: "auto",
    label: "Automatic",
    description: "Follow the panel's automatic collapse/hide sequence",
    args: "auto",
  },
  {
    id: "expand",
    label: "Show full list",
    description: "Pin the full todo list open (alias: show)",
    args: "expand",
  },
  {
    id: "collapse",
    label: "Collapse to one line",
    description: "Keep only the summary line",
    args: "collapse",
  },
  {
    id: "hide",
    label: "Hide panel",
    description: "Remove the list; the Todo bar stays",
    args: "hide",
  },
];

export interface TodoPanelActionView extends TodoPanelActionDefinition {
  /** True when the panel is already in this state. */
  disabled: boolean;
}

export interface TodoPanelToggle {
  action: "expand" | "collapse";
  label: "Expand" | "Collapse";
  description: string;
}

export interface TodoPanelPaletteAction {
  id: TodoPanelActionId | "toggle";
  label: string;
  description: string;
  /** The `/todos` argument, or null for the derived toggle. */
  args: TodoPanelActionId | null;
}

/** The command-palette rows, kept pure so labels/args are testable. */
export function todoPanelPaletteActions(): readonly TodoPanelPaletteAction[] {
  return [
    ...TODO_PANEL_ACTIONS.map((action) => ({
      id: action.id,
      label: `Todos: ${action.label}`,
      description: action.description,
      args: action.args,
    })),
    {
      id: "toggle" as const,
      label: "Todos: Toggle panel",
      description: "Expand a hidden/collapsed panel or collapse an expanded one",
      args: null,
    },
  ];
}

export interface TodoPanelParse {
  done: number;
  total: number;
  cancelled: number;
  stale: boolean;
  settled: boolean;
  /** Present in the compact status; inferred from a summary line. */
  state: TodoPanelState | null;
}

/** `☐ Todos 3/12` / `☑ Todos 1/2 · 1 cancelled · collapsed`, with ANSI. */
const TODO_PREFIX = /^([☐☑])\s*(?:Todos\s+)?(\d+)\s*\/\s*(\d+)/u;
const TODO_STATE_SUFFIX = /(?:^|\s)·\s*(expanded|collapsed|hidden)\s*$/u;
const TODO_CANCELLED = /·\s*(\d+)\s+cancelled\b/u;
const TODO_SUMMARY_TEXT = /\bnext\s+\S|\ball done\b|\/todos\s+expand\b/u;
const TODO_ROW_PREFIX = /^(?:▶|☐|☑|✖|──|…\s*\+\d+\s+more)/u;
const TODO_SUMMARY_MARK = /^[☐☑]\s*Todos\b/u;

function compact(text: string): string {
  return stripAnsi(text).replace(/\s+/g, " ").trim();
}

function intOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads the prefix/count/state contract shared by the compact status and the
 * collapsed summary. `done > total` and a zero/negative total are malformed.
 */
export function parseTodoStatus(text: string | null | undefined): TodoPanelParse | null {
  if (typeof text !== "string") return null;
  const plain = compact(text);
  const prefix = TODO_PREFIX.exec(plain);
  if (!prefix) return null;
  const mark = prefix[1];
  const done = intOrNull(prefix[2]);
  const total = intOrNull(prefix[3]);
  if (done === null || total === null) return null;
  if (total <= 0 || done < 0 || done > total) return null;

  const stateMatch = TODO_STATE_SUFFIX.exec(plain);
  const explicitState = stateMatch?.[1] as TodoPanelState | undefined;
  const summary = TODO_SUMMARY_TEXT.test(plain) || TODO_SUMMARY_MARK.test(plain);
  const state: TodoPanelState | null = explicitState ?? (summary ? "collapsed" : null);
  const cancelled = intOrNull(TODO_CANCELLED.exec(plain)?.[1]) ?? 0;

  return {
    done,
    total,
    cancelled,
    stale: plain.includes("⚠"),
    settled: mark === "☑" || done === total,
    state,
  };
}

function visibleLines(lines: readonly string[]): string[] {
  return lines.map(compact).filter((line) => line.length > 0);
}

/** Reads a widget frame/string result. An empty panel is “hidden”. */
function inspectTodoLines(lines: readonly string[]): TodoPanelParse | null {
  const visible = visibleLines(lines);
  if (visible.length === 0) {
    return {
      done: 0,
      total: 0,
      cancelled: 0,
      stale: false,
      settled: false,
      state: "hidden",
    };
  }
  const first = visible[0] ?? "";
  const parsed = parseTodoStatus(first);
  const summary = parsed !== null && parsed.state === "collapsed";
  if (summary) return parsed;
  return {
    done: 0,
    total: 0,
    cancelled: 0,
    stale: visible.some((line) => line.includes("⚠")),
    settled: false,
    state: "expanded",
  };
}

function looksLikeTodoFrame(frame: TuiFrame): boolean {
  const visible = visibleLines(frame.lines);
  const first = visible[0] ?? "";
  if (first.length === 0) return false;
  if (TODO_SUMMARY_MARK.test(first) && parseTodoStatus(first) !== null) return true;
  return visible.length > 1 && visible.some((line) => TODO_ROW_PREFIX.test(line));
}

function keyedFrame(frames: readonly TuiFrame[]): TuiFrame | null {
  return frames.find((frame) => frame.key === TODO_PANEL_WIDGET_KEY) ?? null;
}

function keylessFrame(frames: readonly TuiFrame[]): TuiFrame | null {
  return frames.find((frame) => frame.key === undefined && looksLikeTodoFrame(frame)) ?? null;
}

function aboveEditorWidget(sources: TodoPanelSources): ExtensionWidget | null {
  return (
    sources.widgets?.find(
      (widget) => widget.key === TODO_PANEL_WIDGET_KEY && widget.placement === "aboveEditor",
    ) ?? null
  );
}

function workflowProgress(statuses: Readonly<Record<string, string>> | undefined): {
  done: number;
  total: number;
  stale: boolean;
} | null {
  const raw = statuses?.workflow;
  if (typeof raw !== "string") return null;
  const view = parseWorkflowStatus(raw);
  if (!view || view.total === null || view.done === null) return null;
  if (view.total <= 0 || view.done < 0 || view.done > view.total) return null;
  return { done: view.done, total: view.total, stale: stripAnsi(raw).includes("⚠") };
}

function pick<T>(...values: (T | null | undefined)[]): T | null {
  for (const value of values) if (value !== null && value !== undefined) return value;
  return null;
}

/**
 * Resolves the panel from every source, with the compact status first (it is
 * the extension's explicit state), then the component frame, the string widget,
 * and finally the existing `workflow` progress (which implies a hidden panel
 * when no frame exists).
 */
export function resolveTodoPanel(sources: TodoPanelSources = {}): TodoPanelSnapshot {
  const statuses = sources.statuses;
  const statusParse =
    typeof statuses?.[TODO_STATUS_KEY] === "string"
      ? parseTodoStatus(statuses[TODO_STATUS_KEY])
      : null;
  const frame = keyedFrame(sources.frames ?? []) ?? keylessFrame(sources.frames ?? []);
  const frameParse = frame ? inspectTodoLines(frame.lines) : null;
  const widget = aboveEditorWidget(sources);
  const widgetParse = widget ? inspectTodoLines(widget.lines) : null;
  const progress = workflowProgress(statuses);

  const present = Boolean(statusParse || frameParse || widgetParse || progress);
  if (!present) {
    return {
      present: false,
      state: null,
      done: null,
      total: null,
      cancelled: null,
      settled: null,
      stale: false,
      source: "none",
    };
  }

  const state = pick<TodoPanelState>(
    statusParse?.state,
    frameParse?.state,
    widgetParse?.state,
    progress ? "hidden" : null,
  );
  const done = pick<number>(statusParse?.done, frameParse?.done, widgetParse?.done, progress?.done);
  const total = pick<number>(
    statusParse?.total,
    frameParse?.total,
    widgetParse?.total,
    progress?.total,
  );
  const knownCounts = total !== null && total > 0;
  const cancelled = pick<number>(
    statusParse?.cancelled,
    frameParse?.cancelled,
    widgetParse?.cancelled,
  );
  const settled = knownCounts
    ? pick<boolean>(statusParse?.settled, frameParse?.settled, widgetParse?.settled, done === total)
    : null;
  const stale =
    statusParse?.stale === true ||
    frameParse?.stale === true ||
    widgetParse?.stale === true ||
    progress?.stale === true;

  return {
    present,
    state,
    done: knownCounts ? done : null,
    total: knownCounts ? total : null,
    cancelled: knownCounts ? cancelled : null,
    settled: settled ?? (knownCounts ? done === total : null),
    stale,
    source: statusParse ? "status" : frameParse ? "frame" : widgetParse ? "widget" : "workflow",
  };
}

/** Menu/palette view: the already-effective state is disabled. */
export function todoPanelActions(
  snapshot: Pick<TodoPanelSnapshot, "state">,
): TodoPanelActionView[] {
  return TODO_PANEL_ACTIONS.map((action) => ({
    ...action,
    disabled:
      (action.id === "expand" && snapshot.state === "expanded") ||
      (action.id === "collapse" && snapshot.state === "collapsed") ||
      (action.id === "hide" && snapshot.state === "hidden"),
  }));
}

/** The one toggle action: expanded collapses, everything else expands. */
export function todoPanelToggle(snapshot: Pick<TodoPanelSnapshot, "state">): TodoPanelToggle {
  return snapshot.state === "expanded"
    ? {
        action: "collapse",
        label: "Collapse",
        description: "Collapse the todo panel to its summary line",
      }
    : {
        action: "expand",
        label: "Expand",
        description: "Show the full todo panel",
      };
}
