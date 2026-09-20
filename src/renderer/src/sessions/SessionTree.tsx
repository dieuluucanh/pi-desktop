import { useMemo, useState } from "react";
import { CornerDownRight, GitFork, Tag } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { useAppStore } from "../state/app-store";
import { flattenSessionTree, type SessionTreeRow } from "../../../shared/session-browser";

/**
 * The session tree view (plan step 11).
 *
 * Pi stores a session as an append-only *tree*, not a list: branching rewrites
 * the leaf without destroying history. This dialog is the desktop equivalent of
 * the TUI's tree selector — it shows every entry, marks the current leaf, and
 * lets the user navigate a branch, label an entry, or fork from one.
 *
 * The tree payload belongs to the SDK, so it is flattened by the pure
 * `flattenSessionTree` (shared, unit tested) rather than read field-by-field here.
 */

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
  const [labeling, setLabeling] = useState<string | null>(null);

  const rows = useMemo(() => flattenSessionTree(tree, leafId), [tree, leafId]);

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

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {error ? <div className="banner banner--error mb-2">{error}</div> : null}
          {rows.length === 0 && !error ? (
            <p className="py-6 text-center text-xs text-ink-muted">
              This session has no recorded entries yet.
            </p>
          ) : null}

          <ul className="flex flex-col gap-0.5">
            {rows.map((row) => (
              <TreeRowView
                key={row.id}
                row={row}
                labeling={labeling === row.id}
                onStartLabel={() => setLabeling(row.id)}
                onCancelLabel={() => setLabeling(null)}
                onSaveLabel={(label) => {
                  setLabeling(null);
                  if (tabId) void setLabel(tabId, row.id, label);
                }}
                onNavigate={() => tabId && void navigate(tabId, row.id)}
                onFork={() => {
                  if (!tabId) return;
                  close();
                  void fork(tabId, row.id);
                }}
              />
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TreeRowView({
  row,
  labeling,
  onStartLabel,
  onCancelLabel,
  onSaveLabel,
  onNavigate,
  onFork,
}: {
  row: SessionTreeRow;
  labeling: boolean;
  onStartLabel: () => void;
  onCancelLabel: () => void;
  onSaveLabel: (label: string) => void;
  onNavigate: () => void;
  onFork: () => void;
}) {
  return (
    <li
      className={`flex items-center gap-2 rounded-sm px-2 py-1 ${
        row.leaf ? "border border-accent/40 bg-raised" : "border border-transparent"
      }`}
      style={{ marginLeft: row.depth * 12 }}
      data-testid="tree-row"
    >
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
            {row.label ? <span className="mr-1 text-accent">#{row.label}</span> : null}
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
      <Button size="sm" variant="ghost" title="Label this entry" onClick={onStartLabel}>
        <Tag className="size-3" aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" title="Fork from this entry" onClick={onFork}>
        <GitFork className="size-3" aria-hidden />
      </Button>
    </li>
  );
}
