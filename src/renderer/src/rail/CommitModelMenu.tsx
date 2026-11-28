/**
 * The commit-message model list (2026-11-25 plan step 18).
 *
 * The chevron beside the sparkle opens this **inline**, in flow below the
 * textarea. It is deliberately not a portal popup: the rail is 320 px wide, so a
 * floating menu clips and steals pointer events (the branch list and the `⋯`
 * options made the same call).
 *
 * The list has one writer: selecting a row saves `prefs.commitMessage.model`
 * (`null` = Default) through the store and closes. Nothing here calls a model or
 * the host — the catalogue is read once on open and the store caches it per
 * folder, so reopening the menu is free.
 *
 * Two states are explained rather than hidden:
 *
 *  - the catalogue failed to load — the error line stays and the Default row is
 *    still rendered (disabled, because no default could be resolved);
 *  - the saved pick is no longer in the catalogue — the list still renders and a
 *    line names the missing model instead of silently checking nothing.
 */

import { useEffect, useState, type RefObject } from "react";
import { Check } from "lucide-react";
import { formatModelRef, sameModelRef } from "../../../shared/text-generation";
import type { CommitMessageModelRef } from "../../../shared/commit-prefs";
import { useAppStore } from "../state/app-store";
import { cn } from "../ui/cn";

export interface CommitModelMenuProps {
  /** The folder whose catalogue is shown and whose pref is written. */
  projectPath: string;
  onClose(): void;
  /** Where Escape sends focus — the chevron that opened this list. */
  returnFocusTo?: RefObject<HTMLButtonElement | null>;
}

export function CommitModelMenu({ projectPath, onClose, returnFocusTo }: CommitModelMenuProps) {
  const catalogue = useAppStore((state) => state.commitModels[projectPath]);
  const saved = useAppStore((state) => state.prefs.commitMessage.model);
  const loadCommitModels = useAppStore((state) => state.loadCommitModels);
  const setCommitMessageModel = useAppStore((state) => state.setCommitMessageModel);

  const [query, setQuery] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);

  // Idempotent: the store caches a folder's catalogue, so a second open (or a
  // reopen after a pick) never re-asks the host.
  useEffect(() => {
    let live = true;
    void loadCommitModels(projectPath).then((result) => {
      if (live && result === null) setLoadFailed(true);
    });
    return () => {
      live = false;
    };
  }, [loadCommitModels, projectPath]);

  // Escape belongs to the list while it is open: close it and hand focus back to
  // the chevron, so a keyboard user is never stranded. Capture phase, because the
  // focus may still be on the chevron itself.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      returnFocusTo?.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose, returnFocusTo]);

  const select = (model: CommitMessageModelRef | null): void => {
    setCommitMessageModel(model);
    onClose();
  };

  const defaultModel = catalogue?.defaultModel ?? null;
  const defaultAvailable = catalogue?.defaultAvailable ?? false;
  const defaultSelected = saved === null;
  const defaultLabel = defaultModel ? `Default (${formatModelRef(defaultModel)})` : "Default";

  const needle = query.trim().toLowerCase();
  const models = (catalogue?.models ?? []).filter((model) => {
    if (needle.length === 0) return true;
    return (
      model.name.toLowerCase().includes(needle) ||
      model.provider.toLowerCase().includes(needle) ||
      model.id.toLowerCase().includes(needle)
    );
  });

  const savedMissing =
    saved !== null &&
    catalogue != null &&
    !catalogue.models.some((model) => sameModelRef(model, saved));

  return (
    <div
      id="commit-model-menu"
      data-testid="commit-model-menu"
      role="group"
      aria-label="Commit message model"
      className="flex flex-col gap-1 rounded-sm border border-line bg-raised/40 p-1"
    >
      <input
        aria-label="Filter models"
        placeholder="Filter models"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="rounded-sm border border-line bg-sunken px-2 py-1 text-[11px] text-ink outline-none focus:border-accent"
      />

      <div
        className="flex max-h-56 flex-col gap-0.5 overflow-y-auto"
        data-testid="commit-model-list"
      >
        <button
          type="button"
          data-testid="commit-model-default"
          aria-pressed={defaultSelected}
          disabled={defaultModel === null}
          title={
            defaultModel
              ? `Use the Default mode model (${formatModelRef(defaultModel)})`
              : "No default model is configured"
          }
          onClick={() => select(null)}
          className={cn(
            "flex w-full items-center gap-2 rounded-xs px-1 py-0.5 text-left text-[11px] hover:bg-raised disabled:opacity-50 disabled:hover:bg-transparent",
            defaultSelected ? "text-ink" : "text-ink-faint",
          )}
        >
          <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
            {defaultSelected ? <Check className="size-3" /> : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{defaultLabel}</span>
            {defaultModel && !defaultAvailable ? (
              <span className="block truncate text-[10px] text-warn">
                This model is unavailable
              </span>
            ) : null}
          </span>
        </button>

        {catalogue == null ? (
          loadFailed ? null : (
            <p className="px-1 text-[11px] text-ink-faint" data-testid="commit-model-loading">
              Loading models…
            </p>
          )
        ) : models.length === 0 ? (
          <p className="px-1 text-[11px] text-ink-faint">
            {needle.length > 0 ? "No model matches that filter." : "No models are available."}
          </p>
        ) : (
          models.map((model) => {
            const selected = sameModelRef(model, saved);
            const key = `${model.provider}/${model.id}`;
            return (
              <button
                key={key}
                type="button"
                data-testid={`commit-model-${key}`}
                aria-pressed={selected}
                title={`${model.name} (${key})`}
                onClick={() => select({ provider: model.provider, id: model.id })}
                className={cn(
                  "flex w-full items-center gap-2 rounded-xs px-1 py-0.5 text-left text-[11px] hover:bg-raised",
                  selected ? "text-ink" : "text-ink-faint",
                )}
              >
                <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">
                  {selected ? <Check className="size-3" /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {model.name}
                  <span className="ml-1 font-mono text-[10px] text-ink-faint">{key}</span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {loadFailed && catalogue == null ? (
        <p role="alert" data-testid="commit-model-error" className="px-1 text-[11px] text-danger">
          The model list could not be loaded.
        </p>
      ) : null}

      {savedMissing && saved !== null ? (
        <p data-testid="commit-model-saved-missing" className="px-1 text-[11px] text-warn">
          The saved model {formatModelRef(saved)} is unavailable — pick another one.
        </p>
      ) : null}
    </div>
  );
}
