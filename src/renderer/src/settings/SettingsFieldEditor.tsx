import { useMemo, useState } from "react";
import type { SettingsScope, SettingsField, SettingsValue } from "../../../shared/settings-schema";
import {
  formatSettingsDraft,
  parseSettingsDraft,
  type SettingsValueProvenance,
} from "../../../shared/settings-view";
import type { SettingsScopes } from "../../../shared/settings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

/**
 * One schema-driven settings row (plan step 12).
 *
 * The control follows the field's type; booleans and enums apply immediately,
 * while text/number/list/JSON fields keep a local draft so a keystroke is not a
 * file write. Every error is shown inline and the value is never written when it
 * fails validation — the host would refuse it anyway, but the round trip would
 * make the UI feel broken.
 */

export interface SettingsFieldEditorProps {
  field: SettingsField;
  scopes: SettingsScopes;
  provenance: SettingsValueProvenance;
  /** The active project defines its own value for this key. */
  projectOverride?: boolean;
  busy: boolean;
  onSave: (key: string, value: unknown, scope: SettingsScope) => Promise<boolean>;
  onReset: (key: string, scope: SettingsScope) => Promise<void>;
}

const SOURCE_LABEL: Record<SettingsValueProvenance["source"], string> = {
  project: "project override",
  global: "global",
  default: "default",
  unset: "unset",
};

const SOURCE_TONE: Record<SettingsValueProvenance["source"], "accent" | "ok" | "neutral"> = {
  project: "accent",
  global: "ok",
  default: "neutral",
  unset: "neutral",
};

export function SettingsFieldEditor({
  field,
  provenance,
  projectOverride = false,
  busy,
  onSave,
  onReset,
}: SettingsFieldEditorProps) {
  // Settings is global-only. The active project's toggle decides project
  // writes from the project panel/session; this view must never silently write
  // a project document.
  const activeScope: SettingsScope = "global";
  const effective = provenance.effective;
  const serialized = useMemo(() => JSON.stringify(effective ?? null), [effective]);
  const [draft, setDraft] = useState(() => formatSettingsDraft(field, effective));
  const [error, setError] = useState<string | null>(null);
  // Adjusting state during render (React's documented pattern) re-seeds the
  // draft when the value changes underneath us — a reload, or a write to the
  // other scope. An effect would cause a second render for no reason.
  const seed = `${field.key}:${serialized}`;
  const [seeded, setSeeded] = useState(seed);
  if (seeded !== seed) {
    setSeeded(seed);
    setDraft(formatSettingsDraft(field, effective));
    setError(null);
  }

  const commitDraft = async (): Promise<void> => {
    const parsed = parseSettingsDraft(field, draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const ok = await onSave(field.key, parsed.value, activeScope);
    if (!ok) setError("Could not save; see the banner above.");
  };

  const reset = async (): Promise<void> => {
    setError(null);
    await onReset(field.key, activeScope);
  };

  return (
    <div
      className="flex flex-col gap-2 border-b border-line/60 py-3 last:border-b-0"
      data-testid={`setting-${field.key}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm">{field.label}</span>
            <Badge tone={SOURCE_TONE[provenance.source]}>{SOURCE_LABEL[provenance.source]}</Badge>
            {projectOverride ? <Badge tone="accent">project override</Badge> : null}
            {field.scope === "global" ? <Badge>global only</Badge> : null}
            {field.advanced === true ? <Badge>advanced</Badge> : null}
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">{field.description}</p>
          <p className="mt-0.5 font-mono text-[10px] text-ink-faint">{field.key}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2" />
      </div>

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Control
            field={field}
            draft={draft}
            effective={effective}
            disabled={busy}
            onDraftChange={(next) => {
              setDraft(next);
              setError(null);
            }}
            onImmediate={(value) => {
              void onSave(field.key, value, activeScope).then((ok) => {
                if (!ok) setError("Could not save; see the banner above.");
              });
            }}
            onCommit={() => void commitDraft()}
          />
          {error ? (
            <p className="mt-1 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {field.type !== "boolean" && field.type !== "enum" ? (
            <Button size="sm" disabled={busy} onClick={() => void commitDraft()}>
              Save
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void reset()}>
            Reset
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ControlProps {
  field: SettingsField;
  draft: string;
  effective: SettingsValue | undefined;
  disabled: boolean;
  onDraftChange: (next: string) => void;
  onImmediate: (value: unknown) => void;
  onCommit: () => void;
}

const inputClass =
  "w-full rounded-sm border border-line bg-sunken px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent";

function Control({
  field,
  draft,
  effective,
  disabled,
  onDraftChange,
  onImmediate,
  onCommit,
}: ControlProps) {
  if (field.type === "boolean") {
    return (
      <Switch
        checked={effective === true}
        disabled={disabled}
        aria-label={field.label}
        onCheckedChange={(next) => onImmediate(next)}
      />
    );
  }

  if (field.type === "enum") {
    return (
      <select
        aria-label={field.label}
        className={inputClass}
        value={typeof effective === "string" ? effective : ""}
        disabled={disabled}
        onChange={(event) =>
          onImmediate(event.target.value === "" ? undefined : event.target.value)
        }
      >
        <option value="">(unset)</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "number") {
    return (
      <input
        type="number"
        aria-label={field.label}
        className={inputClass}
        value={draft}
        min={field.min}
        max={field.max}
        disabled={disabled}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit();
        }}
      />
    );
  }

  if (field.type === "string-list" || field.type === "json") {
    return (
      <textarea
        aria-label={field.label}
        className={`${inputClass} min-h-16 resize-y`}
        value={draft}
        rows={field.type === "json" ? 5 : 3}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) onCommit();
        }}
      />
    );
  }

  return (
    <input
      type="text"
      aria-label={field.label}
      className={inputClass}
      value={draft}
      disabled={disabled}
      onChange={(event) => onDraftChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onCommit();
      }}
    />
  );
}
