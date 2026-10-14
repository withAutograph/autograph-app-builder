import { plannedAppBranch } from "./hosted-operator-contract";
import type {
  HostedOperatorPlan,
  HostedOperatorRecord,
  ManagedOperatorEnvironmentRow,
} from "./hosted-operator-contract";

/** Exact journal-owned references across actual publication branches, including the active branch. */
export const ownedAppEnvironmentRows = (operator: HostedOperatorRecord) => {
  const rows = new Map<string, ManagedOperatorEnvironmentRow>();
  for (const scope of operator.retainedAppDeliveries ?? []) {
    for (const row of scope.managedEnvironment) {
      rows.set(row.id, row);
    }
  }
  for (const row of operator.managedEnvironment ?? []) {
    rows.set(row.id, row);
  }
  return [...rows.values()];
};

const mergeRetainedScope = (
  scope: NonNullable<HostedOperatorRecord["retainedAppDeliveries"]>[number],
  candidates: Map<string, NonNullable<HostedOperatorRecord["deliveryCandidates"]>[number]>,
  rows: Map<string, ManagedOperatorEnvironmentRow>,
) => {
  for (const candidate of scope.deliveryCandidates) {
    if (!candidates.has(candidate.deploymentId)) {
      candidates.set(candidate.deploymentId, candidate);
    }
  }
  for (const row of scope.managedEnvironment) {
    if (!rows.has(row.id)) {
      rows.set(row.id, row);
    }
  }
};

/** A new source branch does not redefine or discard the actual prior delivery scopes. */
export const retainAppDeliveryHistory = (
  prior: HostedOperatorRecord,
  next: HostedOperatorRecord,
) => {
  const branch = plannedAppBranch(next.plan);
  const history = [...(prior.retainedAppDeliveries ?? [])];
  const changedBranch = plannedAppBranch(prior.plan) !== branch;
  if (changedBranch) {
    history.push({
      branch: plannedAppBranch(prior.plan),
      delivery: prior.plan.delivery,
      deliveryCandidates: prior.deliveryCandidates ?? [],
      managedEnvironment: prior.managedEnvironment ?? [],
      operationRef: prior.operationRef,
      planDigest: prior.planDigest,
      projectId: prior.plan.selection.projectId,
    });
  }
  const candidates = new Map<
    string,
    NonNullable<HostedOperatorRecord["deliveryCandidates"]>[number]
  >();
  const rows = new Map<string, ManagedOperatorEnvironmentRow>();
  for (const candidate of prior.deliveryCandidates ?? []) {
    if (candidate.branch === branch) {
      candidates.set(candidate.deploymentId, candidate);
    }
  }
  for (const row of prior.managedEnvironment ?? []) {
    if (row.branch === branch) {
      rows.set(row.id, row);
    }
  }
  const latestScope = history.findLast((retained) => retained.branch === branch);
  if (changedBranch && latestScope !== undefined) {
    mergeRetainedScope(latestScope, candidates, rows);
  }
  return {
    ...next,
    deliveryCandidates: [...candidates.values()],
    managedEnvironment: [...rows.values()],
    retainedAppDeliveries: history,
  };
};

/** Put exact saved row scopes in the reviewable cleanup plan before its approval digest is frozen. */
export const planOwnedAppEnvironmentCleanup = (
  plan: HostedOperatorPlan,
  prior?: HostedOperatorRecord,
): HostedOperatorPlan => {
  if (plan.action !== "cleanup" || prior === undefined) {
    return plan;
  }
  const rows = ownedAppEnvironmentRows(prior);
  return {
    ...plan,
    appEnvironmentCleanup: rows,
    effects: plan.effects.map((effect) =>
      effect.kind === "remove-bindings"
        ? {
            ...effect,
            description: `Remove only the explicitly listed journal-owned app Preview environment row IDs in ${[...new Set(rows.map((row) => row.branch))].join(", ") || "the saved empty app scope"}; retain unrelated rows.`,
          }
        : effect,
    ),
  };
};

/** Cleanup checkpoints remove facts only after the provider confirmed the corresponding rows absent. */
export const checkpointOwnedAppEnvironmentCleanup = (
  operator: HostedOperatorRecord,
  remaining: ManagedOperatorEnvironmentRow[],
) => {
  const ids = new Set(remaining.map((row) => row.id));
  return {
    ...operator,
    managedEnvironment: (operator.managedEnvironment ?? []).filter((row) => ids.has(row.id)),
    retainedAppDeliveries: operator.retainedAppDeliveries?.map((scope) => ({
      ...scope,
      managedEnvironment: scope.managedEnvironment.filter((row) => ids.has(row.id)),
    })),
  };
};

/** A successful active-branch observation retires only archived row facts now confirmed absent. */
export const checkpointActiveAppEnvironment = (
  operator: HostedOperatorRecord,
  rows: ManagedOperatorEnvironmentRow[],
) => {
  const observedIds = new Set(rows.map((row) => row.id));
  const branch = plannedAppBranch(operator.plan);
  return {
    ...operator,
    managedEnvironment: rows,
    retainedAppDeliveries: operator.retainedAppDeliveries?.map((scope) =>
      scope.branch === branch
        ? {
            ...scope,
            managedEnvironment: scope.managedEnvironment.filter((row) => observedIds.has(row.id)),
          }
        : scope,
    ),
  };
};
