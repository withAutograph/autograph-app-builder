import { isDeepStrictEqual } from "node:util";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { readPrivatePublicReleaseApproval } from "../eve/private-public-release-approval";
import { createNativeTargetApprovalHistoryTransport } from "./native-target-onboarding-deployment";
import { publicReleaseOperationRef, publicReleasePlanDigest } from "./public-release-contract";
import type { PublicReleasePlan } from "./public-release-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type { PublicReleaseRequestAuthority } from "./public-release-dispatcher";
import { createPostgresOperatorApprovalCheckpoint } from "./postgres-operator-approval-checkpoint";

const unavailable = () => new Error("public_release_approval_unavailable");

/** Durable read cursor only. Neither this row nor a prior approved call grants consent. */
export const createPublicReleaseApprovalCheckpoint = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  plan: PublicReleasePlan;
  owner: OperatorOwnerContext;
  assertCurrentOwner: () => Promise<void>;
}) => {
  if (
    !isDeepStrictEqual(input.plan.authority, input.owner.authority) ||
    input.plan.selection.sessionId !== input.owner.sessionId
  ) {
    throw unavailable();
  }
  const planRef = publicReleaseOperationRef(input.plan);
  return createPostgresOperatorApprovalCheckpoint({
    ...input,
    kind: "public-release-approval-observation",
    key: `public-release-approval-v1:${planRef}`,
    request: {
      action: "public-release",
      planRef,
      planDigest: publicReleasePlanDigest(input.plan),
      idempotencyKey: input.plan.selection.appId,
    },
    unavailable,
  });
};

/** Reuses the authenticated native stream, canonical owner checks and durable partial-tail cursor. */
export const createPublicReleaseApprovalAuthority =
  (input: {
    database: ReturnType<typeof openHostedPostgresDatabase>;
    builderOrigin: string;
    request: Request;
    owner: OperatorOwnerContext;
    authority: PublicReleaseRequestAuthority;
    assertCurrentOwner: () => Promise<void>;
    fetch?: typeof fetch;
  }) =>
  async (plan: PublicReleasePlan, callId: string) => {
    await input.assertCurrentOwner();
    const checkpoint = createPublicReleaseApprovalCheckpoint({
      database: input.database,
      plan,
      owner: input.owner,
      assertCurrentOwner: input.assertCurrentOwner,
    });
    const state = await checkpoint.read();
    const transportInput: Parameters<typeof createNativeTargetApprovalHistoryTransport>[0] = {
      builderOrigin: input.builderOrigin,
      owner: {
        authority: input.owner.authority,
        publicSessionId: input.owner.sessionId,
        adapterSessionId: input.owner.adapterSessionId,
        adapterGeneration: input.owner.adapterGeneration,
        historyOwner: input.owner,
      },
      appId: plan.selection.appId,
      workload: {
        authorization: input.request.headers.get("authorization"),
        signal: input.request.signal,
      },
      assertCanonicalAppOwner: input.authority.assertCanonicalAppOwner,
    };
    if (input.fetch !== undefined) {
      transportInput.fetch = input.fetch;
    }
    const transport = createNativeTargetApprovalHistoryTransport(transportInput);
    const observe = transport.observePrivateHistory;
    if (!observe) {
      throw unavailable();
    }
    const observationState: Pick<
      NonNullable<Parameters<typeof readPrivatePublicReleaseApproval>[0]["observation"]>,
      "state"
    > = {};
    if (state !== undefined) {
      observationState.state = state;
    }
    const approval = await readPrivatePublicReleaseApproval({
      plan,
      callId,
      owner: input.owner,
      observation: { ...observationState, save: checkpoint.save },
      readHistory: async (startIndex, onEvent) =>
        await observe({
          principal: input.owner.principal,
          adapterSessionId: input.owner.adapterSessionId,
          sessionId: input.owner.sessionId,
          startIndex,
          onEvent,
        }),
      assertOwner: input.assertCurrentOwner,
    });
    await input.assertCurrentOwner();
    if (approval === null) {
      throw unavailable();
    }
    return approval;
  };
