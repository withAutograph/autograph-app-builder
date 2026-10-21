import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import { HostedOperatorError, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { matchesExactCompiledOperatorRelease } from "./hosted-operator-artifact-selection";

type ControlPlane = Pick<
  Awaited<ReturnType<typeof createHostedOperatorControlPlane>>,
  "readCurrentPlanningOwner" | "readGeneratedSelection"
> & {
  store?: Pick<HostedRuntimeJournalStore, "read">;
  readApproval?: ProtectedHostedOperatorDependencies["readApproval"];
};

/** The source and release come from the exact owned prepared operation. */
const readPreparedPreviewJournal = async (
  context: HostedOperatorContext,
  store: Pick<HostedRuntimeJournalStore, "read">,
) => {
  const current = await store.read(context);
  const operator = current?.record.operator;
  if (current === undefined || operator === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const { plan } = operator;
  const { delivery } = plan;
  const artifactRef = plan.release.artifactRef;
  if (delivery === undefined || delivery.gitSha === undefined || artifactRef === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const matchesPrepared = [
    current.record.status === "prepared",
    plan.action === "prepare",
    plan.stage === undefined || plan.stage === "app",
    operator.planDigest === operatorPlanDigest(plan),
    plan.selection.appId === context.target.appId,
    plan.selection.branch === context.target.branch,
    plan.selection.environment === context.target.environment,
    plan.selection.projectId === context.target.projectId,
    plan.selection.sessionId === context.target.sessionId,
    delivery.projectId === context.target.projectId,
  ].every(Boolean);
  if (!matchesPrepared) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return { current, operator, plan, artifactRef, delivery, gitSha: delivery.gitSha };
};

/** Restoration selects the approved prepared release, never a newer private capture. */
const readPreparedPreviewSelection = async (
  context: HostedOperatorContext,
  controlPlane: ControlPlane,
) => {
  const { store, readApproval } = controlPlane;
  if (store === undefined || readApproval === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  const { current, operator, plan, artifactRef, delivery, gitSha } =
    await readPreparedPreviewJournal(context, store);
  const approval = await readApproval({
    ...context,
    action: "prepare",
    callId: current.record.approvedByCallId,
    planDigest: operator.planDigest,
  });
  const approved = [
    approval?.approved === true,
    approval?.approvalId === operator.approvalId,
    approval?.callId === current.record.approvedByCallId,
    approval?.planDigest === operator.planDigest,
    approval?.action === "prepare",
  ].every(Boolean);
  if (!approved) {
    throw new HostedOperatorError("authorization_required");
  }
  const lookup = {
    appSpecDigest: plan.contextId,
    artifactRef,
    publishedSource: { repositoryId: delivery.repoId, branch: delivery.branch, gitSha },
  };
  const selection = await controlPlane.readGeneratedSelection(context, plan.contextId, lookup);
  if (selection === undefined) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const matchesRelease = [
    matchesExactCompiledOperatorRelease(selection, lookup),
    selection.appId === context.target.appId,
    selection.releaseId === plan.release.id,
    selection.manifestSha256 === plan.release.sha256,
  ].every(Boolean);
  if (!matchesRelease) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const assertCurrent = async () => {
    await controlPlane.readCurrentPlanningOwner(context);
    const fresh = await store.read(context);
    const active = fresh?.record.operator;
    const sameApprovedRelease = [
      fresh?.record.status === "prepared",
      fresh?.record.approvedByCallId === current.record.approvedByCallId,
      active?.operationRef === operator.operationRef,
      active?.approvalId === operator.approvalId,
      active?.planDigest === operator.planDigest,
      active !== undefined && operatorPlanDigest(active.plan) === operator.planDigest,
      active?.pendingEffectId === undefined,
      active?.pendingEffectAttempt === undefined,
    ].every(Boolean);
    if (!sameApprovedRelease) {
      throw new HostedOperatorError("operation_in_progress");
    }
  };
  await assertCurrent();
  return { selection, contextId: plan.contextId, assertCurrent };
};

/** Private canonical accepted state, independently re-read under current owner authority. */
export const readOwnedOperatorPlanningSelection = async (input: {
  context: HostedOperatorContext;
  controlPlane: ControlPlane;
  releaseIntent?: "prepared-preview";
}) => {
  const context = structuredClone({
    authority: input.context.authority,
    ownerContext: input.context.ownerContext,
    target: input.context.target,
  });
  const owned = await input.controlPlane.readCurrentPlanningOwner(context);
  const decision = owned.session.privateBuildDecision;
  const currentSpec = decision?.currentSpec;
  if (currentSpec === undefined || decision === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  // currentSpec.workspaceId names the repository execution workspace. Tenant ownership
  // comes from the canonical owner principal and authority, not that Sandbox identity.
  const matchesOwner = [
    decision.adapterSessionId === owned.session.adapterSessionId,
    currentSpec.sessionId === owned.session.adapterSessionId,
    owned.session.principal.workspaceId === context.authority.workspaceId,
    currentSpec.appId === context.target.appId,
  ].every(Boolean);
  if (!matchesOwner) {
    throw new HostedOperatorError("operator_unavailable");
  }
  if (input.releaseIntent === "prepared-preview") {
    const prepared = await readPreparedPreviewSelection(context, input.controlPlane);
    return { approvedScope: decision.scope, currentSpec, ...prepared };
  }
  // Artifacts use the public canonical owner session; currentSpec identifies its adapter.
  const selection = await input.controlPlane.readGeneratedSelection(
    context,
    currentSpec.appSpecDigest,
  );
  // Fresh owner authorization is required; ordinary accepted-spec edits are new
  // planning input, not a reason to reject this coherent immutable snapshot.
  await input.controlPlane.readCurrentPlanningOwner(context);
  return {
    approvedScope: decision.scope,
    currentSpec,
    selection,
    contextId: currentSpec.appSpecDigest,
    assertCurrent: null,
  };
};
