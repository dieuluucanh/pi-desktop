import { useMemo } from "react";
import { Command } from "cmdk";

import { fuzzyFilter } from "../completion/fuzzy";
import { useQuickOpen, openQuickFile } from "./quick-open-store";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";

/** `Ctrl+P` file switcher. */
export function QuickOpenDialog(): React.JSX.Element | null {
  const open = useQuickOpen((state) => state.open);
  const query = useQuickOpen((state) => state.query);
  const files = useQuickOpen((state) => state.files);
  const projectPath = useQuickOpen((state) => state.projectPath);
  const loading = useQuickOpen((state) => state.loading);
  const error = useQuickOpen((state) => state.error);
  const close = useQuickOpen((state) => state.close);
  const setQuery = useQuickOpen((state) => state.setQuery);

  const matches = useMemo(
    () =>
      query.trim().length === 0
        ? files.slice(0, 100)
        : fuzzyFilter(files, query, (file) => file).slice(0, 100),
    [files, query],
  );

  if (!open) return null;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent aria-describedby={undefined} data-testid="quick-open">
        <DialogTitle className="sr-only">Open file</DialogTitle>
        <DialogDescription className="sr-only">Type to search project files.</DialogDescription>
        <Command label="Open file" shouldFilter={false}>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Search files by name…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-ink-faint"
            />
            <Kbd>Esc</Kbd>
          </div>
          <Command.List className="max-h-[52vh] overflow-y-auto py-2" data-testid="quick-open-list">
            {loading ? <p className="px-4 py-3 text-xs text-ink-muted">Reading files…</p> : null}
            {error ? <p className="px-4 py-3 text-xs text-warn">{error}</p> : null}
            {!loading && !error && matches.length === 0 ? (
              <p className="px-4 py-3 text-xs text-ink-muted">No matching file.</p>
            ) : null}
            {matches.map((file) => (
              <Command.Item
                key={file}
                value={file}
                onSelect={() => {
                  if (projectPath) void openQuickFile(file, projectPath);
                }}
                className="cursor-pointer px-4 py-1.5 font-mono text-xs text-ink-muted data-[selected=true]:bg-selected data-[selected=true]:text-ink"
              >
                {file}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
