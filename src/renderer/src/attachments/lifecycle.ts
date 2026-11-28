/**
 * Attachment tab-lifecycle bridge (plan step 10).
 *
 * The attachment controller owns renderer memory per tab, but the app store owns
 * the authoritative tab table. A tiny registry lets the store announce a real
 * tab removal without importing the controller (or its grants), and lets the
 * shared controller subscribe exactly once. Closing a tab must cancel imports,
 * expire stale callbacks and release ephemeral grants, while the durable draft
 * identity in app prefs is retained for recovery.
 */

export type AttachmentTabClosedListener = (tabId: string) => void;

const listeners = new Set<AttachmentTabClosedListener>();

export function onAttachmentTabClosed(listener: AttachmentTabClosedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Notifies every subscriber once per tab id that actually disappeared. */
export function notifyAttachmentTabClosed(tabIds: readonly string[]): void {
  const unique = new Set(tabIds.filter((id) => typeof id === "string" && id.length > 0));
  for (const tabId of unique) {
    for (const listener of [...listeners]) {
      try {
        listener(tabId);
      } catch {
        // Teardown is best-effort: one failing subscriber must not strand the
        // others or resurrect the closed tab's state.
      }
    }
  }
}

/**
 * Does this tab hold selected files in a managed draft? Direct store/menu send
 * paths consult this so they can never silently send text-only while files are
 * retained (plan step 10).
 */
let draftPresence: ((tabId: string) => boolean) | null = null;

export function setAttachmentDraftPresence(predicate: ((tabId: string) => boolean) | null): void {
  draftPresence = predicate;
}

export function hasAttachmentDraft(tabId: string): boolean {
  if (!draftPresence) return false;
  try {
    return draftPresence(tabId) === true;
  } catch {
    return false;
  }
}
