import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import {
  directProductionGrantSchema,
  directProductionSubjectSchema,
} from "../agent/direct-production-authorization";
import type { DirectProductionGrant } from "../agent/direct-production-authorization";
import { isExistingRepositoryDestination } from "../provisioning/builder-session-destination-contract";
import type { BuilderSessionDestination } from "../provisioning/builder-session-destination-contract";
import {
  createPrivateOperatorApprovalCapture,
  readPrivateOperatorApproval,
} from "./private-operator-approval-observation";
import type {
  PrivateOperatorApprovalCapture,
  PrivateOperatorApprovalObservationPort,
} from "./private-operator-approval-observation";
import type { PrivateHistoryObservation } from "./same-origin-http";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import {
  matchesDirectProductionSetupReference,
  repositoryProductionApprovalInputSchema,
  repositoryProductionApprovalReference,
  repositoryProductionPrepareInputSchema,
} from "../provisioning/repository-production-approval";
import type { RepositoryProductionApprovalInput } from "../provisioning/repository-production-approval";

export const createPrivateRepositoryProductionApprovalCapture = (input: {
  plan: RepositoryProductionApprovalInput;
  callId: string;
  directProduction?: DirectProductionGrant;
  state?: PrivateOperatorApprovalCapture;
}) => {
  const expected = repositoryProductionApprovalInputSchema.parse(input.plan);
  const expectedReference = repositoryProductionApprovalReference(expected);
  const captureInput: Parameters<typeof createPrivateOperatorApprovalCapture>[0] = {
    request: {
      action: "repository-production",
      planRef: expected.operationRef,
      planDigest: expected.planDigest,
      idempotencyKey: expected.scope.appId,
    },
    ownerUserId: expected.scope.authority.ownerUserId,
    callId: input.callId,
  };
  if (input.state !== undefined) {
    captureInput.state = input.state;
  }
  const capture = createPrivateOperatorApprovalCapture(captureInput);
  return {
    observe(event: MessageStreamEvent) {
      if (event.type === "input.requested") {
        // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Select only matching Production approval requests in event order.
        for (const request of event.data.requests) {
          if (request.kind !== "tool-approval") {
            continue;
          }
          const { requestId, action } = request;
          const { callId, input: requestedInput, toolName } = action;
          if (input.directProduction !== undefined) {
            const approval = z
              .object({ directProduction: directProductionSubjectSchema })
              .safeParse(requestedInput);
            if (
              toolName === input.directProduction.toolName &&
              approval.success &&
              isDeepStrictEqual(approval.data.directProduction, input.directProduction.subject)
            ) {
              capture.acceptRequest(requestId, callId);
            }
            continue;
          }
          if (toolName !== "prepare-app-production") {
            continue;
          }
          const parsed = repositoryProductionPrepareInputSchema.safeParse(requestedInput);
          if (!parsed.success) {
            continue;
          }
          if ("version" in parsed.data) {
            if (isDeepStrictEqual(parsed.data, expectedReference)) {
              capture.acceptRequest(requestId, callId);
            }
            continue;
          }
          if (
            parsed.data.planDigest === expected.planDigest &&
            parsed.data.operationRef === expected.operationRef &&
            parsed.data.intent.sessionId === expected.intent.sessionId &&
            isDeepStrictEqual(parsed.data.scope, expected.scope)
          ) {
            capture.acceptRequest(requestId, callId);
          }
        }
      } else if (event.type === "approval.settled") {
        capture.settle(event);
      }
    },
    read: () => capture.read(),
    snapshot: () => capture.snapshot(),
    proveComplete: () => {
      capture.proveComplete();
    },
  };
};

/** The protected operator derives direct authority from the current owner record and checked source. */
export const assertDirectRepositoryProductionApproval = (input: {
  plan: RepositoryProductionApprovalInput;
  grant: DirectProductionGrant;
  decision: ApprovedBuildDecision | undefined;
  destination: BuilderSessionDestination | undefined;
  logicalSessionId: string;
  publishedDescription: boolean;
  owner: OperatorOwnerContext;
}) => {
  const { plan, grant, decision, destination, owner } = input;
  const { subject } = directProductionGrantSchema.parse(grant);
  const spec = decision?.currentSpec;
  const source = decision?.existingRepositorySource;
  const existingDestination =
    destination !== undefined && isExistingRepositoryDestination(destination)
      ? destination
      : undefined;
  const repository = existingDestination?.repository ?? source?.repository;
  const installationId = existingDestination?.installationId ?? source?.scope.installationId;
  if (spec === undefined || repository === undefined) {
    throw new Error("repository_production_approval_required");
  }
  const matches = [
    input.publishedDescription,
    isDeepStrictEqual(decision?.directProduction, grant),
    decision?.decision !== "blocked",
    decision?.workflowPhase === "reviewed",
    isDeepStrictEqual(subject.authority, owner.authority),
    subject.sessionId === input.logicalSessionId,
    spec.appId === subject.appId,
    spec.sessionId === input.logicalSessionId,
    spec.appSpecDigest === subject.appSpecDigest,
    spec.proposalDigest === subject.proposalDigest,
    spec.workspaceId === subject.buildWorkspaceId,
    spec.access?.mode !== "self-signup",
    repository.repositoryId === subject.repositoryId,
    `${repository.owner}/${repository.name}` === subject.repositoryFullName,
    repository.defaultBranch === subject.baseBranch,
    installationId === subject.installationId,
    matchesDirectProductionSetupReference(subject, repositoryProductionApprovalReference(plan)),
  ].every(Boolean);
  if (!matches) {
    throw new Error("repository_production_approval_required");
  }
};

export const readRepositoryProductionApproval = async (input: {
  plan: RepositoryProductionApprovalInput;
  callId: string;
  owner: OperatorOwnerContext;
  directProduction?: { grant: DirectProductionGrant; logicalSessionId: string };
  observation?: PrivateOperatorApprovalObservationPort;
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  assertOwner: () => Promise<void>;
}) => {
  const { directProduction } = input;
  if (
    !isDeepStrictEqual(input.plan.scope.authority, input.owner.authority) ||
    input.plan.intent.sessionId !== input.owner.sessionId
  ) {
    throw new Error("App setup approval owner changed.");
  }
  if (directProduction !== undefined) {
    const { grant, logicalSessionId } = directProduction;
    const matches = [
      grant.callId === input.callId,
      grant.subject.sessionId === logicalSessionId,
      isDeepStrictEqual(grant.subject.authority, input.owner.authority),
      matchesDirectProductionSetupReference(
        grant.subject,
        repositoryProductionApprovalReference(input.plan),
      ),
    ].every(Boolean);
    if (!matches) {
      throw new Error("repository_production_approval_required");
    }
  }
  return await readPrivateOperatorApproval({
    ...input,
    capture: (state) => {
      const captureInput: Parameters<typeof createPrivateRepositoryProductionApprovalCapture>[0] = {
        plan: input.plan,
        callId: input.callId,
      };
      if (state !== undefined) {
        captureInput.state = state;
      }
      if (input.directProduction !== undefined) {
        captureInput.directProduction = input.directProduction.grant;
      }
      return createPrivateRepositoryProductionApprovalCapture(captureInput);
    },
  });
};
