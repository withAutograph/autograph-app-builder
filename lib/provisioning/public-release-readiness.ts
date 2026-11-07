import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import type { HostedRuntimeTarget } from "./hosted-runtime-journal";
import { operatorPlanDigest } from "./hosted-operator-contract";
import type { OperatorOwnerContext, HostedOperatorPlan } from "./hosted-operator-contract";
import { createPostgresHostedRuntimeJournalStore } from "./postgres-hosted-runtime-journal";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";

/** Exact current branch/project/installation/session identity, never latest-row or history election. */
// oxlint-disable-next-line eslint/complexity -- Approved bootstrap, resources-only application and frozen legacy bound custody have separate complete guards.
export const readPublicReleasePreparedRuntime = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  owner: OperatorOwnerContext;
  target: HostedRuntimeTarget;
  release?: HostedOperatorPlan["release"];
  assertCurrentOwner: () => Promise<void>;
}) => {
  await input.assertCurrentOwner();
  const row = await createPostgresHostedRuntimeJournalStore(input.database).read({
    authority: input.owner.authority,
    target: input.target,
  });
  await input.assertCurrentOwner();
  if (row === undefined) {
    throw new PublicReleasePrerequisiteError("prepared_runtime_required");
  }
  const record = hostedRuntimeJournalRecordSchema.parse(row.record);
  const { operator } = record;
  const auth = retainedOperatorAuthFromJournal(record);
  const bootstrap = operator?.plan.stage === "auth-bootstrap" && auth !== undefined;
  const resourceOnly = z
    .object({ runtimePreparation: z.literal("single-project-resources-v1") })
    .safeParse(operator?.plan).success;
  const resourceReady =
    resourceOnly &&
    record.status === "prepared" &&
    z.object({ step: z.literal("resource-ready") }).safeParse(record).success;
  const legacyBound =
    record.status === "prepared" && record.step === "bound" && record.environmentBound === true;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- A complete exact-source resource receipt cannot be substituted with legacy environment/deployment readiness or an unapproved proposal.
    operator === undefined ||
    operator.approvalId === undefined ||
    record.approvedByCallId === "operator:unapproved-plan" ||
    !isDeepStrictEqual(record.request, input.target) ||
    input.target.sessionId !== input.owner.sessionId ||
    operator.plan.action !== "prepare" ||
    operatorPlanDigest(operator.plan) !== operator.planDigest ||
    operator.pendingEffectId !== undefined ||
    operator.pendingEffectAttempt !== undefined ||
    record.privateState === undefined ||
    (!bootstrap &&
      ((!resourceReady && !legacyBound) ||
        operator.plan.stage === "auth-participants" ||
        record.proof?.manifestSha256 !== operator.plan.release.sha256 ||
        record.proof?.releaseId !== operator.plan.release.id)) ||
    (resourceOnly &&
      (record.environmentBound !== false ||
        operator.receipts.length !== operator.plan.effects.length ||
        operator.plan.effects.some(
          (effect) =>
            [
              "bindings",
              "delivery",
              "gateway-bindings",
              "gateway-delivery",
              "remove-bindings",
              "retire",
              "revoke",
            ].includes(effect.kind) ||
            operator.receipts.filter((receipt) => receipt.effectId === effect.id).length !== 1,
        ))) ||
    operator.plan.selection.projectId !== input.target.projectId ||
    (input.release !== undefined && !isDeepStrictEqual(operator.plan.release, input.release))
  ) {
    throw new PublicReleasePrerequisiteError("prepared_runtime_required");
  }
  return {
    operator,
    purpose: bootstrap ? ("auth-bootstrap" as const) : ("application" as const),
    record,
  };
};
