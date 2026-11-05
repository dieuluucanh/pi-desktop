/**
 * Shell-profile discovery for the renderer (2026-11-05 terminal follow-up plan).
 *
 * Main owns detection and the profile cache; this hook only asks for the current
 * snapshot. The settings card loads eagerly, while the strip's one-off menu loads
 * when it first opens. A missing preload bridge is a reported state, never a
 * crash: the card and menu both render an explanation instead of an empty list.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalProfileSnapshot } from "../../../shared/terminal-profiles";

export interface TerminalProfilesState {
  snapshot: TerminalProfileSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: (force?: boolean) => Promise<void>;
}

export function useTerminalProfiles(autoLoad = true): TerminalProfilesState {
  const [snapshot, setSnapshot] = useState<TerminalProfileSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (force = false): Promise<void> => {
    const terminal = window.pi?.terminal;
    if (!terminal) {
      if (mounted.current) setError("The terminal bridge is unavailable.");
      return;
    }
    if (mounted.current) setLoading(true);
    try {
      const next = await terminal.profiles(force);
      if (!mounted.current) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return;
    let cancelled = false;
    // Defer the first load past the effect body: the hook reports `loading`
    // immediately, and a synchronous setState here would cascade a render.
    void (async () => {
      await Promise.resolve();
      if (!cancelled) await refresh(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [autoLoad, refresh]);

  return { snapshot, loading, error, refresh };
}
