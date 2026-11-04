/**
 * Settings → Checkpoints and Source control (git-checkpoint plan step 27).
 *
 * Two cards, one rule between them: **preferences are the only writer of the
 * checkpoint configuration** (D19). The card edits `prefs.checkpoints`, main
 * projects it to `<profile>/checkpoints/config.json`, and the host-side
 * extension reads that file. There is no second write path, and no second copy
 * of the values.
 *
 * The Source control card is read-only apart from the identity: git's version and
 * the resolved `user.name`/`user.email` come from the engine, and a missing
 * identity is fixed with the same repository-local form the commit box uses —
 * never a silent global write.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  MAX_EXCLUDE_PATTERNS,
  MIN_SCAN_INTERVAL_MS,
  describeRetention,
  formatBytes,
  sanitizeCheckpointConfig,
  type CheckpointConfig,
} from "../../../shared/checkpoints";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Switch } from "../ui/switch";

/** The retention presets, so a user does not have to type byte counts. */
const RETENTION_PRESETS = [30, 60, 90] as const;
/** The count presets (checkpoints per folder). */
const COUNT_PRESETS = [50, 100, 250] as const;
/** Byte budgets, in GB. */
const BYTE_PRESETS = [1, 2, 10] as const;

/** `<profile>/checkpoints/config.json`'s value, clamped on every edit. */
function withPatch(
  current: CheckpointConfig,
  patch: Partial<Record<keyof CheckpointConfig, unknown>>,
): CheckpointConfig {
  return sanitizeCheckpointConfig({ ...current, ...patch });
}

export function CheckpointsSettingsCard() {
  const prefs = useAppStore((state) => state.prefs);
  const setPrefs = useAppStore((state) => state.setPrefs);
  const config = prefs.checkpoints;
  /**
   * The textarea is a *draft*: it holds what the user is typing, and the prefs
   * document stays canonical. The draft is keyed by the committed value, so a
   * change from elsewhere (another window, an import) is picked up without an
   * effect that would reset state mid-typing.
   */
  const committed = config.exclude.join("\n");
  const [draft, setDraft] = useState<{ committed: string; text: string }>({
    committed,
    text: committed,
  });
  const excludeText = draft.committed === committed ? draft.text : committed;
  const setExcludeText = (text: string): void => setDraft({ committed, text });

  const apply = (patch: Partial<Record<keyof CheckpointConfig, unknown>>): void => {
    setPrefs({ checkpoints: withPatch(config, patch) });
  };

  const commitExcludes = (): void => {
    const exclude = excludeText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, MAX_EXCLUDE_PATTERNS);
    apply({ exclude });
    toast.success(
      exclude.length === 0
        ? "Using only the default ignore patterns."
        : `Ignoring ${exclude.length} extra pattern${exclude.length === 1 ? "" : "s"}.`,
    );
  };

  return (
    <section className="card flex flex-col gap-3" data-testid="settings-checkpoints">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Checkpoints</h2>
          <p className="text-xs text-ink-muted">
            Snapshots of this folder into a shadow git repository under your Pi profile. The
            project&apos;s own <code>.git</code> is never touched, so this works in a folder with no
            repository at all.
          </p>
        </div>
        <Switch
          checked={config.enabled}
          onCheckedChange={(enabled) => apply({ enabled })}
          aria-label="Enable folder checkpoints"
        />
      </div>

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-xs">
        <span className="text-ink-faint">Keep</span>
        <div className="flex flex-wrap items-center gap-1">
          {COUNT_PRESETS.map((count) => (
            <Button
              key={count}
              size="sm"
              variant={config.maxPerSession === count ? "primary" : "ghost"}
              data-testid={`checkpoints-count-${count}`}
              onClick={() => apply({ maxPerSession: count })}
            >
              {count}
            </Button>
          ))}
          <span className="text-ink-faint">per folder</span>
        </div>

        <span className="text-ink-faint">For</span>
        <div className="flex flex-wrap items-center gap-1">
          {RETENTION_PRESETS.map((days) => (
            <Button
              key={days}
              size="sm"
              variant={config.retentionDays === days ? "primary" : "ghost"}
              data-testid={`checkpoints-days-${days}`}
              onClick={() => apply({ retentionDays: days })}
            >
              {days} days
            </Button>
          ))}
        </div>

        <span className="text-ink-faint">Up to</span>
        <div className="flex flex-wrap items-center gap-1">
          {BYTE_PRESETS.map((gb) => (
            <Button
              key={gb}
              size="sm"
              variant={config.maxBytesPerProject === gb * 1024 ** 3 ? "primary" : "ghost"}
              data-testid={`checkpoints-bytes-${gb}`}
              onClick={() => apply({ maxBytesPerProject: gb * 1024 ** 3 })}
            >
              {gb} GB
            </Button>
          ))}
        </div>

        <span className="text-ink-faint">Idle scan</span>
        <div className="flex flex-wrap items-center gap-2">
          <Switch
            checked={config.scanIntervalMs > MIN_SCAN_INTERVAL_MS}
            onCheckedChange={(on) =>
              apply({
                // "Off" is the floor, not zero: the sanitizer clamps below it, and
                // a scan every second would be worse than none.
                scanIntervalMs: on
                  ? DEFAULT_CHECKPOINT_CONFIG.scanIntervalMs
                  : MIN_SCAN_INTERVAL_MS,
              })
            }
            aria-label="Scan for Office document changes while idle"
          />
          <span className="text-ink-faint">
            {config.scanIntervalMs <= MIN_SCAN_INTERVAL_MS
              ? "off"
              : `every ${Math.round(config.scanIntervalMs / 60_000)} min while a document is open`}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="text-sm">Extra ignore patterns</div>
        <div className="text-xs text-ink-faint">
          One per line, added to the defaults (<code>~$*</code>, <code>node_modules/</code>,{" "}
          <code>.DS_Store</code>…). Office lock files are ignored automatically.
        </div>
        <textarea
          className="min-h-16 rounded border border-line bg-surface px-2 py-1 font-mono text-xs"
          value={excludeText}
          data-testid="checkpoints-exclude"
          spellCheck={false}
          onChange={(event) => setExcludeText(event.target.value)}
          onBlur={commitExcludes}
        />
      </div>

      <p className="text-xs text-ink-faint" data-testid="checkpoints-retention">
        {describeRetention(config)} · {formatBytes(config.maxBytesPerProject)} per folder.
      </p>
      <p className="text-xs text-ink-faint">
        Automatic snapshots come from a Pi extension and are off in safe mode; manual snapshots and
        the pre-action safety snapshots still work there.
      </p>
    </section>
  );
}

