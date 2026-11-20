import {
  ATTACHMENT_LIMITS,
  isAttachmentId,
  type AttachmentDraftGrant,
  type AttachmentAttemptId,
  type AttachmentPickResult,
  type AttachmentPromptResult,
  type AttachmentReason,
  type AttachmentPreview,
  type AttachmentReadiness,
  type AttachmentTurnId,
  type AttachmentSnapshot,
  type AttachmentDescriptor,
} from "../../../shared/attachments";
import type { AttachmentsBridge, PrefsBridge } from "../../../shared/ipc";
import {
  AttachmentIngestError,
  ingestBrowserAttachment,
  type AttachmentIngestOptions,
  type BrowserAttachmentFile,
} from "./ingest";

export type AttachmentDraftPhase = "idle" | "loading" | "ready" | "unavailable";
export type AttachmentImportPhase = "importing" | "failed" | "uncertain";

export interface AttachmentImportState {
  readonly operationId: number;
  readonly name: string;
  readonly phase: AttachmentImportPhase;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly attachmentId: string | null;
  readonly reason: AttachmentIngestError["reason"] | null;
}

/** Renderer-safe per-tab state. It intentionally contains no grants or file bytes. */
export type AttachmentSubmissionState =
  | { readonly phase: "idle" }
  | { readonly phase: "submitting"; readonly text: string; readonly turnId: AttachmentTurnId }
  | { readonly phase: "blocked"; readonly reasons: readonly AttachmentReason[] }
  | { readonly phase: "handled"; readonly text: string }
  | {
      readonly phase: "uncertain";
      readonly text: string;
      readonly turnId: AttachmentTurnId;
      readonly reasons?: readonly AttachmentReason[];
    }
  /** A journaled attempt no longer matches the shown text/files; replay is unsafe. */
  | {
      readonly phase: "review_required";
      readonly turnId: AttachmentTurnId;
      readonly reason: "text_changed" | "files_changed";
    };

export interface AttachmentDraftState {
  readonly tabId: string;
  readonly generation: number;
  readonly draftId: string | null;
  readonly phase: AttachmentDraftPhase;
  readonly descriptors: readonly AttachmentDescriptor[];
  /** Non-submitting host verdict for the shown files and text; null is unknown. */
  readonly readiness: AttachmentReadiness | null;
  readonly imports: readonly AttachmentImportState[];
  readonly issues: readonly { readonly name: string; readonly reason: string }[];
  readonly submission: AttachmentSubmissionState;
  readonly error: "unavailable" | "draft_reset_failed" | null;
}

export interface AttachmentDraftIdentityPersistence {
  read(tabId: string): Promise<string | null>;
  write(tabId: string, draftId: string | null): Promise<void>;
}

export interface AttachmentControllerOptions {
  bridge: AttachmentsBridge;
  identities: AttachmentDraftIdentityPersistence;
  /** Draft text currently shown for a tab; only its digest is compared. */
  draftText?: (tabId: string) => Promise<string>;
  newId?: () => string;
}

