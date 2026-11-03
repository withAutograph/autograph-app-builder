import { and, eq, sql } from "drizzle-orm";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { builderProvisioningJournals } from "../db/schema";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

/** Read one exact prepared app operation; ambiguity is a prerequisite, never a latest-row selector. */
export const readPublicReleasePreparedRuntime = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  owner: OperatorOwnerContext;
  appId: string;
  projectId: string;
  assertCurrentOwner: () => Promise<void>;
}) => {
  await input.assertCurrentOwner();
  const authority = input.owner.authority;
  const rows = await input.database
    .select({ record: builderProvisioningJournals.record })
    .from(builderProvisioningJournals)
    .where(
      and(
        eq(builderProvisioningJournals.issuer, authority.issuer),
        eq(builderProvisioningJournals.audience, authority.audience),
        eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
        eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
        sql`${builderProvisioningJournals.record}->>'kind' = 'app-runtime'`,
        sql`${builderProvisioningJournals.record}->'request'->>'appId' = ${input.appId}`,
        sql`${builderProvisioningJournals.record}->'request'->>'sessionId' = ${input.owner.sessionId}`,
        sql`${builderProvisioningJournals.record}->'request'->>'projectId' = ${input.projectId}`,
        sql`${builderProvisioningJournals.record}->>'status' = 'prepared'`,
        sql`${builderProvisioningJournals.record}->>'step' = 'bound'`,
      ),
    )
    .limit(2);
  await input.assertCurrentOwner();
  const row = rows.at(0);
  if (rows.length !== 1 || row === undefined) {
    throw new PublicReleasePrerequisiteError("prepared_runtime_required");
  }
  const record = hostedRuntimeJournalRecordSchema.parse(row.record);
  const operator = record.operator;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Every ready runtime custody/proof field must match this exact app project.
    operator === undefined ||
    operator.pendingEffectId !== undefined ||
    operator.pendingEffectAttempt !== undefined ||
    record.privateState === undefined ||
    record.environmentBound !== true ||
    record.proof?.manifestSha256 !== operator.plan.release.sha256 ||
    record.proof.releaseId !== operator.plan.release.id ||
    operator.plan.selection.projectId !== input.projectId ||
    operator.plan.neon.source !== "synthetic-only"
  ) {
    throw new PublicReleasePrerequisiteError("prepared_runtime_required");
  }
  return { record, operator };
};