export function SourceControlSettingsCard() {
  const snapshot = useAppStore((state) => {
    const path = state.project?.path;
    return path ? state.git[path] : undefined;
  });
  const loadGit = useAppStore((state) => state.loadGit);
  const projectPath = useAppStore((state) => state.project?.path ?? null);

  useEffect(() => {
    if (projectPath && !snapshot) void loadGit(projectPath);
  }, [projectPath, snapshot, loadGit]);

  const identity = snapshot?.repo?.identity ?? null;
  const available = snapshot?.available ?? false;

  return (
    <section className="card flex flex-col gap-3" data-testid="settings-source-control">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">Source control</h2>
        <p className="text-xs text-ink-muted">
          The panel reads git directly. Authentication is delegated to git (your SSH agent or
          credential helper); the app never stores a credential.
        </p>
      </div>

      <p className="text-xs text-ink-faint" data-testid="source-control-rail-note">
        The panel strip stays on the right edge of a session. <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+
        <Kbd>G</Kbd> expands or collapses the panel.
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-faint">Repository</dt>
        <dd className="truncate" data-testid="source-control-repo">
          {!snapshot
            ? "not read yet"
            : available
              ? (snapshot.repo?.root ?? "unknown")
              : (snapshot.message ?? "unavailable")}
        </dd>
        <dt className="text-ink-faint">Branch</dt>
        <dd className="truncate">
          {available && snapshot?.repo
            ? snapshot.repo.detached
              ? `detached @ ${snapshot.repo.head ?? "?"}`
              : snapshot.repo.empty
                ? "no commits yet"
                : (snapshot.repo.branch ?? "unknown")
            : "—"}
        </dd>
        <dt className="text-ink-faint">Commit identity</dt>
        <dd className="flex items-center gap-2" data-testid="source-control-identity">
          {identity && identity.source !== "unknown" && identity.name.length > 0 ? (
            <>
              <span className="truncate">
                {identity.name} &lt;{identity.email}&gt;
              </span>
              <Badge tone={identity.source === "repo" ? "ok" : "neutral"}>
                {identity.source === "repo" ? "repository-local" : "global"}
              </Badge>
            </>
          ) : (
            <span className="text-ink-faint">
              not configured — set it in the panel&apos;s commit box (repository-local)
            </span>
          )}
        </dd>
      </dl>

      {!available && snapshot?.reason === "git_missing" ? (
        <p className="text-xs text-warn" data-testid="source-control-git-missing">
          git was not found on your PATH. Source control and folder checkpoints need it; git is not
          bundled with the app.
        </p>
      ) : null}

      <p className="text-xs text-ink-faint">
        Status polls while a session tab is open and the window has focus, so a background window
        costs nothing.
      </p>
    </section>
  );
}
