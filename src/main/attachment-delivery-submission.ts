import {
  isAttachmentId,
  isWellFormedAttachmentText,
  type AttachmentAttemptId,
  type AttachmentDraftGrant,
  type AttachmentPromptResult,
  type AttachmentReason,
  type AttachmentTurnId,
} from "../shared/attachments";
import type { AttachmentDeliveryLease, DeliveryContextFence } from "./attachment-delivery-leases";
import type { StagedAttachmentTransfer } from "./attachment-delivery-transfer";

export interface AttachmentDeliverySubmissionInput {
  readonly senderId: number;
  readonly draft: AttachmentDraftGrant;
  readonly representationIds: readonly string[];
  /** Constructed by trusted main context plumbing, never accepted from renderer IPC. */
  readonly context: DeliveryContextFence;
  readonly turnId: AttachmentTurnId;
  readonly attemptId: AttachmentAttemptId;
  readonly text: string;
  readonly explicitRetry?: boolean;
}

export interface AttachmentDeliverySubmissionService {
  submit(input: AttachmentDeliverySubmissionInput): Promise<AttachmentPromptResult>;
}

export interface AttachmentDeliverySubmissionDeps {
  open(input: {
    readonly senderId: number;
    readonly draft: AttachmentDraftGrant;
    readonly representationIds: readonly string[];
    readonly context: DeliveryContextFence;
  }): Promise<AttachmentDeliveryLease>;
  stage(lease: AttachmentDeliveryLease): Promise<StagedAttachmentTransfer>;
  /** Closes only the supplied draft generation after durable acceptance. */
  closeDraft(senderId: number, draft: AttachmentDraftGrant): Promise<void>;
}

function blocked(
  turnId: AttachmentTurnId,
  attemptId: AttachmentAttemptId,
  reason: AttachmentReason,
): AttachmentPromptResult {
  return { outcome: "blocked", reasons: [reason], turnId, attemptId };
}

export function createAttachmentDeliverySubmissionService(
  deps: AttachmentDeliverySubmissionDeps,
): AttachmentDeliverySubmissionService {
  return {
    async submit(input) {
      const { turnId, attemptId } = input;
      if (
        !Number.isSafeInteger(input.senderId) ||
        input.senderId < 0 ||
        !isAttachmentId(turnId) ||
        !isAttachmentId(attemptId) ||
        !isWellFormedAttachmentText(input.text) ||
        !Array.isArray(input.representationIds) ||
        input.representationIds.length === 0
      )
        return blocked(turnId, attemptId, "unavailable");

      let lease: AttachmentDeliveryLease | null = null;
      let staged: StagedAttachmentTransfer | null = null;
      let result: AttachmentPromptResult = blocked(turnId, attemptId, "unavailable");
      try {
        lease = await deps.open({
          senderId: input.senderId,
          draft: input.draft,
          representationIds: input.representationIds,
          context: input.context,
        });
        staged = await deps.stage(lease);
        const planning = await staged.plan(input.text);
        if (planning.outcome === "blocked") {
          result = { outcome: "blocked", reasons: planning.reasons, turnId, attemptId };
          return result;
        }
        try {
          const dispatched = await staged.dispatch({
            planId: planning.plan.id,
            turnId,
            attemptId,
            text: input.text,
            ...(input.explicitRetry === true ? { explicitRetry: true } : {}),
          });
          result =
            dispatched.turnId === turnId && dispatched.attemptId === attemptId
              ? dispatched
              : { outcome: "uncertain", turnId, attemptId };
        } catch {
          // Dispatch may have crossed the private host boundary before a reply was lost.
          result = { outcome: "uncertain", turnId, attemptId };
        }
        if (result.outcome === "accepted") {
          try {
            await deps.closeDraft(input.senderId, input.draft);
          } catch {
            // The journal already proves acceptance. The controller can reconcile
            // this exact generation; do not turn a durable success into a retry.
          }
        }
        return result;
      } catch {
        return result;
      } finally {
        if (staged) {
          await staged.cancel().catch(() => undefined);
        } else {
          try {
            lease?.close();
          } catch {
            /* The lease manager retains/retries failed cleanup. */
          }
        }
      }
    },
  };
}