/** Build the controller over the app-owned preferences writer. */
export function createPersistedAttachmentController(input: {
  attachments: AttachmentsBridge;
  prefs: PrefsBridge;
}): AttachmentController {
  let writes = Promise.resolve();
  const identities: AttachmentDraftIdentityPersistence = {
    async read(tabId) {
      const prefs = await input.prefs.get();
      return prefs.attachmentDraftIds[tabId] ?? null;
    },
    write(tabId, draftId) {
      const write = async (): Promise<void> => {
        const prefs = await input.prefs.get();
        const attachmentDraftIds = { ...prefs.attachmentDraftIds };
        if (draftId === null) delete attachmentDraftIds[tabId];
        else attachmentDraftIds[tabId] = draftId;
        await input.prefs.set({ attachmentDraftIds });
      };
      const pending = writes.then(write, write);
      writes = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
  return new AttachmentController({
    bridge: input.attachments,
    identities,
    draftText: async (tabId) => (await input.prefs.get()).drafts[tabId] ?? "",
  });
}

type Listener = (tabId: string, state: AttachmentDraftState) => void;

function emptyDraft(tabId: string, generation = 0): AttachmentDraftState {
  return {
    tabId,
    generation,
    draftId: null,
    phase: "idle",
    descriptors: [],
    readiness: null,
    imports: [],
    issues: [],
    submission: { phase: "idle" },
    error: null,
  };
}

/** Defensive shape check of a host readiness answer for exactly these files. */
function readinessMatches(value: AttachmentReadiness, ids: readonly string[]): boolean {
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length !== ids.length)
    return false;
  if (!Array.isArray(value.reasons) || value.reasons.length > 16) return false;
  if (!Number.isSafeInteger(value.estimatedTokens) || value.estimatedTokens < 0) return false;
  if (typeof value.revision !== "string" || value.revision.length === 0) return false;
  if (value.outcome !== "ready" && value.outcome !== "blocked") return false;
  return value.files.every((file, index) => {
    if (file.id !== ids[index]) return false;
    if (file.status === "ready") return !("reasons" in file);
    return (
      file.status === "blocked" &&
      Array.isArray(file.reasons) &&
      file.reasons.length > 0 &&
      file.reasons.every((reason: string) => typeof reason === "string")
    );
  });
}

function validGrant(value: unknown, tabId: string): value is AttachmentDraftGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  return (
    Object.keys(grant).length === 3 &&
    Object.keys(grant).every((key) => ["tabId", "draftId", "token"].includes(key)) &&
    grant.tabId === tabId &&
    isAttachmentId(grant.draftId) &&
    isAttachmentId(grant.token)
  );
}

/**
 * Owns attachment draft descriptors and asynchronous import lifetimes per tab.
 * Draft IDs are persisted by the caller; main-issued grants and bytes remain
 * transient. A generation bump fences every completion started by an old view.
 */
export class AttachmentController {
  private readonly states = new Map<string, AttachmentDraftState>();
  private readonly grants = new Map<string, AttachmentDraftGrant>();
  private readonly opening = new Map<string, Promise<AttachmentDraftState>>();
  private readonly openIds = new Map<string, number>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly aborters = new Map<string, Map<number, AbortController>>();
  /** Per-tab readiness sequence: only the newest answer may update the tray. */
  private readonly readinessRequests = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private nextOperationId = 1;

  private newId(): string {
    return this.options.newId?.() ?? globalThis.crypto.randomUUID();
  }

  constructor(private readonly options: AttachmentControllerOptions) {}

