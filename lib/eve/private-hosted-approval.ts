import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

import { hostedPrincipalSchema } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import type { HostedEveStore, HostedSessionRecord } from "./hosted-store";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import type { OperatorSelection } from "../provisioning/hosted-operator-contract";

const hostedRuntimeToolName = z.enum([
  "prepare-app-hosted-runtime",
  "cleanup-app-hosted-runtime",
]);
const planMismatchMessage = "Hosted runtime approval must retain its exact, internally consistent plan.";
const hostedRuntimeToolInputSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  branch: z.string().min(1),
  environment: z.literal("preview"),
  operationRef: z.uuid(),
  plan: hostedOperatorPlanSchema,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  projectId: z.string().min(1),
});

export const privateHostedApprovalReceiptSchema = z
  .strictObject({
    callId: z.string().min(1),
    format: z.literal("autograph-hosted-approval-v1"),
    outcome: z.enum(["approved", "cancelled"]),
    requestId: z.string().min(1),
    responderPrincipalId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    toolInput: hostedRuntimeToolInputSchema,
    toolName: hostedRuntimeToolName,
    turnId: z.string().min(1),
  })
  .superRefine((receipt, context) => {
    const expectedAction =
      receipt.toolName === "prepare-app-hosted-runtime" ? "prepare" : "cleanup";
    const input = receipt.toolInput;
    const selectionMatches = sameOperatorSelection(input.plan.selection, {
      ...input.plan.selection,
      appId: input.appId,
      branch: input.branch,
      environment: input.environment,
      projectId: input.projectId,
    });
    const actionMatches = input.plan.action === expectedAction;
    const digestMatches = input.planDigest === operatorPlanDigest(input.plan);
    if (!actionMatches || !digestMatches || !selectionMatches) {
      context.addIssue({
        code: "custom",
        message: planMismatchMessage,
        path: ["toolInput"],
      });
    }
  });

export type PrivateHostedApprovalReceipt = z.infer<typeof privateHostedApprovalReceiptSchema>;

const samePrincipal = (session: HostedSessionRecord, principal: HostedPrincipal) =>
  session.principal.issuer === principal.issuer &&
  session.principal.audience === principal.audience &&
  session.principal.workspaceId === principal.workspaceId &&
  session.principal.ownerUserId === principal.ownerUserId;

const matchesApprovalScope = (
  candidate: PrivateHostedApprovalReceipt,
  input: {
    action: "prepare" | "cleanup";
    callId: string;
    planDigest: string;
    selection: OperatorSelection;
    requestId?: string;
  },
) => {
  const expectedTool = input.action === "prepare"
    ? hostedRuntimeToolName.enum["prepare-app-hosted-runtime"]
    : hostedRuntimeToolName.enum["cleanup-app-hosted-runtime"];
  const matches = [
    candidate.callId === input.callId,
    candidate.toolName === expectedTool,
    candidate.toolInput.planDigest === input.planDigest,
    sameOperatorSelection(candidate.toolInput.plan.selection, input.selection),
    input.requestId === undefined || candidate.requestId === input.requestId,
  ];
  return matches.every(Boolean);
};

const sameReceipt = (left: PrivateHostedApprovalReceipt, right: PrivateHostedApprovalReceipt) =>
  [
    left.requestId === right.requestId,
    left.callId === right.callId,
    left.toolName === right.toolName,
    left.outcome === right.outcome,
    left.responderPrincipalId === right.responderPrincipalId,
    left.sequence === right.sequence,
    left.turnId === right.turnId,
    left.toolInput.appId === right.toolInput.appId,
    left.toolInput.branch === right.toolInput.branch,
    left.toolInput.environment === right.toolInput.environment,
    left.toolInput.operationRef === right.toolInput.operationRef,
    left.toolInput.planDigest === right.toolInput.planDigest,
    left.toolInput.projectId === right.toolInput.projectId,
  ].every(Boolean);

const assertReceiptsMatchSession = (
  sessionId: string,
  receipts: readonly PrivateHostedApprovalReceipt[],
) => {
  const parsed = receipts.map((receipt) => privateHostedApprovalReceiptSchema.parse(receipt));
  if (parsed.some((receipt) => receipt.toolInput.plan.selection.sessionId !== sessionId)) {
    throw new Error("Hosted approval receipt belongs to another session.");
  }
  return parsed;
};

