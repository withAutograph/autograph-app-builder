import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { builderProvisioningJournals } from "../db/schema";
import {
  publicReleaseRecordSchema,
  publicReleaseOperationRef,
  publicReleasePlanDigest,
  publicReleasePlanSchema,
  publicReleaseRequiresNativeGitEvent,
} from "./public-release-contract";
import type { PublicReleasePlan, PublicReleaseRecord } from "./public-release-contract";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";

export interface PublicReleaseBindingSnapshot {
  key: string;
  id: string;
  operationRef: string;
  sha256: string;
}
export { publicReleaseRequiresNativeGitEvent } from "./public-release-contract";
const semantic = (plan: PublicReleasePlan) => ({
  ...plan,
  purpose: plan.purpose ?? "application",
  project: { ...plan.project, priorActiveDeploymentId: undefined },
  source: { ...plan.source, expectedProductionSha: undefined },
  environment: plan.environment.map(({ key, sha256 }) => ({ key, sha256 })),
});
/** Existing frozen intent wins on resume; changed intent never passes another plan's uncertain effects. */
export const reconcilePublicReleasePlanHistory = (input: {
  candidate: PublicReleasePlan;
  records: readonly PublicReleaseRecord[];
  snapshots: readonly PublicReleaseBindingSnapshot[];
}): PublicReleasePlan => {
  const matching = input.records.filter(
    (record) =>
      isDeepStrictEqual(semantic(record.plan), semantic(input.candidate)) &&
      (record.plan.source.expectedProductionSha === input.candidate.source.expectedProductionSha ||
        record.effects["publish-release-source"] !== "idle"),
  );
  const plans = new Map(matching.map((record) => [record.planDigest, record.plan]));
  if (plans.size > 1) {
    throw new PublicReleasePrerequisiteError("public_release_reconciliation_required");
  }
  const retained = [...plans.values()].at(0);
  if (
    input.records.some(
      (record) =>
        record.planDigest !==
          (retained === undefined
            ? publicReleasePlanDigest(input.candidate)
            : publicReleasePlanDigest(retained)) &&
        Object.values(record.effects).some((phase) => phase === "pending"),
    )
  ) {
    throw new PublicReleasePrerequisiteError("public_release_reconciliation_required");
  }
  if (retained !== undefined) {
    return retained;
  }
  const environment = input.candidate.environment.map((entry) => {
    const snapshots = input.snapshots.filter((snapshot) => snapshot.key === entry.key);
    if (snapshots.length > 1) {
      throw new PublicReleasePrerequisiteError("public_release_reconciliation_required");
    }
    const snapshot = snapshots.at(0);
    if (snapshot === undefined) {
      return entry;
    }
    const owned = input.records.filter(
      (record) =>
        publicReleaseOperationRef(record.plan) === snapshot.operationRef &&
        record.bindings[entry.key]?.acceptedEnvId === snapshot.id &&
        record.plan.environment.some(
          (prior) => prior.key === entry.key && prior.sha256 === snapshot.sha256,
        ),
    );
    if (owned.length !== 1) {
      throw new PublicReleasePrerequisiteError("public_release_reconciliation_required");
    }
    return {
      ...entry,
      priorBinding: {
        id: snapshot.id,
        operationRef: snapshot.operationRef,
        valueSha256: snapshot.sha256,
      },
    };
  });
  const selected = publicReleasePlanSchema.parse({ ...input.candidate, environment });
  if (
    publicReleaseRequiresNativeGitEvent(selected) &&
    selected.source.sourceSha === selected.source.expectedProductionSha
  ) {
    throw new PublicReleasePrerequisiteError("public_release_git_revision_required");
  }
  return selected;
};
export const readPublicReleasePlanHistory = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  candidate: PublicReleasePlan;
  assertCurrentOwner: () => Promise<void>;
}) => {
  const { authority } = input.candidate;
  const records: PublicReleaseRecord[] = [];
  let cursor: string | undefined;
  /* oxlint-disable eslint/no-await-in-loop -- Each owner-checked page depends on the preceding immutable request-ID cursor. */
  while (true) {
    await input.assertCurrentOwner();
    const rows = await input.database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          eq(builderProvisioningJournals.issuer, authority.issuer),
          eq(builderProvisioningJournals.audience, authority.audience),
          eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
          eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
          sql`${builderProvisioningJournals.record}->>'kind' = 'public-app-release-v1'`,
          sql`${builderProvisioningJournals.record}->'plan'->'selection'->>'appId' = ${input.candidate.selection.appId}`,
          sql`${builderProvisioningJournals.record}->'plan'->'project'->>'projectId' = ${input.candidate.project.projectId}`,
          cursor === undefined ? undefined : gt(builderProvisioningJournals.requestId, cursor),
        ),
      )
      .orderBy(asc(builderProvisioningJournals.requestId))
      .limit(128);
    await input.assertCurrentOwner();
    for (const row of rows) {
      const record = publicReleaseRecordSchema.parse(row.record);
      if (
        row.requestId !== publicReleaseOperationRef(record.plan) ||
        row.requestDigest !== record.planDigest ||
        record.planDigest !== publicReleasePlanDigest(record.plan)
      ) {
        throw new Error("public_release_history_unavailable");
      }
      records.push(record);
    }
    if (rows.length < 128) {
      return records;
    }
    cursor = rows.at(-1)?.requestId;
  }
};
