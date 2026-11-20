import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
  createPersistedAttachmentController,
  type AttachmentController,
  type AttachmentDraftState,
} from "./controller";
import type {
  AttachmentPreview,
  AttachmentPromptResult,
  AttachmentReadiness,
} from "../../../shared/attachments";

let sharedController: AttachmentController | null = null;

function getSharedController(): AttachmentController | null {
  if (typeof window === "undefined" || !window.pi?.attachments || !window.pi.prefs) return null;
  if (!sharedController) {
    sharedController = createPersistedAttachmentController({
      attachments: window.pi.attachments,
      prefs: window.pi.prefs,
    });
  }
  return sharedController;
}

function emptyState(tabId: string): AttachmentDraftState {
  return {
    tabId,
    generation: 0,
    draftId: null,
    phase: "unavailable",
    descriptors: [],
    readiness: null,
    imports: [],
    issues: [],
    submission: { phase: "idle" },
    error: "unavailable",
  };
}

/** Shared controller with tab-scoped state; panes never receive grants or bytes. */
export function useAttachmentDraft(tabId: string): {
  state: AttachmentDraftState;
  available: boolean;
  importFiles: (files: readonly File[]) => Promise<void>;
  pick: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  preview: (id: string) => Promise<AttachmentPreview | null>;
  dismissIssue: (index: number) => void;
  dismissImport: (operationId: number) => void;
  submit: (text: string) => Promise<AttachmentPromptResult | null>;
  /** Non-submitting readiness; safe to call repeatedly while the composer changes. */
  readiness: (text: string) => Promise<AttachmentReadiness | null>;
  retryDelivery: () => Promise<AttachmentPromptResult | null>;
  resetDraft: () => Promise<boolean>;
} {
  const controller = getSharedController();
  const fallback = useMemo(() => emptyState(tabId), [tabId]);
  const subscribe = useCallback(
    (listener: () => void) =>
      controller
        ? controller.subscribe((changedTab) => {
            if (changedTab === tabId) listener();
          })
        : () => undefined,
    [controller, tabId],
  );
  const getSnapshot = useCallback(
    () => controller?.get(tabId) ?? fallback,
    [controller, fallback, tabId],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (controller) void controller.open(tabId);
  }, [controller, tabId]);

  const importFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (!controller) return;
      for (const file of files) await controller.importFile(tabId, file);
    },
    [controller, tabId],
  );
  const pick = useCallback(async (): Promise<void> => {
    if (controller) await controller.pick(tabId);
  }, [controller, tabId]);
  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (controller) await controller.remove(tabId, id);
    },
    [controller, tabId],
  );
  const preview = useCallback(
    (id: string): Promise<AttachmentPreview | null> =>
      controller ? controller.preview(tabId, id) : Promise.resolve(null),
    [controller, tabId],
  );
  const dismissIssue = useCallback(
    (index: number): void => controller?.dismissIssue(tabId, index),
    [controller, tabId],
  );
  const dismissImport = useCallback(
    (operationId: number): void => controller?.dismissImport(tabId, operationId),
    [controller, tabId],
  );
  const submit = useCallback(
    async (text: string): Promise<AttachmentPromptResult | null> => {
      if (!controller) return null;
      return controller.submit(tabId, text);
    },
    [controller, tabId],
  );
  const readiness = useCallback(
    (text: string): Promise<AttachmentReadiness | null> =>
      controller ? controller.readiness(tabId, text) : Promise.resolve(null),
    [controller, tabId],
  );
  const retryDelivery = useCallback(async (): Promise<AttachmentPromptResult | null> => {
    if (!controller) return null;
    return controller.retryDelivery(tabId);
  }, [controller, tabId]);
  const resetDraft = useCallback(async (): Promise<boolean> => {
    if (!controller) return false;
    return controller.resetDraft(tabId);
  }, [controller, tabId]);

  return {
    state,
    available: controller !== null,
    importFiles,
    pick,
    remove,
    preview,
    dismissIssue,
    dismissImport,
    submit,
    readiness,
    retryDelivery,
    resetDraft,
  };
}