  get(tabId: string): AttachmentDraftState {
    const current = this.states.get(tabId);
    if (current) return current;
    const initial = emptyDraft(tabId);
    this.states.set(tabId, initial);
    return initial;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(tabId: string, state: AttachmentDraftState): void {
    this.states.set(tabId, state);
    for (const listener of this.listeners) listener(tabId, state);
  }

  private current(tabId: string, generation: number): boolean {
    return this.get(tabId).generation === generation;
  }

  private async closeGrant(tabId: string, grant: AttachmentDraftGrant): Promise<void> {
    const closing = this.options.bridge.closeDraft(grant).catch(() => undefined);
    this.closing.set(tabId, closing);
    try {
      await closing;
    } finally {
      if (this.closing.get(tabId) === closing) this.closing.delete(tabId);
    }
  }

  async open(tabId: string): Promise<AttachmentDraftState> {
    const current = this.get(tabId);
    if (current.error === "draft_reset_failed") return current;
    if (current.phase === "ready" && this.grants.has(tabId)) return current;
    const existing = this.opening.get(tabId);
    if (existing) return existing;

    const generation = current.generation;
    const openId = (this.openIds.get(tabId) ?? 0) + 1;
    this.openIds.set(tabId, openId);
    this.publish(tabId, { ...current, phase: "loading", error: null });
    const pending = (async (): Promise<AttachmentDraftState> => {
      let openedGrant: AttachmentDraftGrant | null = null;
      let retainedGrant = false;
      try {
        await this.closing.get(tabId);
        const requestedDraftId = await this.options.identities.read(tabId);
        if (requestedDraftId !== null && !isAttachmentId(requestedDraftId)) {
          throw new Error("invalid persisted identity");
        }
        if (!this.current(tabId, generation)) return this.get(tabId);

        const grant = await this.options.bridge.openDraft(tabId, requestedDraftId ?? undefined);
        if (
          !validGrant(grant, tabId) ||
          (requestedDraftId !== null && grant.draftId !== requestedDraftId)
        ) {
          throw new Error("invalid draft grant");
        }
        openedGrant = grant;
        if (!this.current(tabId, generation)) return this.get(tabId);

        // Persist before exposing a usable draft or accepting any upload. If this
        // fails, the owner ID could be lost on restart and the assets orphaned.
        if (requestedDraftId === null) await this.options.identities.write(tabId, grant.draftId);
        if (!this.current(tabId, generation)) return this.get(tabId);

        const descriptors = await this.options.bridge.list(grant);
        if (!this.current(tabId, generation)) return this.get(tabId);
        this.grants.set(tabId, grant);
        retainedGrant = true;
        const recovered = await this.recoverSubmission(tabId, grant, descriptors, generation);
        if (!this.current(tabId, generation)) return this.get(tabId);
        if (recovered === "reset") {
          // Durable acceptance on disk: the prior generation was delivered, so
          // start a clean draft instead of showing an uncertain/stale one.
          await this.options.identities.write(tabId, null);
          await this.closeGrant(tabId, grant);
          this.grants.delete(tabId);
          retainedGrant = false;
          const reset = emptyDraft(tabId, generation + 1);
          this.publish(tabId, reset);
          return reset;
        }
        const ready: AttachmentDraftState = {
          ...this.get(tabId),
          draftId: grant.draftId,
          phase: "ready",
          descriptors: [...descriptors],
          readiness: null,
          submission: recovered ?? { phase: "idle" },
          error: null,
        };
        this.publish(tabId, ready);
        return ready;
      } catch {
        if (!this.current(tabId, generation)) return this.get(tabId);
        this.grants.delete(tabId);
        const unavailable: AttachmentDraftState = {
          ...this.get(tabId),
          phase: "unavailable",
          error: "unavailable",
        };
        this.publish(tabId, unavailable);
        return unavailable;
      } finally {
        if (openedGrant && !retainedGrant) await this.closeGrant(tabId, openedGrant);
        if (this.openIds.get(tabId) === openId) this.opening.delete(tabId);
      }
    })();
    this.opening.set(tabId, pending);
    return pending;
  }

  /** A send in flight, or one whose outcome needs a user decision, freezes edits. */
  private frozen(state: AttachmentDraftState): boolean {
    const phase = state.submission.phase;
    return phase === "submitting" || phase === "uncertain" || phase === "review_required";
  }

  /**
   * Restore durable submission state after a restart (or a lost grant). The
   * journal is metadata-only; the status route compares the shown text/files by
   * digest/ID and never returns their content.
   */
  private async recoverSubmission(
    tabId: string,
    grant: AttachmentDraftGrant,
    descriptors: readonly AttachmentSnapshot[],
    generation: number,
  ): Promise<AttachmentSubmissionState | "reset" | null> {
    try {
      const text = this.options.draftText ? await this.options.draftText(tabId) : "";
      const status = await this.options.bridge.status({
        draft: grant,
        text,
        attachmentIds: descriptors.map((descriptor) => descriptor.id),
      });
      if (!this.current(tabId, generation)) return null;
      const turnId = (status.turnId ?? grant.draftId) as AttachmentTurnId;
      switch (status.phase) {
        case "accepted":
          return "reset";
        case "handled":
          return { phase: "handled", text };
        case "blocked":
          return {
            phase: "blocked",
            reasons: status.result?.outcome === "blocked" ? status.result.reasons : ["stale_plan"],
          };
        case "dispatching":
        case "uncertain":
          if (!status.textMatches || !status.filesMatch) {
            // Replaying the shown draft would submit different content than the
            // journaled attempt. Require an explicit new draft instead.
            return {
              phase: "review_required",
              turnId,
              reason: status.textMatches ? "files_changed" : "text_changed",
            };
          }
          return {
            phase: "uncertain",
            text,
            turnId,
            ...(status.result?.outcome === "blocked" ? { reasons: status.result.reasons } : {}),
          };
        default:
          return null;
      }
    } catch {
      // A status failure is not evidence of acceptance or failure; leave the
      // draft editable and let an explicit Send surface the real condition.
      return null;
    }
  }

  async refresh(tabId: string): Promise<AttachmentDraftState> {
    const state = await this.open(tabId);
    if (state.phase !== "ready") return state;
    const grant = this.grants.get(tabId);
    if (!grant) return this.get(tabId);
    const generation = state.generation;
    try {
      const descriptors = await this.options.bridge.list(grant);
      if (!this.current(tabId, generation)) return this.get(tabId);
      const refreshed = {
        ...this.get(tabId),
        descriptors: [...descriptors],
        readiness: null,
      };
      this.publish(tabId, refreshed);
      return refreshed;
    } catch {
      if (!this.current(tabId, generation)) return this.get(tabId);
      const unavailable: AttachmentDraftState = {
        ...this.get(tabId),
        phase: "unavailable",
        error: "unavailable",
      };
      this.publish(tabId, unavailable);
      return unavailable;
    }
  }

  async importFile(
    tabId: string,
    file: BrowserAttachmentFile,
    options: Omit<AttachmentIngestOptions, "signal" | "onProgress"> = {},
  ): Promise<AttachmentDraftState> {
    const state = await this.open(tabId);
    const grant = this.grants.get(tabId);
    if (state.phase !== "ready" || !grant || this.frozen(state)) return state;
    const generation = state.generation;
    const operationId = this.nextOperationId++;
    const controller = new AbortController();
    const tabAborters = this.aborters.get(tabId) ?? new Map<number, AbortController>();
    tabAborters.set(operationId, controller);
    this.aborters.set(tabId, tabAborters);
    const progress: AttachmentImportState = {
      operationId,
      name: file.name,
      phase: "importing",
      bytesRead: 0,
      totalBytes: file.size,
      attachmentId: null,
      reason: null,
    };
    this.publish(tabId, {
      ...this.get(tabId),
      imports: [...this.get(tabId).imports, progress],
      submission: { phase: "idle" },
    });

    const updateImport = (update: Partial<AttachmentImportState>): void => {
      if (!this.current(tabId, generation)) return;
      const latest = this.get(tabId);
      this.publish(tabId, {
        ...latest,
        imports: latest.imports.map((item) =>
          item.operationId === operationId ? { ...item, ...update } : item,
        ),
      });
    };

    try {
      const snapshot = await ingestBrowserAttachment(this.options.bridge, grant, file, {
        ...options,
        signal: controller.signal,
        onProgress: (bytesRead, totalBytes) => updateImport({ bytesRead, totalBytes }),
      });
      if (!this.current(tabId, generation)) {
        await this.options.bridge.remove(grant, snapshot.id).catch(() => undefined);
        return this.get(tabId);
      }
      const latest = this.get(tabId);
      // Descriptors are classification output, never the import snapshot: ask
      // main again so status/reason/detected MIME stay authoritative.
      const descriptors = await this.options.bridge.list(grant).catch(() => null);
      if (!this.current(tabId, generation)) return this.get(tabId);
      this.publish(tabId, {
        ...latest,
        ...(descriptors ? { descriptors: [...descriptors] } : {}),
        readiness: null,
        imports: latest.imports.filter((item) => item.operationId !== operationId),
      });
    } catch (cause) {
      const ingestError =
        cause instanceof AttachmentIngestError ? cause : new AttachmentIngestError("failed");
      if (!this.current(tabId, generation)) {
        if (ingestError.attachmentId) {
          await this.options.bridge.remove(grant, ingestError.attachmentId).catch(() => undefined);
        }
        return this.get(tabId);
      }
      updateImport({
        phase: ingestError.reason === "uncertain" ? "uncertain" : "failed",
        attachmentId: ingestError.attachmentId,
        reason: ingestError.reason,
      });
      if (ingestError.reason === "uncertain") await this.refresh(tabId);
    } finally {
      tabAborters.delete(operationId);
      if (tabAborters.size === 0) this.aborters.delete(tabId);
    }
    return this.get(tabId);
  }

  async pick(tabId: string): Promise<readonly AttachmentPickResult[] | null> {
    const state = await this.open(tabId);
    const grant = this.grants.get(tabId);
    if (state.phase !== "ready" || !grant || this.frozen(state)) return null;
    const generation = state.generation;
    try {
      const results = await this.options.bridge.pick(grant);
      if (results === null || !this.current(tabId, generation)) return results;
      const descriptors = await this.options.bridge.list(grant);
      if (!this.current(tabId, generation)) return results;
      const issues = results.flatMap((result) =>
        result.ok ? [] : [{ name: result.name, reason: result.reason }],
      );
      this.publish(tabId, {
        ...this.get(tabId),
        descriptors: [...descriptors],
        issues,
        submission: { phase: "idle" },
      });
      return results;
    } catch {
      if (this.current(tabId, generation)) {
        this.publish(tabId, { ...this.get(tabId), error: "unavailable", phase: "unavailable" });
      }
      return null;
    }
  }

  async remove(tabId: string, attachmentId: string): Promise<boolean> {
    const state = await this.open(tabId);
    const grant = this.grants.get(tabId);
    if (state.phase !== "ready" || !grant || this.frozen(state)) return false;
    const generation = state.generation;
    try {
      await this.options.bridge.remove(grant, attachmentId);
      if (!this.current(tabId, generation)) return false;
      this.publish(tabId, {
        ...this.get(tabId),
        descriptors: this.get(tabId).descriptors.filter((item) => item.id !== attachmentId),
        readiness: null,
        submission: { phase: "idle" },
      });
      return true;
    } catch {
      return false;
    }
  }

  async preview(tabId: string, attachmentId: string): Promise<AttachmentPreview | null> {
    const state = await this.open(tabId);
    const grant = this.grants.get(tabId);
    if (
      state.phase !== "ready" ||
      !grant ||
      !state.descriptors.some((item) => item.id === attachmentId)
    ) {
      return null;
    }
    const generation = state.generation;
    try {
      const result = await this.options.bridge.preview(
        grant,
        attachmentId,
        ATTACHMENT_LIMITS.previewBytes,
      );
      if (
        !this.current(tabId, generation) ||
        !(result.bytes instanceof Uint8Array) ||
        !Number.isSafeInteger(result.size) ||
        result.size < result.bytes.byteLength ||
        result.bytes.byteLength > ATTACHMENT_LIMITS.previewBytes ||
        (result.kind !== "text" && result.kind !== "image") ||
        typeof result.mimeType !== "string" ||
        result.mimeType.length === 0 ||
        result.mimeType.length > 128
      ) {
        return null;
      }
      return {
        ...result,
        bytes: new Uint8Array(result.bytes),
        mimeType: result.mimeType,
      };
    } catch {
      return null;
    }
  }

  /**
   * Non-submitting readiness for the shown files and text. Bounded and stale-
   * fenced: a newer request, generation change or descriptor change discards the
   * answer, and nothing here creates or consumes send authority.
   */
  async readiness(tabId: string, text: string): Promise<AttachmentReadiness | null> {
    const state = await this.open(tabId);
    const grant = this.grants.get(tabId);
    if (state.phase !== "ready" || !grant || state.descriptors.length === 0) return null;
    const generation = state.generation;
    const ids = state.descriptors.map((descriptor) => descriptor.id);
    const request = (this.readinessRequests.get(tabId) ?? 0) + 1;
    this.readinessRequests.set(tabId, request);
    try {
      const result = await this.options.bridge.readiness({
        draft: grant,
        text,
        attachmentIds: ids,
      });
      if (
        !this.current(tabId, generation) ||
        this.readinessRequests.get(tabId) !== request ||
        !readinessMatches(result, ids)
      ) {
        return null;
      }
      this.publish(tabId, { ...this.get(tabId), readiness: result });
      return result;
    } catch {
      return null;
    }
  }

  async submit(tabId: string, text: string): Promise<AttachmentPromptResult | null> {
    return this.submitDelivery(tabId, text, false);
  }

  async retryDelivery(tabId: string): Promise<AttachmentPromptResult | null> {
    const submission = this.get(tabId).submission;
    if (submission.phase !== "uncertain") return null;
    return this.submitDelivery(tabId, submission.text, true);
  }

  private async submitDelivery(
    tabId: string,
    sourceText: string,
    explicitRetry: boolean,
  ): Promise<AttachmentPromptResult | null> {
    const opened = await this.open(tabId);
    const state = this.get(tabId);
    const grant = this.grants.get(tabId);
    const previousSubmission = state.submission;
    if (
      opened.phase !== "ready" ||
      state.phase !== "ready" ||
      !grant ||
      state.descriptors.length === 0 ||
      state.imports.length > 0 ||
      state.issues.length > 0 ||
      previousSubmission.phase === "submitting" ||
      previousSubmission.phase === "review_required" ||
      (previousSubmission.phase === "uncertain" && !explicitRetry) ||
      (explicitRetry && previousSubmission.phase !== "uncertain")
    ) {
      return null;
    }
    const text = previousSubmission.phase === "uncertain" ? previousSubmission.text : sourceText;
    const turnId = grant.draftId as AttachmentTurnId;
    const attemptId = this.newId() as AttachmentAttemptId;
    if (!isAttachmentId(turnId) || !isAttachmentId(attemptId)) return null;
    const generation = state.generation;
    this.publish(tabId, {
      ...state,
      submission: { phase: "submitting", text, turnId },
    });

    let result: AttachmentPromptResult;
    try {
      const response = await this.options.bridge.submit({
        draft: grant,
        attachmentIds: state.descriptors.map((descriptor) => descriptor.id),
        turnId,
        attemptId,
        explicitRetry,
        text,
      });
      if (
        !response ||
        response.turnId !== turnId ||
        response.attemptId !== attemptId ||
        !["blocked", "handled", "accepted", "uncertain"].includes(response.outcome)
      ) {
        throw new Error("invalid attachment submission result");
      }
      result = response;
    } catch {
      result = { outcome: "uncertain", turnId, attemptId };
    }
    if (!this.current(tabId, generation)) return result;
    if (result.outcome === "accepted") {
      await this.advanceGeneration(tabId);
      return result;
    }
    const latest = this.get(tabId);
    // Only an actually ambiguous outcome is uncertain. An explicit retry that
    // returns a definitive blocked/handled result must stay definitive.
    if (result.outcome === "uncertain") {
      this.publish(tabId, {
        ...latest,
        submission: { phase: "uncertain", text, turnId },
      });
    } else if (result.outcome === "handled") {
      this.publish(tabId, { ...latest, submission: { phase: "handled", text } });
    } else {
      this.publish(tabId, { ...latest, submission: { phase: "blocked", reasons: result.reasons } });
    }
    return result;
  }

  dismissIssue(tabId: string, index: number): void {
    const state = this.get(tabId);
    if (!this.current(tabId, state.generation)) return;
    this.publish(tabId, {
      ...state,
      issues: state.issues.filter((_issue, issueIndex) => issueIndex !== index),
    });
  }

  dismissImport(tabId: string, operationId: number): void {
    const state = this.get(tabId);
    const target = state.imports.find((item) => item.operationId === operationId);
    if (!target || target.phase === "importing") return;
    this.publish(tabId, {
      ...state,
      imports: state.imports.filter((item) => item.operationId !== operationId),
    });
  }

  /** Start a clean draft only after the host has durably accepted the prior turn. */
  async advanceGeneration(tabId: string): Promise<boolean> {
    const previous = this.get(tabId);
    const generation = previous.generation + 1;
    const grant = this.grants.get(tabId);
    const opening = this.opening.get(tabId);
    for (const aborter of this.aborters.get(tabId)?.values() ?? []) aborter.abort();
    this.aborters.delete(tabId);
    this.grants.delete(tabId);
    this.publish(tabId, {
      ...emptyDraft(tabId, generation),
      phase: "unavailable",
      error: "draft_reset_failed",
    });
    try {
      if (grant) await this.closeGrant(tabId, grant);
      if (opening) await opening;
      await this.options.identities.write(tabId, null);
      this.publish(tabId, emptyDraft(tabId, generation));
      return true;
    } catch {
      return false;
    }
  }

  /** Explicit user decision to discard an unresolved attempt and start fresh. */
  async resetDraft(tabId: string): Promise<boolean> {
    return this.advanceGeneration(tabId);
  }

  /** Drop renderer memory when a tab is closed; app-owned draft identity is retained. */
  forgetTab(tabId: string): void {
    for (const aborter of this.aborters.get(tabId)?.values() ?? []) aborter.abort();
    this.aborters.delete(tabId);
    this.opening.delete(tabId);
    this.openIds.set(tabId, (this.openIds.get(tabId) ?? 0) + 1);
    const grant = this.grants.get(tabId);
    this.grants.delete(tabId);
    if (grant) void this.closeGrant(tabId, grant);
    this.publish(tabId, emptyDraft(tabId, this.get(tabId).generation + 1));
  }
}
