import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Wand2,
  X,
} from "lucide-react";
import type { ComposerControlDescriptor } from "../../../shared/composer-operation";
import type { ComposerControlIcon } from "../../../shared/composer-transform";
import { CONTRIBUTION_TONES, type ContributionTone } from "../../../shared/extension-contributions";
import { cn } from "../ui/cn";
import { contributionTextClass } from "./contribution-tone";
import {
  COMPOSER_ARMED_HINT,
  MAX_VISIBLE_COMPOSER_CONTROLS,
  composerControlKey,
} from "./composer-controls-model";

/**
 * Generic bottom-right composer controls (2026-11-22 prompt-refinement plan,
 * step 21).
 *
 * The row is a renderer for the additive `composer-control` contribution kind.
 * It knows nothing about which extension published a control: labels, tones,
 * icons, arming and disabled reasons all come from the projected descriptor, and
 * activation forwards the control's same-owner `actionRef` to the host (which
 * re-validates provenance before running anything). There is no branch on a
 * label, owner id or status string, so a second, unrelated publisher gets the
 * same UI with no Desktop change.
 *
 * Behaviours pinned here:
 *  - pointer activation keeps the composer's focus, caret and selection
 *    (`pointerdown` is default-prevented, exactly like the mode control);
 *  - keyboard activation is an ordinary focused-button Enter/Space, so Tab plus
 *    the usual activation keys work;
 *  - a disabled control exposes its reason as text and as the tooltip instead of
 *    silently doing nothing;
 *  - a pending activation is announced, not re-fired, and never loses focus;
 *  - the row is bounded (`overflow-x-auto` over a capped visible list) so a
 *    verbose publisher cannot hide Send/Stop on a narrow window;
 *  - one polite live region announces arming/activation, and an armed control
 *    states the one-shot contract: "Send refines, does not run".
 */

const ICONS: Record<ComposerControlIcon, typeof Sparkles> = {
  sparkles: Sparkles,
  wand: Wand2,
  refresh: RefreshCw,
  edit: Pencil,
  check: Check,
  close: X,
  "chevron-up": ChevronUp,
  "chevron-down": ChevronDown,
  play: Play,
  pause: Pause,
  stop: Square,
  alert: AlertTriangle,
};

/** An unknown/foreign tone falls back to the neutral one, never to raw CSS. */
function toneOf(value: string | undefined): ContributionTone {
  return (CONTRIBUTION_TONES as readonly string[]).includes(value ?? "")
    ? (value as ContributionTone)
    : "neutral";
}

export interface ComposerControlsProps {
  /** Projected descriptors, including disabled ones (they show their reason). */
  controls: readonly ComposerControlDescriptor[];
  /**
   * Keys (`composerControlKey`) armed right now, published plus local. Omitted
   * means "render the published `checked` flag" (a host with no operation
   * reducer); an explicit list — including an empty one — is authoritative,
   * because routing Send uses exactly that derived set.
   */
  armedKeys?: readonly string[];
  /**
   * True while an operation started from this row is active. Controls stay
   * visible (so the user can see what is running) but cannot start a second one.
   */
  busy?: boolean;
  /** Derived conflict text (multiple armed controls, stale descriptor, …). */
  conflictMessage?: string | null;
  /**
   * Runs the control's same-owner toggle action through the host. Resolves true
   * when the host acknowledged an error-free invocation; the rendered state
   * follows the next contribution snapshot, never an optimistic guess.
   */
  onActivate: (control: ComposerControlDescriptor) => Promise<boolean> | boolean;
  className?: string;
}

