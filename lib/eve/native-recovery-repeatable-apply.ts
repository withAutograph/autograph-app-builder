import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

const authorityKey = "autograph-app-builder.private-apply-authority.v1";
const workflowKey = "autograph-app-builder.workflow.v17";
const scopeSchema = z.object({
  appId: z.string().min(1),
  appSpecDigest: z.string().min(1),
  proposalDigest: z.string().min(1),
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
});
const receiptSchema = z.object({
  appliedByCallId: z.string(),
  appSpecDigest: z.string(),
  proposalDigest: z.string(),
  workspaceDigest: z.string(),
});
const workflowSchema = z.object({
  phase: z.enum(["planned", "applied", "apply_failed"]),
  appSpec: z.object({ digest: z.string().min(1) }),
  proposal: z.object({
    digest: z.string().min(1),
    target: z.object({ contract: z.object({ appId: z.string().min(1) }) }),
  }),
  workspace: z.object({ workspaceId: z.string().min(1), workspaceDigest: z.string().optional() }),
  applyReceipt: receiptSchema.optional(),
  applyFailure: receiptSchema.optional(),
});
const partSchema = z.looseObject({
  type: z.string(),
  toolCallId: z.string().optional(),
  toolName: z.string().optional(),
  providerExecuted: z.boolean().optional(),
  approvalId: z.string().optional(),
  approved: z.boolean().optional(),
});
const payloadSchema = z.object({
  binding: z.object({ ownerRunId: z.string(), logicalSessionId: z.string() }),
  candidates: z.array(
    z.object({
      origin: z.object({ slot: z.number() }),
      serializedContext: z.looseObject({ "eve.sessionId": z.string() }),
      sessionState: z.object({
        snapshot: z.object({
          session: z.object({
            sessionId: z.string(),
            history: z.array(
              z.object({ role: z.string(), content: z.union([z.string(), z.array(partSchema)]) }),
            ),
          }),
        }),
      }),
    }),
  ),
});
interface RepeatableApplyInput {
  descriptor: { logicalSessionId: string };
  binding: { ownerRunId: string; logicalSessionId: string };
  payload: unknown;
}

const hasUniqueApprovedBinding = (parts: z.infer<typeof partSchema>[], id: string): boolean => {
  if (parts.filter((part) => part.type === "tool-call" && part.toolCallId === id).length !== 1) {
    return false;
  }
  const requests = parts.filter(
    (part) => part.type === "tool-approval-request" && part.toolCallId === id,
  );
  if (requests.length !== 1) {
    return false;
  }
  const approvalId = requests[0].approvalId;
  if (approvalId === undefined || approvalId.length === 0) {
    return false;
  }
  const responses = parts.filter(
    (part) => part.type === "tool-approval-response" && part.approvalId === approvalId,
  );
  const unique =
    parts.filter((part) => part.type === "tool-approval-request" && part.approvalId === approvalId)
      .length === 1;
  return unique && responses.length === 1 && responses[0].approved === true;
};
const hasCallReceipt = (workflow: z.infer<typeof workflowSchema>, id: string): boolean => {
  let receipt: z.infer<typeof receiptSchema> | undefined;
  if (workflow.phase === "applied") {
    receipt = workflow.applyReceipt;
  }
  if (workflow.phase === "apply_failed") {
    receipt = workflow.applyFailure;
  }
  if (receipt === undefined || workflow.workspace.workspaceDigest === undefined) {
    return false;
  }
  const sameProposal =
    receipt.appSpecDigest === workflow.appSpec.digest &&
    receipt.proposalDigest === workflow.proposal.digest;
  return (
    sameProposal &&
    receipt.appliedByCallId === id &&
    receipt.workspaceDigest === workflow.workspace.workspaceDigest
  );
};

const matchingBinding = (
  binding: RepeatableApplyInput["binding"],
  input: RepeatableApplyInput,
): boolean =>
  isDeepStrictEqual(binding, input.binding) &&
  input.binding.logicalSessionId === input.descriptor.logicalSessionId;
const matchingLatestIdentity = (
  latest: z.infer<typeof payloadSchema>["candidates"][number],
  logical: string,
): boolean =>
  latest.serializedContext["eve.sessionId"] === logical &&
  latest.sessionState.snapshot.session.sessionId === logical;

/** Pure policy inside the already authenticated native boundary. This allows
 * the authored same-proposal private retry, never certifies nonexecution.
 * The SDK still validates the genuine approval and executes the current tool.
 */
export const authorizeRepeatablePrivateApplyCalls = (
  input: RepeatableApplyInput,
): readonly string[] => {
  const payload = payloadSchema.safeParse(input.payload).data;
  if (payload === undefined || !matchingBinding(payload.binding, input)) {
    return [];
  }
  const latest = payload.candidates.toSorted((a, b) => b.origin.slot - a.origin.slot)[0];
  if (latest === undefined || !matchingLatestIdentity(latest, input.binding.logicalSessionId)) {
    return [];
  }
  const workflow = workflowSchema.safeParse(latest.serializedContext[workflowKey]).data;
  const authority = z
    .object({
      grant: scopeSchema.nullable(),
      pending: z.array(
        z.object({
          callId: z.string(),
          scope: scopeSchema,
        }),
      ),
    })
    .safeParse(latest.serializedContext[authorityKey]).data;
  if (workflow === undefined || authority === undefined) {
    return [];
  }
  const expected = {
    appId: workflow.proposal.target.contract.appId,
    appSpecDigest: workflow.appSpec.digest,
    proposalDigest: workflow.proposal.digest,
    sessionId: input.binding.logicalSessionId,
    workspaceId: workflow.workspace.workspaceId,
  };
  const parts = latest.sessionState.snapshot.session.history.flatMap((message) =>
    Array.isArray(message.content) ? message.content : [],
  );
  const results = new Set(
    parts.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : [])),
  );
  const authorized: string[] = [];
  for (const call of parts) {
    if (call.type !== "tool-call" || call.toolName !== "apply_app_creation") {
      continue;
    }
    const id = call.toolCallId;
    if (id === undefined || id.length === 0) {
      continue;
    }
    if (call.providerExecuted === true || results.has(id)) {
      continue;
    }
    if (!hasUniqueApprovedBinding(parts, id)) {
      continue;
    }
    const pending = authority.pending.filter((entry) => entry.callId === id);
    const boundToCall =
      pending.length > 0
        ? pending.length === 1 && isDeepStrictEqual(pending[0].scope, expected)
        : isDeepStrictEqual(authority.grant, expected) && hasCallReceipt(workflow, id);
    if (boundToCall) {
      authorized.push(id);
    }
  }
  return authorized;
};
