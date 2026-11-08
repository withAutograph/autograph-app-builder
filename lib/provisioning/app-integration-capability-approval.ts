import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { builderProvisioningJournals } from "../db/schema";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { privateOperatorApprovalObservationSchema } from "../eve/private-operator-approval-observation";
import type { PrivateOperatorApprovalObservation } from "../eve/private-operator-approval-observation";
import { readPrivateAppIntegrationCapabilityApproval } from "../eve/private-app-integration-capability-approval";
import { createNativeTargetApprovalHistoryTransport } from "./native-target-onboarding-deployment";
import {
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanDigest,
} from "./app-integration-capability-contract";
import type { AppIntegrationCapabilityPlan } from "./app-integration-capability-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type { PublicReleaseRequestAuthority } from "./public-release-dispatcher";

const recordSchema = z.strictObject({
  kind: z.literal("app-integration-capability-approval-observation"),
  version: z.literal(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  observation: privateOperatorApprovalObservationSchema,
});
const unavailable = () => new Error("app_integration_capability_approval_unavailable");

/** Durable read cursor only. Neither this row nor a prior approved call grants consent. */
export const createAppIntegrationCapabilityApprovalCheckpoint = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  plan: AppIntegrationCapabilityPlan;
  owner: OperatorOwnerContext;
  assertCurrentOwner: () => Promise<void>;
}) => {
  if (
    !isDeepStrictEqual(input.plan.authority, input.owner.authority) ||
    input.plan.selection.sessionId !== input.owner.sessionId
  ) {
    throw unavailable();
  }
  const digest = appIntegrationCapabilityPlanDigest(input.plan);
  const hex = createHash("sha256")
    .update(
      `app-integration-capability-approval-v1:${appIntegrationCapabilityOperationRef(input.plan)}`,
    )
    .digest("hex");
  const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const authority = input.plan.authority;
  const predicate = and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, requestId),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'app-integration-capability-approval-observation'`,
  );
  let expected: { revision: number; observation: PrivateOperatorApprovalObservation } | undefined;
  const read = async () => {
    await input.assertCurrentOwner();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate)
      .limit(1);
    const row = rows.at(0);
    await input.assertCurrentOwner();
    if (row === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing durable checkpoint explicitly starts history at zero.
      return undefined;
    }
    const record = recordSchema.parse(row.record);
    if (row.requestDigest !== digest || record.planDigest !== digest) {
      throw unavailable();
    }
    expected = { revision: row.revision, observation: record.observation };
    return structuredClone(record.observation);
  };
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Bound intent, adapter cursor, monotone settlements and CAS are one atomic checkpoint guard.
  const save = async (state: PrivateOperatorApprovalObservation) => {
    const parsed = privateOperatorApprovalObservationSchema.parse(state);
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- All immutable cursor ownership fields must match before persistence.
      parsed.adapterSessionId !== input.owner.adapterSessionId ||
      parsed.adapterGeneration !== input.owner.adapterGeneration ||
      parsed.capture.ownerUserId !== authority.ownerUserId ||
      parsed.capture.request.action !== "app-integration-capability" ||
      parsed.capture.request.planRef !== appIntegrationCapabilityOperationRef(input.plan) ||
      parsed.capture.request.planDigest !== digest ||
      parsed.capture.request.idempotencyKey !== input.plan.selection.appId
    ) {
      throw unavailable();
    }
    await input.assertCurrentOwner();
    const previous = expected;
    if (previous && isDeepStrictEqual(previous.observation, parsed)) {
      return;
    }
    if (previous) {
      const prior = previous.observation;
      if (
        prior.adapterSessionId === parsed.adapterSessionId &&
        prior.adapterGeneration === parsed.adapterGeneration &&
        parsed.nextNativeIndex < prior.nextNativeIndex
      ) {
        throw unavailable();
      }
      // No cursor update can erase an authenticated cancellation or a completed settlement.
      for (const entry of prior.capture.entries) {
        if (entry.cancelled || entry.completedApproved || entry.completedCancelled) {
          const current = parsed.capture.entries.find(
            (candidate) =>
              candidate.requestId === entry.requestId && candidate.callId === entry.callId,
          );
          if (
            // oxlint-disable-next-line sonarjs/expression-complexity -- No completed grant or authenticated cancellation can regress.
            !current ||
            (entry.cancelled && !current.cancelled) ||
            (entry.completedApproved && !current.completedApproved) ||
            (entry.completedCancelled && !current.completedCancelled)
          ) {
            throw unavailable();
          }
        }
      }
    }
    const record = recordSchema.parse({
      kind: "app-integration-capability-approval-observation",
      version: 1,
      planDigest: digest,
      observation: parsed,
    });
    const now = new Date();
    const rows = previous
      ? await input.database
          .update(builderProvisioningJournals)
          .set({ record, revision: previous.revision + 1, updatedAt: now })
          .where(and(predicate, eq(builderProvisioningJournals.revision, previous.revision)))
          .returning({ revision: builderProvisioningJournals.revision })
      : await input.database
          .insert(builderProvisioningJournals)
          .values({
            ...authority,
            requestId,
            requestDigest: digest,
            record,
            revision: 1,
            state: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning({ revision: builderProvisioningJournals.revision });
    if (rows.length !== 1) {
      throw unavailable();
    }
    expected = { revision: rows[0].revision, observation: structuredClone(parsed) };
    await input.assertCurrentOwner();
  };
  return { read, save };
};

/** Reuses the authenticated native stream, canonical owner checks and durable partial-tail cursor. */
export const createAppIntegrationCapabilityApprovalAuthority =
  (input: {
    database: ReturnType<typeof openHostedPostgresDatabase>;
    builderOrigin: string;
    request: Request;
    owner: OperatorOwnerContext;
    authority: PublicReleaseRequestAuthority;
    assertCurrentOwner: () => Promise<void>;
    fetch?: typeof fetch;
  }) =>
  async (plan: AppIntegrationCapabilityPlan, callId: string) => {
    await input.assertCurrentOwner();
    const checkpoint = createAppIntegrationCapabilityApprovalCheckpoint({
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
    const { owner } = input;
    const observationState: Pick<
      NonNullable<Parameters<typeof readPrivateAppIntegrationCapabilityApproval>[0]["observation"]>,
      "state"
    > = {};
    if (state !== undefined) {
      observationState.state = state;
    }
    const approval = await readPrivateAppIntegrationCapabilityApproval({
      plan,
      callId,
      owner,
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
