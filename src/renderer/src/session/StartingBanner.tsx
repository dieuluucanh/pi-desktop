import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

/**
 * The "starting" affordance (2026-11-06 hang plan, step 4).
 *
 * Opening a session loads its whole JSONL and boots every extension, which can
 * take a while on a large profile. The old view showed a blank transcript and a
 * disabled-looking composer with no explanation, so a slow open was
 * indistinguishable from a hang. This banner names the work, counts the seconds
 * and offers the one action that always helps: Cancel.
 *
 * Cancel stops the host and leaves the tab asleep; clicking the tab resumes it
 * from the same session file, so nothing is lost.
 *
 * The parent mounts this with `key={<tab id>}`: a different tab means a fresh
 * start time, which keeps the clock out of render (and out of effects that would
 * set state synchronously).
 */

export interface StartingBannerProps {
  onCancel: () => void;
}

export function StartingBanner({ onCancel }: StartingBannerProps) {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(0);

  useEffect(() => {
    startedAt.current = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt.current) / 1_000));
    }, 1_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="session-starting"
      className="banner mx-4 mt-2 flex items-start justify-between gap-3"
    >
      <span>
        Starting the session{elapsed > 0 ? ` — ${elapsed}s` : "…"}{" "}
        <span className="text-ink-faint">Loading this session&apos;s history and extensions.</span>
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={onCancel}
        data-testid="session-starting-cancel"
      >
        Cancel
      </Button>
    </div>
  );
}
