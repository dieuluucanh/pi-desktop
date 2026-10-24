/**
 * The host-side observer for extension-driven model/thinking changes.
 *
 * Pi announces a model change to **extensions** only: `AgentSession.setModel`
 * awaits `_emitModelSelect`, which calls
 * `ExtensionRunner.emit({ type: "model_select", … })` and never the session's
 * own `_emit`. The session's `subscribe()` stream therefore cannot see it, and
 * the host's state snapshot would keep the old model after an extension (the
 * workflow `/profile` picker or a role switch) changes it.
 *
 * `emit` is the only host-visible broadcast, so this adapter wraps it for the
 * two selection events and leaves every other event untouched. The returned
 * disposer restores the original method; the session core owns its lifetime
 * (`attach` / `dispose`).
 */

type EmitEvent = { type: string; [key: string]: unknown };
type RunnerEmit = (event: EmitEvent) => Promise<unknown>;

interface RunnerLike {
  emit?: unknown;
}

function runnerOf(session: unknown): RunnerLike | null {
  const runner = (session as { extensionRunner?: unknown } | null | undefined)?.extensionRunner;
  return runner && typeof runner === "object" ? (runner as RunnerLike) : null;
}

/**
 * Calls `onChange` after the SDK has announced a new model or thinking level.
 *
 * The callback runs after the extension handlers settle (so the snapshot it
 * triggers reads the completed switch) and on both fulfilment and rejection.
 * A throwing callback is swallowed: pushing app state must never break the
 * SDK's extension dispatch.
 */
export function observeSdkModelChanges(session: unknown, onChange: () => void): () => void {
  const runner = runnerOf(session);
  if (!runner || typeof runner.emit !== "function") return () => undefined;

  const original = runner.emit as RunnerEmit;
  const hadOwn = Object.prototype.hasOwnProperty.call(runner, "emit");

  const safeOnChange = (): void => {
    try {
      onChange();
    } catch {
      // A state push is best effort; the SDK's event flow is not.
    }
  };

  const wrapped: RunnerEmit = (event) => {
    let result: Promise<unknown>;
    try {
      result = Promise.resolve(original.call(runner, event));
    } catch (error) {
      // `emit` is async upstream; surface a synchronous throw the same way.
      safeOnChange();
      return Promise.reject(error);
    }
    if (event.type === "model_select" || event.type === "thinking_level_select") {
      return result.finally(safeOnChange);
    }
    return result;
  };

  runner.emit = wrapped;

  return () => {
    // A later observer owns the method if it replaced our wrapper.
    if (runner.emit !== wrapped) return;
    if (hadOwn) runner.emit = original;
    else delete runner.emit;
  };
}
