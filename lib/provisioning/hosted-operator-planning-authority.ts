import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import {
  HostedOperatorError,
  operatorPlanDigest,
  retainedOperatorAuthSchema,
  sameOperatorSelection,
} from "./hosted-operator-contract";
import { infrastructureOnly } from "./hosted-operator-existing-auth-bootstrap";
import { retainedOperatorAuthFromJournal } from "./hosted-runtime-journal";
import type { RetainedOperatorAuth } from "./hosted-operator-contract";
import type { HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { matchesExactCompiledOperatorRelease } from "./hosted-operator-artifact-selection";
import { reportOperatorPlanningMismatch } from "./hosted-operator-consent-diagnostic";

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
    reportOperatorPlanningMismatch(context.target.sessionId, "prepared_preview_journal", {
      journal_missing: current === undefined,
      operator_missing: operator === undefined,
    });
    throw new HostedOperatorError("resource_mismatch");
  }
  const { plan } = operator;
  const { delivery } = plan;
  const artifactRef = plan.release.artifactRef;
  if (delivery === undefined || delivery.gitSha === undefined || artifactRef === undefined) {
    reportOperatorPlanningMismatch(context.target.sessionId, "prepared_preview_journal", {
      delivery_missing: delivery === undefined,
      delivery_sha_missing: delivery?.gitSha === undefined,
      artifact_missing: artifactRef === undefined,
    });
    throw new HostedOperatorError("resource_mismatch");
  }
  const preparedMatches = [
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
  ];
  const matchesPrepared = preparedMatches.every(Boolean);
  if (!matchesPrepared) {
    reportOperatorPlanningMismatch(context.target.sessionId, "prepared_preview_journal", {
      journal_status: !preparedMatches[0],
      plan_action: !preparedMatches[1],
      plan_stage: !preparedMatches[2],
      plan_digest: !preparedMatches[3],
      selection_app: !preparedMatches[4],
      selection_branch: !preparedMatches[5],
      selection_environment: !preparedMatches[6],
      selection_project: !preparedMatches[7],
      selection_session: !preparedMatches[8],
      delivery_project: !preparedMatches[9],
    });
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
    reportOperatorPlanningMismatch(context.target.sessionId, "prepared_preview_selection", {
      selection_missing: true,
    });
    throw new HostedOperatorError("resource_mismatch");
  }
  const releaseMatches = [
    matchesExactCompiledOperatorRelease(selection, lookup),
    selection.appId === context.target.appId,
    selection.releaseId === plan.release.id,
    selection.manifestSha256 === plan.release.sha256,
  ];
  const matchesRelease = releaseMatches.every(Boolean);
  if (!matchesRelease) {
    reportOperatorPlanningMismatch(context.target.sessionId, "prepared_preview_selection", {
      release_source_binding: !releaseMatches[0],
      release_app: !releaseMatches[1],
      release_id: !releaseMatches[2],
      release_manifest: !releaseMatches[3],
    });
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

const readOwnedPlanningContext = async (
  context: HostedOperatorContext,
  controlPlane: ControlPlane,
) => {
  const owned = await controlPlane.readCurrentPlanningOwner(context);
  const decision = owned.session.privateBuildDecision;
  const currentSpec = decision?.currentSpec;
  if (currentSpec === undefined || decision === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  // currentSpec.workspaceId names the repository execution workspace. Tenant ownership
  // comes from the canonical owner principal and authority, not that Sandbox identity.
  const matchesOwner = [
    decision.adapterSessionId === owned.session.adapterSessionId,
    currentSpec.sessionId ===
      (owned.session.nativeRecoveryBinding?.logicalSessionId ?? owned.session.adapterSessionId),
    owned.session.principal.workspaceId === context.authority.workspaceId,
    currentSpec.appId === context.target.appId,
  ].every(Boolean);
  if (!matchesOwner) {
    throw new HostedOperatorError("operator_unavailable");
  }
  return { decision, currentSpec };
};

const assertBootstrapApproval = async (
  context: HostedOperatorContext,
  readApproval: NonNullable<ControlPlane["readApproval"]>,
  auth: RetainedOperatorAuth,
) => {
  const approval = await readApproval({
    ...context,
    action: "prepare",
    callId: auth.approvedByCallId,
    planDigest: auth.planDigest,
  });
  const approved = [
    approval?.approved === true,
    approval?.approvalId === auth.approvalId,
    approval?.callId === auth.approvedByCallId,
    approval?.planDigest === auth.planDigest,
    approval?.action === "prepare",
  ].every(Boolean);
  if (!approved) {
    throw new HostedOperatorError("authorization_required");
  }
};

const readBootstrapPublishedSelection = async (
  context: HostedOperatorContext,
  controlPlane: ControlPlane,
  plan: RetainedOperatorAuth["plan"],
) => {
  const lookup = { appSpecDigest: plan.contextId, artifactRef: plan.release.artifactRef };
  const matchesRelease = (value: Awaited<ReturnType<ControlPlane["readGeneratedSelection"]>>) =>
    value !== undefined &&
    [
      matchesExactCompiledOperatorRelease(value, lookup),
      value.appId === context.target.appId,
      value.releaseId === plan.release.id,
      value.manifestSha256 === plan.release.sha256,
    ].every(Boolean);
  // Anchor the read to the saved artifact, never a later private capture.
  let selection = await controlPlane.readGeneratedSelection(context, plan.contextId, lookup);
  if (selection !== undefined && !matchesRelease(selection)) {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (selection?.publishedSource === undefined) {
    // Publication may have been appended after the exact completion marker.
    // Only the same frozen release can contribute that canonical association.
    const published = await controlPlane.readGeneratedSelection(context, plan.contextId);
    if (matchesRelease(published) && published?.publishedSource !== undefined) {
      selection = published;
    }
  }
  if (selection === undefined || selection.publishedSource === undefined) {
    throw new HostedOperatorError("app_source_publication_required");
  }
  return selection;
};

/** A completed infrastructure approval identifies a frozen release, not a prepared app. */
export const readOwnedBootstrapPlanningSelection = async (input: {
  context: HostedOperatorContext;
  controlPlane: ControlPlane;
}): Promise<
  | {
      approvedScope: Awaited<ReturnType<typeof readOwnedPlanningContext>>["decision"]["scope"];
      currentSpec: Awaited<ReturnType<typeof readOwnedPlanningContext>>["currentSpec"];
      selection: Awaited<ReturnType<typeof readBootstrapPublishedSelection>>;
      contextId: string;
      assertCurrent: () => Promise<void>;
    }
  | undefined
> => {
  const context = structuredClone({
    authority: input.context.authority,
    ownerContext: input.context.ownerContext,
    target: input.context.target,
  });
  const { controlPlane } = input;
  const { store, readApproval } = controlPlane;
  if (store === undefined || readApproval === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  const [{ decision, currentSpec }, current] = await Promise.all([
    readOwnedPlanningContext(context, controlPlane),
    store.read(context),
  ]);
  const operator = current?.record.operator;
  if (
    current === undefined ||
    operator === undefined ||
    current.record.privateState === undefined ||
    !infrastructureOnly(operator.plan)
  ) {
    return undefined;
  }
  const retained = retainedOperatorAuthSchema.safeParse(
    current.record.retainedAuth ?? retainedOperatorAuthFromJournal(current.record),
  );
  if (!retained.success || !infrastructureOnly(retained.data.plan)) {
    return undefined;
  }
  const auth = retained.data;
  const { plan } = auth;
  const selectionScope = {
    appId: context.target.appId,
    branch: context.target.branch,
    environment: context.target.environment,
    projectId: context.target.projectId,
    sessionId: context.target.sessionId,
  };
  if (
    !sameOperatorSelection(plan.selection, selectionScope) ||
    !sameOperatorSelection(operator.plan.selection, selectionScope) ||
    operator.planDigest !== operatorPlanDigest(operator.plan)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  await assertBootstrapApproval(context, readApproval, auth);
  const assertCurrent = async () => {
    await controlPlane.readCurrentPlanningOwner(context);
    const fresh = await store.read(context);
    const active = fresh?.record.operator;
    const retainedNow = retainedOperatorAuthSchema.safeParse(
      fresh === undefined
        ? undefined
        : (fresh.record.retainedAuth ?? retainedOperatorAuthFromJournal(fresh.record)),
    );
    const sameAuthority = [
      active?.operationRef === operator.operationRef,
      active?.approvalId === operator.approvalId,
      active?.planDigest === operator.planDigest,
      fresh?.record.approvedByCallId === current.record.approvedByCallId,
      active !== undefined && operatorPlanDigest(active.plan) === operator.planDigest,
      active?.pendingEffectId === undefined,
      active?.pendingEffectAttempt === undefined,
      fresh?.record.leaseId === undefined,
      fresh?.record.leaseExpiresAt === undefined,
      retainedNow.success && retainedNow.data.operationRef === auth.operationRef,
      retainedNow.success && retainedNow.data.approvalId === auth.approvalId,
      retainedNow.success && retainedNow.data.approvedByCallId === auth.approvedByCallId,
      retainedNow.success && retainedNow.data.planDigest === auth.planDigest,
    ].every(Boolean);
    if (!sameAuthority) {
      throw new HostedOperatorError("operation_in_progress");
    }
  };
  await assertCurrent();
  const selection = await readBootstrapPublishedSelection(context, controlPlane, plan);
  await assertCurrent();
  return {
    approvedScope: decision.scope,
    currentSpec,
    selection,
    contextId: plan.contextId,
    assertCurrent,
  };
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
  const { decision, currentSpec } = await readOwnedPlanningContext(context, input.controlPlane);
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
