import { isDeepStrictEqual } from "node:util";
import {
  HostedOperatorError,
  hostedOperatorInstallationCustomerIds,
  matchesHostedOperatorIdentityLinkScope,
  operatorPlanDigest,
  projectPendingRealmIdentityLink,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { retainedHostedOperatorOperations } from "./hosted-operator-membership-inspection-provenance";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { realmLinkClaimsSchema } from "./hosted-operator-auth-identity";
import type { z } from "zod";

type RetainedOperation = ReturnType<typeof retainedHostedOperatorOperations>[number];
export type ExportOwnerOrganizationWitness = RetainedOperation & {
  membership: Extract<
    NonNullable<HostedOperatorPlan["authMembership"]>,
    { kind: "create-owned-organization" }
  >;
  link: NonNullable<RetainedOperation["operator"]["identityLink"]>;
};
const witnessIdentity = (entry: ExportOwnerOrganizationWitness) =>
  JSON.stringify([
    entry.approvedByCallId,
    entry.operator.operationRef,
    entry.operator.approvalId,
    entry.operator.planDigest,
    projectPendingRealmIdentityLink(entry.link),
  ]);

/** A prior owner capture identifies an organization; the current installation authorizes export. */
const ownerWitnesses = (
  record: HostedRuntimeJournalRecord,
  context: HostedOperatorContext,
  prepared: HostedOperatorPlan,
): ExportOwnerOrganizationWitness[] => {
  const installed = new Set(hostedOperatorInstallationCustomerIds(prepared));
  const candidates: ExportOwnerOrganizationWitness[] = [];
  for (const entry of retainedHostedOperatorOperations(record)) {
    const { operator } = entry;
    const { plan, identityLink: link } = operator;
    const membership = plan.authMembership;
    if (membership?.kind !== "create-owned-organization" || link === undefined) {
      continue;
    }
    const sameOwnedInstallation = [
      plan.action === "prepare",
      plan.stage === undefined || plan.stage === "app",
      plan.normalActorProgram === undefined,
      plan.selection.appId === context.target.appId,
      plan.selection.sessionId === context.target.sessionId,
      plan.selection.projectId === context.target.projectId,
      plan.selection.environment === context.target.environment,
      isDeepStrictEqual(plan.authDatabase, prepared.authDatabase),
      isDeepStrictEqual(plan.appDatabase, prepared.appDatabase),
      plan.neon.projectId === prepared.neon.projectId,
      plan.neon.branchId === prepared.neon.branchId,
      plan.neon.endpoint === prepared.neon.endpoint,
      installed.has(membership.organizationId),
    ].every(Boolean);
    const sameCapture = [
      operator.approvalId !== undefined,
      entry.approvedByCallId !== "operator:unapproved-plan",
      operator.planDigest === operatorPlanDigest(plan),
      matchesHostedOperatorIdentityLinkScope(operator),
      link.browserSession === undefined,
      link.consumedAt !== undefined,
      link.ownerSessionId === context.target.sessionId,
      link.authResourceId === prepared.authDatabase.resourceId,
      link.bootstrapPlanDigest === membership.bootstrapPlanDigest,
      link.nonceSha256 === membership.identityNonceSha256,
      link.proofRef === membership.identityProof.reference,
      link.proofSha256 === membership.identityProof.sha256,
      link.issuer === membership.identityVerification.issuer,
      link.audience === membership.identityVerification.audience,
      link.organizationId === null || link.organizationId === membership.organizationId,
    ].every(Boolean);
    if (sameOwnedInstallation && sameCapture) {
      candidates.push({ ...entry, membership, link });
    }
  }
  return candidates;
};

export const resolveExportOwnerOrganization = async (input: {
  context: HostedOperatorContext;
  prepared: HostedOperatorPlan;
  assertCurrent: () => Promise<void>;
  readCurrentRecord: () => Promise<HostedRuntimeJournalRecord>;
  readApproval: (witness: ExportOwnerOrganizationWitness) => Promise<boolean>;
  verifyProof: (
    witness: ExportOwnerOrganizationWitness,
  ) => Promise<z.infer<typeof realmLinkClaimsSchema>>;
}): Promise<string> => {
  await input.assertCurrent();
  const candidates = ownerWitnesses(await input.readCurrentRecord(), input.context, input.prepared);
  const seen = new Set<string>();
  const organizations = new Set<string>();
  for (const candidate of candidates) {
    const identity = witnessIdentity(candidate);
    // Selection is by organization; one fully verified witness establishes it.
    // Distinct organizations still require verification to detect ambiguity.
    if (organizations.has(candidate.membership.organizationId) || seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Canonical owner and original settlement checks share the protected journal.
    await input.assertCurrent();
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/server-sequential-independent-await -- Read each original approval under the preceding fresh owner guard.
    const approved = await input.readApproval(candidate);
    if (!approved) {
      continue;
    }
    let claims: z.infer<typeof realmLinkClaimsSchema>;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/server-sequential-independent-await -- Verify only after the exact original owner approval has been established.
      claims = await input.verifyProof(candidate);
    } catch {
      // An unavailable historical witness cannot authorize a tenant or hide another valid witness.
      continue;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/server-sequential-independent-await -- Historical verification never catches fresh owner failures.
    await input.assertCurrent();
    // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/server-sequential-independent-await -- Confirm the exact typed witness still exists after asynchronous verification.
    const fresh = ownerWitnesses(await input.readCurrentRecord(), input.context, input.prepared);
    if (!fresh.some((entry) => witnessIdentity(entry) === identity)) {
      throw new HostedOperatorError("reconciliation_required");
    }
    const sameActor = [
      claims.sub === candidate.membership.actorId,
      claims.ownerSessionId === input.context.target.sessionId,
      claims.authResourceId === input.prepared.authDatabase.resourceId,
      candidate.membership.identityCapture === undefined ||
        claims.sessionId === candidate.membership.identityCapture.realmSessionId,
    ].every(Boolean);
    if (sameActor) {
      organizations.add(candidate.membership.organizationId);
    }
  }
  await input.assertCurrent();
  if (organizations.size !== 1) {
    throw new HostedOperatorError("export_customer_selection_required");
  }
  const [organizationId] = organizations;
  if (organizationId === undefined) {
    throw new HostedOperatorError("export_customer_selection_required");
  }
  return organizationId;
};
