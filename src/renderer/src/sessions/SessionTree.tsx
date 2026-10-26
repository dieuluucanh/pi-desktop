import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  GitFork,
  Search,
  Tag,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "../ui/cn";
import { useAppStore } from "../state/app-store";
import {
  flattenSessionTree,
  sessionTreeHasChildren,
  SESSION_TREE_FILTERS,
  visibleSessionTreeRows,
  type SessionTreeFilter,
  type SessionTreeRow,
} from "../../../shared/session-browser";

/**
 * The session tree view (plan step 11, extended in 2026-10-26 session-parity
 * plan step 17).
 *
 * Pi stores a session as an append-only *tree*, not a list: branching rewrites
 * the leaf without destroying history. This dialog is the desktop equivalent of
 * the TUI's tree selector — every entry, the current leaf, navigation, labels and
 * forks — plus terminal Pi's filters, folding, type-to-search, label timestamps
 * and the branch-summary prompt.
 *
 * The tree payload belongs to the SDK, so it is flattened by the pure
 * `flattenSessionTree` (shared, unit tested) rather than read field-by-field here.
 */

/** The branch-summary question shown before navigating to an earlier entry. */
type SummaryPrompt = { rowId: string; text: string };

export function SessionTreeDialog() {
  const open = useAppStore((state) => state.sessionTreeOpen);
  const close = useAppStore((state) => state.closeSessionTree);
  const tabId = useAppStore((state) => state.sessionTreeTabId);
  const tree = useAppStore((state) => state.sessionTree);
  const leafId = useAppStore((state) => state.sessionTreeLeafId);
  const error = useAppStore((state) => state.sessionTreeError);
  const navigate = useAppStore((state) => state.navigateTree);
  const setLabel = useAppStore((state) => state.setEntryLabel);
  const fork = useAppStore((state) => state.forkFrom);
  const busy = useAppStore((state) => state.sessionTreeBusy);
  const abortSummary = useAppStore((state) => state.abortBranchSummary);
  const setSetting = useAppStore((state) => state.setSetting);
  const effectiveSetting = useAppStore((state) => state.effectiveSetting);
  const [labeling, setLabeling] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [prompt, setPrompt] = useState<SummaryPrompt | null>(null);
  const [custom, setCustom] = useState<string | null>(null);

  const storedFilter = effectiveSetting("treeFilterMode");
  const filter: SessionTreeFilter = SESSION_TREE_FILTERS.includes(storedFilter as SessionTreeFilter)
    ? (storedFilter as SessionTreeFilter)
    : "default";

  const rows = useMemo(() => flattenSessionTree(tree, leafId), [tree, leafId]);
  const visible = useMemo(
    () => visibleSessionTreeRows(rows, { filter, query, folded }),
    [rows, filter, query, folded],
  );

  // Escape cancels an in-flight branch summary (terminal Pi's behaviour).
  useEffect(() => {
    if (!open || !busy) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (tabId) void abortSummary(tabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, tabId, abortSummary]);

  const cycleFilter = (): void => {
    const index = SESSION_TREE_FILTERS.indexOf(filter);
    const next = SESSION_TREE_FILTERS[(index + 1) % SESSION_TREE_FILTERS.length] ?? "default";
    // `treeFilterMode` is a documented Pi setting; persist it so the choice
    // survives a restart exactly as terminal Pi's does.
    void setSetting("treeFilterMode", next, "global");
  };

  const toggleFold = (id: string): void => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const startNavigate = (row: SessionTreeRow): void => {
    if (row.leaf) {
      // Store-level no-op, kept here so the click says why nothing happened.
      void navigate(tabId ?? "", row.id);
      return;
    }
    setPrompt({ rowId: row.id, text: row.text });
    setCustom(null);
  };

  const finishNavigate = (options: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
  }): void => {
    const target = prompt;
    setPrompt(null);
    setCustom(null);
    if (!tabId || !target) return;
    void navigate(tabId, target.rowId, options);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent
        className="flex max-h-[74vh] flex-col"
        aria-describedby={undefined}
        data-testid="session-tree"
      >
        <DialogTitle>Session history</DialogTitle>
        <DialogDescription>
          Branch navigation stays in the same session file; forking starts a new one.
        </DialogDescription>

        <div className="flex flex-wrap items-center gap-1 px-4 pb-2 text-[11px]">
          <label className="flex min-w-40 flex-1 items-center gap-1 rounded-sm border border-line bg-raised px-2 py-1">
            <Search className="size-3 text-ink-faint" aria-hidden />
            <input
              aria-label="Search this session tree"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search labels, messages, tool calls…"
              className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
            />
          </label>
          <button
            type="button"
            onClick={cycleFilter}
            className="rounded-sm border border-line px-2 py-0.5 text-ink-muted hover:text-ink"
            data-testid="tree-filter"
            title="Cycle the tree filter (saved as treeFilterMode)"
          >
            filter: {filter}
          </button>
          {folded.size > 0 ? (
            <button
              type="button"
              onClick={() => setFolded(new Set())}
              className="rounded-sm border border-line px-2 py-0.5 text-ink-muted hover:text-ink"
            >
              unfold all
            </button>
          ) : null}
        </div>

        {busy ? (
          <div
            className="mx-4 mb-2 flex items-center gap-2 rounded-sm border border-line bg-raised px-2 py-1 text-xs text-ink-muted"
            data-testid="tree-summary-busy"
          >
            <span className="animate-pulse text-accent">●</span>
            <span>Summarizing branch… (Esc to cancel)</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => tabId && void abortSummary(tabId)}
            >
              Cancel
            </Button>
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {error ? <div className="banner banner--error mb-2">{error}</div> : null}
          {rows.length === 0 && !error ? (
            <p className="py-6 text-center text-xs text-ink-muted">
              This session has no recorded entries yet.
            </p>
          ) : null}
          {rows.length > 0 && visible.length === 0 ? (
            <p className="py-6 text-center text-xs text-ink-muted">
              No entry matches this filter or search.
            </p>
          ) : null}

          <ul className="flex flex-col gap-0.5">
            {visible.map((row) => (
              <TreeRowView
                key={row.id}
                row={row}
                expandable={sessionTreeHasChildren(rows, row.id)}
                folded={folded.has(row.id)}
                labeling={labeling === row.id}
                onToggleFold={() => toggleFold(row.id)}
                onStartLabel={() => setLabeling(row.id)}
                onCancelLabel={() => setLabeling(null)}
                onSaveLabel={(label) => {
                  setLabeling(null);
                  if (tabId) void setLabel(tabId, row.id, label);
                }}
                onNavigate={() => startNavigate(row)}
                onCopy={() => void navigator.clipboard?.writeText(row.text)}
                onFork={() => {
                  if (!tabId) return;
                  close();
                  void fork(tabId, row.id);
                }}
              />
            ))}
          </ul>
        </div>

        {prompt ? (
          <div
            className="mx-4 mb-4 rounded-sm border border-line bg-raised px-3 py-2"
            data-testid="tree-summary-prompt"
          >
            <p className="text-xs text-ink">Summarize the abandoned branch before moving here?</p>
            <p className="mt-1 line-clamp-2 text-[11px] text-ink-faint">{prompt.text}</p>
            {custom !== null ? (
              <textarea
                autoFocus
                aria-label="Branch summary instructions"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                className="mt-2 w-full rounded-xs border border-line bg-surface px-2 py-1 text-xs text-ink outline-none"
                rows={3}
                placeholder="What should the summary cover?"
              />
            ) : null}
            <div className="mt-2 flex flex-wrap justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => setPrompt(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => finishNavigate({ summarize: false })}
              >
                No summary
              </Button>
              {custom === null ? (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => finishNavigate({ summarize: true })}
                  >
                    Summarize
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCustom("")}>
                    Custom prompt…
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={custom.trim().length === 0}
                  onClick={() =>
                    finishNavigate({
                      summarize: true,
                      customInstructions: custom.trim(),
                      replaceInstructions: true,
                    })
                  }
                >
                  Summarize with prompt
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TreeRowView({
  row,
  expandable,
  folded,
  labeling,
  onToggleFold,
  onStartLabel,
  onCancelLabel,
  onSaveLabel,
  onNavigate,
  onCopy,
  onFork,
}: {
  row: SessionTreeRow;
  expandable: boolean;
  folded: boolean;
  labeling: boolean;
  onToggleFold: () => void;
  onStartLabel: () => void;
  onCancelLabel: () => void;
  onSaveLabel: (label: string) => void;
  onNavigate: () => void;
  onCopy: () => void;
  onFork: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 rounded-sm px-2 py-1",
        row.leaf ? "border border-accent/40 bg-raised" : "border border-transparent",
      )}
      style={{ marginLeft: row.depth * 12 }}
      data-testid="tree-row"
    >
      {expandable ? (
        <button
          type="button"
          aria-label={folded ? "Unfold this branch" : "Fold this branch"}
          aria-expanded={!folded}
          className="shrink-0 text-ink-faint hover:text-ink"
          onClick={onToggleFold}
        >
          {folded ? (
            <ChevronRight className="size-3" aria-hidden />
          ) : (
            <ChevronDown className="size-3" aria-hidden />
          )}
        </button>
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}
      <Badge tone={row.role === "user" ? "neutral" : "accent"} className="px-1 py-0 leading-3">
        {row.role ?? row.type}
      </Badge>
      <div className="min-w-0 flex-1">
        {labeling ? (
          <input
            autoFocus
            aria-label="Entry label"
            defaultValue={row.label ?? ""}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSaveLabel(event.currentTarget.value);
              if (event.key === "Escape") onCancelLabel();
            }}
            onBlur={(event) => onSaveLabel(event.target.value)}
            className="w-full rounded-xs border border-line bg-surface px-1.5 py-0.5 text-xs text-ink outline-none"
          />
        ) : (
          <span className="block truncate text-xs text-ink-muted" title={row.text}>
            {row.label ? (
              <span className="mr-1 text-accent">
                #{row.label}
                {row.timestamp > 0 ? (
                  <span className="ml-1 text-[10px] text-ink-faint">
                    {new Date(row.timestamp).toLocaleString()}
                  </span>
                ) : null}
              </span>
            ) : null}
            {row.text || <span className="text-ink-faint">{row.type}</span>}
          </span>
        )}
      </div>
      {row.leaf ? <span className="text-[10px] text-accent">current</span> : null}

      {!row.leaf ? (
        <Button size="sm" variant="ghost" title="Move the session here" onClick={onNavigate}>
          <CornerDownRight className="size-3" aria-hidden />
          <span className="text-[10px]">Go</span>
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" title="Copy this entry's text" onClick={onCopy}>
        <Copy className="size-3" aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" title="Label this entry" onClick={onStartLabel}>
        <Tag className="size-3" aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" title="Fork from this entry" onClick={onFork}>
        <GitFork className="size-3" aria-hidden />
      </Button>
    </li>
  );
}
