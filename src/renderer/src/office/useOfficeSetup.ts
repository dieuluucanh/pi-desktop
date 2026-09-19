import { useCallback, useEffect, useRef, useState } from "react";
import type { OfficeSetupStepId, OfficeSetupView } from "../../../shared/office-setup";

/**
 * Binds the React panel to the Office setup IPC surface.
 *
 * The main process pushes a new view after every wizard transition
 * (`office:state`) and every action also resolves with the resulting view, so
 * the panel is correct even if a push is missed while the window is hidden.
 */

export interface OfficeSetupApi {
  view: OfficeSetupView | null;
  error: string | null;
  busy: boolean;
  diagnostics: string | null;
  started(): boolean;
  run(): void;
  /** Stops the Office session's current run (the task pane's run). */
  stopRun(): void;
  retry(step: OfficeSetupStepId): void;
  cancel(): void;
  refreshHealth(): void;
  unsideload(): void;
  loadDiagnostics(): void;
  reveal(path: string): void;
}

export function useOfficeSetup(): OfficeSetupApi {
  const [view, setView] = useState<OfficeSetupView | null>(null);
  const [error, setError] = useState<string | null>(() =>
    window.pi?.office ? null : "The preload bridge is unavailable (window.pi.office is missing).",
  );
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const bridge = window.pi?.office;
    if (!bridge) return;

    const unsubscribe = bridge.onState((next) => {
      if (mounted.current) setView(next);
    });

    bridge
      .get()
      .then((initial) => {
        if (mounted.current) setView(initial);
      })
      .catch((cause: unknown) => {
        if (mounted.current) setError(describe(cause));
      });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, []);

  const call = useCallback(
    (action: (office: NonNullable<Window["pi"]>["office"]) => Promise<OfficeSetupView>) => {
      const bridge = window.pi?.office;
      if (!bridge) {
        setError("The preload bridge is unavailable (window.pi.office is missing).");
        return;
      }
      setBusy(true);
      setError(null);
      action(bridge)
        .then((next) => {
          if (mounted.current) setView(next);
        })
        .catch((cause: unknown) => {
          if (mounted.current) setError(describe(cause));
        })
        .finally(() => {
          if (mounted.current) setBusy(false);
        });
    },
    [],
  );

  return {
    view,
    error,
    busy,
    diagnostics,
    started: () => view !== null && view.status !== "idle",
    run: () => call((office) => office.start()),
    retry: (step) => call((office) => office.retry(step)),
    cancel: () => call((office) => office.cancel()),
    stopRun: () => {
      const bridge = window.pi?.office;
      if (!bridge) {
        setError("The preload bridge is unavailable (window.pi.office is missing).");
        return;
      }
      setBusy(true);
      setError(null);
      bridge
        .stopRun()
        .then((result) => {
          if (!mounted.current) return;
          if (!result.ok) {
            setError(
              result.reason === "idle"
                ? "Nothing is running in the Office session."
                : `Stop failed: ${result.error ?? "the host did not answer"}`,
            );
            return;
          }
          // An aborted run does not broadcast a view of its own, so pull one.
          void bridge.refreshHealth().then((next) => {
            if (mounted.current) setView(next);
          });
        })
        .catch((cause: unknown) => {
          if (mounted.current) setError(describe(cause));
        })
        .finally(() => {
          if (mounted.current) setBusy(false);
        });
    },
    refreshHealth: () => call((office) => office.refreshHealth()),
    unsideload: () => call((office) => office.unsideload()),
    loadDiagnostics: () => {
      window.pi?.office
        .diagnostics()
        .then((text) => {
          if (mounted.current) setDiagnostics(text);
        })
        .catch((cause: unknown) => {
          if (mounted.current) setError(describe(cause));
        });
    },
    reveal: (path) => {
      void window.pi?.office.reveal(path);
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
