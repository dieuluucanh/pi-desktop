/**
 * The model picker (plan step 8).
 *
 * What matters here:
 *  - models are grouped by provider and carry an **auth badge**; a provider
 *    without credentials offers "Sign in", which routes to Connections rather
 *    than silently failing on the first prompt;
 *  - favourites are app preferences (`favoriteModels`), not Pi state;
 *  - "save as default" maps to the SDK's `persist` option: unchecked means the
 *    switch lasts for this session, checked writes it as the project default.
 */

import { useState } from "react";
import { Check, Search, Star } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { cn } from "../ui/cn";
import {
  filterModels,
  groupByProvider,
  toAuthBadge,
  withFavoritesFirst,
  type ModelCatalogEntry,
} from "./model-catalog";

export interface ModelPickerProps {
  open: boolean;
  entries: readonly ModelCatalogEntry[];
  /** Per-provider credential state, as the host reported it. */
  auth: Readonly<Record<string, unknown>>;
  /** `provider/id` of the active model, when known. */
  currentKey?: string | null;
  /** Search text supplied by `/model <query>`; reset whenever the dialog opens. */
  initialQuery?: string;
  favorites: readonly string[];
  error?: string | null;
  onPick: (entry: ModelCatalogEntry, options: { persist: boolean }) => void;
  onToggleFavorite: (key: string) => void;
  onSignIn: (provider: string) => void;
  onOpenModelsJson: () => void;
  onClose: () => void;
}

export function ModelPicker({
  open,
  entries,
  auth,
  currentKey = null,
  initialQuery = "",
  favorites,
  error = null,
  onPick,
  onToggleFavorite,
  onSignIn,
  onOpenModelsJson,
  onClose,
}: ModelPickerProps) {
  // The dialog is keyed by `initialQuery`/open state in SessionView, so a
  // `/model <query>` command mounts it with that search already typed and a
  // later header click mounts it empty.
  const [query, setQuery] = useState(initialQuery);
  const [persist, setPersist] = useState(false);

  const matched = filterModels(entries, query);
  const { favorites: favoriteEntries, others } = withFavoritesFirst(matched, favorites);
  const groups = groupByProvider(others, auth);
  const signedOutProviders = [...new Set(entries.map((entry) => entry.provider))].filter(
    (provider) => !toAuthBadge(auth[provider]).configured,
  );

  function renderEntry(entry: ModelCatalogEntry) {
    const active = entry.key === currentKey;
    const favorite = favorites.includes(entry.key);
    return (
      <div key={entry.key} className="flex items-center gap-1">
        <button
          type="button"
          role="option"
          aria-selected={active}
          data-model-key={entry.key}
          onClick={() => onPick(entry, { persist })}
          className={cn(
            "flex flex-1 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs",
            active ? "bg-accent/15 text-ink" : "text-ink-faint hover:bg-raised",
          )}
        >
          {active ? <Check className="size-3 shrink-0" aria-hidden /> : <span className="size-3" />}
          <span className="truncate">{entry.label}</span>
          {entry.thinkingLevel ? (
            <span className="shrink-0 text-[10px] text-ink-faint">{entry.thinkingLevel}</span>
          ) : null}
        </button>
        <button
          type="button"
          aria-label={favorite ? `Unfavourite ${entry.label}` : `Favourite ${entry.label}`}
          aria-pressed={favorite}
          onClick={() => onToggleFavorite(entry.key)}
          className={cn("rounded-xs p-1", favorite ? "text-warn" : "text-ink-faint hover:text-ink")}
        >
          <Star className={cn("size-3", favorite && "fill-current")} aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent aria-label="Choose a model">
        <DialogTitle>Choose a model</DialogTitle>
        <DialogDescription>
          Grouped by provider. The star keeps a model in your shortlist. Unchecked: this session
          only · checked: writes Pi’s default.
        </DialogDescription>
        {error ? (
          <p role="alert" data-testid="model-picker-error" className="mt-2 text-xs text-danger">
            {error}
          </p>
        ) : null}

        <label className="mt-3 flex items-center gap-2 rounded-sm border border-line px-2 py-1">
          <Search className="size-3 text-ink-faint" aria-hidden />
          <input
            aria-label="Search models"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            className="w-full bg-transparent text-xs text-ink outline-none"
          />
        </label>

        <div className="mt-3 max-h-[50vh] overflow-y-auto" data-testid="model-list">
          {favoriteEntries.length > 0 ? (
            <section className="mb-3">
              <h3 className="px-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                Favourites
              </h3>
              {favoriteEntries.map(renderEntry)}
            </section>
          ) : null}

          {groups.map((group) => (
            <section key={group.provider} className="mb-3">
              <h3 className="flex items-center gap-2 px-2 pb-1 text-[10px] uppercase tracking-wide text-ink-faint">
                {group.provider}
                {group.auth.configured ? (
                  <Badge tone="ok">{group.auth.label ?? group.auth.source ?? "signed in"}</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onSignIn(group.provider)}
                    aria-label={`Sign in to ${group.provider}`}
                  >
                    Sign in
                  </Button>
                )}
              </h3>
              {group.models.map(renderEntry)}
            </section>
          ))}

          {matched.length === 0 ? (
            <p className="px-2 text-xs text-ink-faint">
              {entries.length === 0 ? "No models reported yet." : "No model matches that search."}
            </p>
          ) : null}
        </div>

        {signedOutProviders.length > 0 ? (
          <p className="mt-2 text-[11px] text-warn" data-testid="signed-out-note">
            {signedOutProviders.length} provider{signedOutProviders.length === 1 ? "" : "s"} need
            credentials before those models can run.
          </p>
        ) : null}

        <div className="mt-3 flex items-center justify-between border-t border-line pt-2">
          <label className="flex items-center gap-2 text-[11px] text-ink-faint">
            <input
              type="checkbox"
              checked={persist}
              onChange={(event) => setPersist(event.target.checked)}
              aria-label="Save as default"
            />
            Save as default
          </label>
          <Button size="sm" variant="ghost" onClick={onOpenModelsJson}>
            Edit models.json…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
