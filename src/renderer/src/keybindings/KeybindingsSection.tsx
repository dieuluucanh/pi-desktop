import { useEffect, useMemo, useState } from "react";
import { groupKeybindingDefinitions, userKeybindingConflicts } from "../../../shared/keybindings";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Separator } from "../ui/separator";

/**
 * `keybindings.json` editor (plan step 15).
 *
 * The documented table grouped by namespace, each row showing the effective
 * chord with an inline editor (comma-separated, empty unbinds). Saving writes
 * the whole document atomically after the host validates it — an unknown id or
 * a malformed key refuses the save with the row highlighted, and the file on
 * disk is never left half-written. Pi's own defaults overlap across modal
 * contexts by design; only conflicts involving the user's overrides warn.
 */
export function KeybindingsSection() {
  const keybindings = useAppStore((state) => state.keybindings);
  const keybindingsLoaded = useAppStore((state) => state.keybindingsLoaded);
  const keybindingsBusy = useAppStore((state) => state.keybindingsBusy);
  const keybindingsError = useAppStore((state) => state.keybindingsError);
  const loadKeybindings = useAppStore((state) => state.loadKeybindings);
  const saveKeybindings = useAppStore((state) => state.saveKeybindings);
  const resetKeybindings = useAppStore((state) => state.resetKeybindings);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void loadKeybindings();
  }, [loadKeybindings]);

  const onReset = (): void => {
    void resetKeybindings().then(() => {
      setDraft(null);
      setDirty(false);
    });
  };

  const groups = useMemo(() => {
    const definitions = keybindings?.definitions ?? [];
    const needle = query.trim().toLowerCase();
    const filtered =
      needle.length === 0
        ? definitions
        : definitions.filter(
            (definition) =>
              definition.id.toLowerCase().includes(needle) ||
              definition.description.toLowerCase().includes(needle),
          );
    return groupKeybindingDefinitions(filtered);
  }, [keybindings?.definitions, query]);

  const effectiveOf = (id: string): string[] => keybindings?.effective[id] ?? [];
  const draftOf = (id: string): string => draft?.[id] ?? effectiveOf(id).join(", ");

  const setRow = (id: string, text: string): void => {
    setDraft((previous) => ({ ...(previous ?? {}), [id]: text }));
    setDirty(true);
  };

  const onSave = async (): Promise<void> => {
    const base: Record<string, string[]> = {};
    for (const definition of keybindings?.definitions ?? []) {
      const text = (draft?.[definition.id] ?? definition.defaults.join(", ")).trim();
      // Unchanged rows stay out of the file: `keybindings.json` holds overrides
      // only, so resetting a row is deleting its line, not writing defaults.
      const current = keybindings?.user[definition.id] ?? definition.defaults;
      const next =
        text.length === 0
          ? []
          : text
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean);
      const same =
        next.length === current.length && next.every((key, index) => key === current[index]);
      if (!same) base[definition.id] = next;
    }
    const ok = await saveKeybindings(base);
    if (ok) {
      setDraft(null);
      setDirty(false);
    }
  };

  const userConflicts = useMemo(
    () => (keybindings ? userKeybindingConflicts(keybindings.conflicts, keybindings.user) : []),
    [keybindings],
  );
  const conflictIds = useMemo(
    () => new Set(userConflicts.flatMap((entry) => entry.ids)),
    [userConflicts],
  );

  return (
    <section className="card flex flex-col gap-2" data-testid="keybindings">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Keybindings</h2>
          <p className="text-xs text-ink-muted">
            Overrides in{" "}
            <code className="font-mono">{keybindings?.path ?? "keybindings.json"}</code>; empty
            unbinds. Extension shortcuts resolve against these.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" disabled={keybindingsBusy} onClick={onReset}>
            Reset to defaults
          </Button>
          <Button size="sm" disabled={!dirty || keybindingsBusy} onClick={() => void onSave()}>
            Save
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 rounded-sm border border-line px-2 py-1">
        <input
          aria-label="Search keybindings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search actions"
          className="w-full bg-transparent text-xs text-ink outline-none"
        />
      </label>
      <Separator />
      {keybindingsError ? (
        <p className="banner banner--error text-xs" role="alert">
          {keybindingsError}
        </p>
      ) : null}
      {keybindings?.issues.map((issue) => (
        <p key={issue.id} className="banner banner--error text-xs" role="alert">
          {issue.id}: {issue.message}
        </p>
      ))}
      {keybindings && keybindings.unknownIds.length > 0 ? (
        <p className="banner banner--warn text-xs" role="alert">
          Unknown ids (kept, not applied): {keybindings.unknownIds.join(", ")}
        </p>
      ) : null}
      {userConflicts.length > 0 ? (
        <div className="banner banner--warn flex flex-col gap-1 text-xs" role="alert">
          <strong>Conflicts in your overrides:</strong>
          {userConflicts.map((entry) => (
            <span key={entry.key}>
              <Kbd>{entry.key}</Kbd> {entry.ids.join(", ")}
            </span>
          ))}
        </div>
      ) : null}
      {!keybindingsLoaded ? (
        <p className="text-xs text-ink-faint">Reading keybindings…</p>
      ) : (
        groups.map((group) => (
          <div key={group.namespace} className="flex flex-col gap-1">
            <h3 className="font-mono text-[11px] text-ink-faint">{group.namespace}</h3>
            <ul className="flex flex-col gap-1">
              {group.definitions.map((definition) => (
                <li
                  key={definition.id}
                  className="flex items-center justify-between gap-3 rounded-sm border border-line px-2 py-1"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-[11px] text-ink">
                      {definition.id.replace(`${group.namespace}.`, "")}
                      {conflictIds.has(definition.id) ? <Badge tone="warn">conflict</Badge> : null}
                    </span>
                    <span className="block truncate text-[11px] text-ink-faint">
                      {definition.description}
                      {keybindings && !(definition.id in keybindings.user) ? " · default" : ""}
                    </span>
                  </span>
                  <input
                    aria-label={`Keys for ${definition.id}`}
                    value={draftOf(definition.id)}
                    onChange={(event) => setRow(definition.id, event.target.value)}
                    placeholder={definition.defaults.join(", ") || "unbound"}
                    className="w-44 shrink-0 rounded-xs border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink outline-none"
                  />
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
