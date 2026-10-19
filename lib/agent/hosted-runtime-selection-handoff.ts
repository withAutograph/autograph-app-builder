import {
  HostedOperatorError,
  operatorPublicResultSchema,
} from "../provisioning/hosted-operator-contract";
import {
  assertHostedRuntimeApprovedReference,
  loadHostedRuntimeApprovedReference,
} from "./hosted-runtime-approved-reference";
import { preparedRuntimeReferences, preparedRuntimeSelections } from "./prepared-runtime-selection";
import type { PreparedRuntimeSelection } from "./prepared-runtime-selection";
import { reportHostedRuntimeHandoffDiagnostic } from "./hosted-runtime-handoff-diagnostic";

interface HandoffPorts {
  load: typeof loadHostedRuntimeApprovedReference;
  assertCurrent: typeof assertHostedRuntimeApprovedReference;
}
const deployedPorts: HandoffPorts = {
  assertCurrent: assertHostedRuntimeApprovedReference,
  load: loadHostedRuntimeApprovedReference,
};
const preparationReference = operatorPublicResultSchema
  .pick({ appId: true, operationRef: true, planDigest: true, status: true })
  .strip();
const preparationStatus = preparationReference.pick({ appId: true, status: true });
const retainedStatuses = new Set([
  "prepared",
  "pending",
  "auth-schema-prepared",
  "participants-prepared",
]);

/** Capture only the existing public reference in the owning result-hook context. */
export const retainHostedRuntimePreparationReference = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Validate the runtime result before retaining its resource reference.
  output: unknown,
): boolean => {
  const status = preparationStatus.safeParse(output);
  if (!status.success || !retainedStatuses.has(status.data.status)) {
    reportHostedRuntimeHandoffDiagnostic({ outcome: "ineligible", stage: "reference_capture" });
    return false;
  }
  const parsed = preparationReference.safeParse(output);
  if (
    !parsed.success ||
    parsed.data.operationRef === undefined ||
    parsed.data.planDigest === undefined
  ) {
    // A malformed protected preparation result must not become a legacy
    // Sandbox fallback. The ordinary consumer reports this real protocol failure.
    preparedRuntimeReferences.update((current) => ({ ...current, [status.data.appId]: null }));
    reportHostedRuntimeHandoffDiagnostic({
      outcome: "invalid_reference",
      stage: "reference_capture",
    });
    return false;
  }
  const { appId, operationRef, planDigest } = parsed.data;
  preparedRuntimeReferences.update((current) => ({
    ...current,
    [appId]: { appId, operationRef, planDigest },
  }));
  reportHostedRuntimeHandoffDiagnostic({ outcome: "retained", stage: "reference_capture" });
  return true;
};

/**
 * Authored Workflow steps have their own Eve context. Resolve their retained
 * result in an ordinary tool's owner context before reading protected bindings.
 * The reference is never authority: the existing approval reader checks the
 * current owner, generation, cancellation revision, plan, and operation.
 */
export const resolveHostedRuntimePreparationSelection = async (
  input: { appId: string; sessionAuth: unknown; sessionId: string; signal?: AbortSignal },
  ports: HandoffPorts = deployedPorts,
): Promise<PreparedRuntimeSelection | null> => {
  const references = preparedRuntimeReferences.get();
  const reference = Object.hasOwn(references, input.appId) ? references[input.appId] : undefined;
  if (reference === null) {
    reportHostedRuntimeHandoffDiagnostic({
      referenceState: "invalid",
      stage: "owner_selection_read",
    });
    throw new HostedOperatorError("resource_mismatch");
  }
  if (reference === undefined) {
    const selections = preparedRuntimeSelections.get();
    reportHostedRuntimeHandoffDiagnostic({
      referenceState: "absent",
      selectionPresent: Object.hasOwn(selections, input.appId),
      stage: "owner_selection_read",
    });
    return Object.hasOwn(selections, input.appId) ? (selections[input.appId] ?? null) : null;
  }
  reportHostedRuntimeHandoffDiagnostic({
    referenceState: "present",
    stage: "owner_selection_read",
  });
  const ctx = {
    abortSignal: input.signal ?? new AbortController().signal,
    session: { id: input.sessionId, auth: input.sessionAuth },
  };
  ctx.abortSignal.throwIfAborted();
  const loaded = await ports.load(
    { appId: reference.appId, operationRef: reference.operationRef },
    ctx,
  );
  if (
    loaded.input.appId !== input.appId ||
    loaded.input.operationRef !== reference.operationRef ||
    loaded.input.planDigest !== reference.planDigest ||
    loaded.snapshot.adapterSessionId !== input.sessionId
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  await ports.assertCurrent(loaded.snapshot, ctx);
  ctx.abortSignal.throwIfAborted();
  const current = preparedRuntimeReferences.get()[input.appId];
  if (
    current?.operationRef !== reference.operationRef ||
    current.planDigest !== reference.planDigest
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const selection: PreparedRuntimeSelection = {
    appId: loaded.input.appId,
    branch: loaded.input.branch,
    operationRef: loaded.input.operationRef,
    planDigest: loaded.input.planDigest,
    projectId: loaded.input.projectId,
    sessionId: loaded.snapshot.sessionId,
  };
  preparedRuntimeSelections.update((selections) => ({
    ...selections,
    [input.appId]: selection,
  }));
  preparedRuntimeReferences.update((pending) =>
    Object.fromEntries(Object.entries(pending).filter(([appId]) => appId !== input.appId)),
  );
  return selection;
};