/** Captures only protected hosted-runtime approvals from the authenticated Eve stream. */
export const createPrivateHostedApprovalCapture = (sessionId: string) => {
  const pending = new Map<string, {
    callId: string;
    toolInput: z.infer<typeof hostedRuntimeToolInputSchema>;
    toolName: z.infer<typeof hostedRuntimeToolName>;
  }>();
  const receipts = new Map<string, PrivateHostedApprovalReceipt>();

  return {
    observe: (event: MessageStreamEvent) => {
      if (event.type === "input.requested") {
        for (const request of event.data.requests) {
          if (request.kind === "tool-approval") {
            const toolName = hostedRuntimeToolName.safeParse(request.action.toolName);
            if (toolName.success) {
              const toolInput = hostedRuntimeToolInputSchema.parse(request.action.input);
              if (toolInput.plan.selection.sessionId !== sessionId) {
                throw new Error("Eve returned a protected approval for another hosted session.");
              }
              pending.set(request.requestId, {
                callId: request.action.callId,
                toolInput,
                toolName: toolName.data,
              });
            }
          }
        }
        return;
      }
      if (event.type !== "approval.settled") {
        return;
      }
      const request = pending.get(event.data.requestId);
      if (request === undefined) {
        return;
      }
      pending.delete(event.data.requestId);
      const receipt = privateHostedApprovalReceiptSchema.parse({
        ...request,
        format: "autograph-hosted-approval-v1",
        outcome: event.data.outcome,
        requestId: event.data.requestId,
        responderPrincipalId: event.data.responderPrincipalId,
        sequence: event.data.sequence,
        turnId: event.data.turnId,
      });
      const existing = receipts.get(receipt.requestId);
      if (existing !== undefined && !sameReceipt(existing, receipt)) {
        throw new Error("Eve returned conflicting protected approval settlements.");
      }
      receipts.set(receipt.requestId, receipt);
    },
    values() {
      return [...receipts.values()].toSorted((left, right) => left.sequence - right.sequence);
    },
  };
};

/** Captures terminal approvals and persists each receipt as soon as Eve emits it. */
export const createPrivateHostedApprovalRecorder = (input: {
  principal: HostedPrincipal;
  sessionId: string;
  store: Pick<HostedEveStore, "recordPrivateApprovalReceipts">;
}) => {
  const capture = createPrivateHostedApprovalCapture(input.sessionId);
  const persisted = new Set<string>();
  return {
    async observe(event: MessageStreamEvent) {
      capture.observe(event);
      const receipts = capture.values().filter((receipt) => !persisted.has(receipt.requestId));
      if (receipts.length === 0) {
        return;
      }
      if (input.store.recordPrivateApprovalReceipts === undefined) {
        throw new Error("Private Eve approval persistence is unavailable.");
      }
      await input.store.recordPrivateApprovalReceipts({
        principal: input.principal,
        receipts,
        sessionId: input.sessionId,
      });
      for (const receipt of receipts) {
        persisted.add(receipt.requestId);
      }
    },
    values: capture.values,
  };
};

/** Merge replayed event receipts without allowing a request to change its terminal outcome. */
export const mergePrivateHostedApprovalReceipts = (
  sessionId: string,
  existingInput: readonly PrivateHostedApprovalReceipt[] | undefined,
  observedInput: readonly PrivateHostedApprovalReceipt[],
): PrivateHostedApprovalReceipt[] => {
  const merged = new Map<string, PrivateHostedApprovalReceipt>();
  for (const receipt of assertReceiptsMatchSession(sessionId, [...(existingInput ?? []), ...observedInput])) {
    const previous = merged.get(receipt.requestId);
    if (previous !== undefined && !sameReceipt(previous, receipt)) {
      throw new Error("Protected hosted approval receipt conflicts with its saved terminal outcome.");
    }
    merged.set(receipt.requestId, receipt);
  }
  return [...merged.values()].toSorted((left, right) => left.sequence - right.sequence);
};

/** Owner-scoped read helper for the protected operator's authoritative approval callback. */
export const readPrivateHostedApproval = async (input: {
  store: Pick<HostedEveStore, "getSession">;
  principal: HostedPrincipal;
  sessionId: string;
  callId: string;
  action: "prepare" | "cleanup";
  planDigest: string;
  selection: OperatorSelection;
  requestId?: string;
}): Promise<PrivateHostedApprovalReceipt | null> => {
  const principal = hostedPrincipalSchema.parse(input.principal);
  if (input.selection.sessionId !== input.sessionId) {
    return null;
  }
  const session = await input.store.getSession(principal, input.sessionId);
  if (
    session === null ||
    session.sessionId !== input.sessionId ||
    !samePrincipal(session, principal)
  ) {
    return null;
  }
  const receipts = session.version === 2 ? session.privateApprovalReceipts : undefined;
  const matches = receipts?.filter((candidate) => matchesApprovalScope(candidate, input));
  if (matches === undefined || matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    throw new Error("Hosted approval lookup matched more than one Eve request.");
  }
  return privateHostedApprovalReceiptSchema.parse(matches[0]);
};