function ControlButton({
  control,
  checked,
  pending,
  busy,
  onActivate,
}: {
  control: ComposerControlDescriptor;
  checked: boolean;
  pending: boolean;
  busy: boolean;
  onActivate: (control: ComposerControlDescriptor) => void;
}) {
  const Icon = control.icon ? ICONS[control.icon] : null;
  const active = checked || pending;
  const tone = active ? contributionTextClass(toneOf(control.tone)) : "text-ink-muted";
  const tooltip = control.disabledReason ?? control.description ?? control.label;
  // While an operation runs, an *armed* control stays operable so the user can
  // turn it off (that cancels and disarms); an unarmed one is blocked because
  // starting a second operation is never what a click means there.
  const blocked = !control.enabled || pending || (busy && !checked);
  const accessibleName = [
    control.label,
    checked ? "on" : "off",
    !control.enabled && control.disabledReason ? control.disabledReason : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" — ");

  return (
    <button
      type="button"
      data-testid="composer-control"
      data-owner={control.ownerId}
      data-control-id={control.id}
      data-checked={checked ? "true" : "false"}
      data-enabled={control.enabled ? "true" : "false"}
      data-pending={pending ? "true" : "false"}
      data-behavior={control.behavior}
      data-tone={control.tone}
      aria-label={accessibleName}
      aria-pressed={checked}
      aria-busy={pending ? true : undefined}
      // A disabled control is unreachable by keyboard and pointer, and its
      // reason is still readable in the tooltip/announcement.
      disabled={!control.enabled}
      title={tooltip}
      // Keep the prompt's focus, caret and selection on a pointer click; the
      // keyboard path still focuses this button normally.
      onPointerDown={(event) => event.preventDefault()}
      // `aria-disabled` on a pending control instead of `disabled`: a keyboard
      // user who pressed Enter keeps focus while the host acknowledges.
      aria-disabled={control.enabled && blocked ? true : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (blocked) return;
        void onActivate(control);
      }}
      className={cn(
        "inline-flex h-6 max-w-[12rem] shrink-0 items-center gap-1 rounded-xs border px-1.5 text-[11px] font-medium",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked || pending ? "border-line-strong bg-raised" : "border-line bg-transparent",
        tone,
      )}
    >
      {pending ? (
        <RefreshCw
          className="size-3 animate-spin"
          aria-hidden
          data-testid="composer-control-spin"
        />
      ) : Icon ? (
        <Icon className="size-3" aria-hidden data-testid="composer-control-icon" />
      ) : null}
      <span className="min-w-0 truncate">{control.label}</span>
      {!control.enabled && control.disabledReason ? (
        <span className="shrink-0 text-[10px] text-ink-faint">· {control.disabledReason}</span>
      ) : null}
    </button>
  );
}

export function ComposerControls({
  controls,
  armedKeys,
  busy = false,
  conflictMessage = null,
  onActivate,
  className,
}: ComposerControlsProps) {
  const [pendingKeys, setPendingKeys] = useState<readonly string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  // The live regions/controls can outlive one activation; ignore a late
  // acknowledgement for an unmounted row instead of calling setState on it.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const armed = armedKeys ? new Set(armedKeys) : null;
  const isChecked = (control: ComposerControlDescriptor): boolean =>
    armed ? armed.has(composerControlKey(control)) : control.checked;
  const visible = controls.slice(0, MAX_VISIBLE_COMPOSER_CONTROLS);
  const overflow = controls.slice(MAX_VISIBLE_COMPOSER_CONTROLS);
  const armedCount = controls.filter(isChecked).length;

  const activate = useCallback(
    async (control: ComposerControlDescriptor): Promise<void> => {
      const key = composerControlKey(control);
      if (pendingKeys.includes(key)) return;
      setPendingKeys((keys) => [...keys, key]);
      setAnnouncement(`${control.label}: ${control.checked ? "turning off" : "turning on"}`);
      try {
        const acknowledged = await onActivate(control);
        if (!mountedRef.current) return;
        setAnnouncement(
          acknowledged
            ? `${control.label}: ${control.checked ? "off" : "on"}`
            : `${control.label}: the host did not confirm the change`,
        );
      } catch {
        if (!mountedRef.current) return;
        setAnnouncement(`${control.label}: ${control.disabledReason ?? "could not be changed"}`);
      } finally {
        if (mountedRef.current) {
          setPendingKeys((keys) => keys.filter((entry) => entry !== key));
        }
      }
    },
    [onActivate, pendingKeys],
  );

  if (controls.length === 0) return null;

  return (
    <div
      data-testid="composer-controls"
      data-count={controls.length}
      data-armed={armedCount}
      role="group"
      aria-label="Composer controls"
      className={cn("flex min-w-0 items-center justify-end gap-1 overflow-x-auto", className)}
    >
      {armedCount > 0 ? (
        <span
          data-testid="composer-armed-hint"
          className="shrink-0 text-[10px] text-ink-muted"
          title="While a control is armed, Send hands the draft to it instead of running the agent."
        >
          {COMPOSER_ARMED_HINT}
        </span>
      ) : null}
      {conflictMessage ? (
        <span
          data-testid="composer-controls-conflict"
          className="shrink-0 text-[10px] text-warn"
          title={conflictMessage}
        >
          {conflictMessage}
        </span>
      ) : null}
      {visible.map((control) => (
        <ControlButton
          key={composerControlKey(control)}
          control={control}
          checked={isChecked(control)}
          pending={pendingKeys.includes(composerControlKey(control))}
          busy={busy}
          onActivate={activate}
        />
      ))}
      {overflow.length > 0 ? (
        <span
          data-testid="composer-controls-more"
          data-count={overflow.length}
          className="shrink-0 text-[10px] text-ink-faint"
          title={overflow.map((control) => control.label).join(", ")}
        >
          +{overflow.length}
        </span>
      ) : null}
      {/* One polite announcement for actual changes; never per keystroke. */}
      <span
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="composer-controls-status"
      >
        {announcement}
      </span>
    </div>
  );
}
