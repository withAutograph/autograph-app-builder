/** Accepted artifact phases in the ordinary local creation workflow. */
const acceptedSpecPhases = new Set([
  "app_spec_accepted",
  "dependencies_prepared",
  "identity_resolved",
  "planned",
  "apply_failed",
  "applied",
  "validation_pending",
  "validation_failed",
  "validated",
  "reviewed",
]);

/** Stop before target preparation when design did not produce its required artifact. */
type AppSpecWorkflowStatus = { phase?: string } | null | undefined;

export const assertAcceptedAppSpec = (status?: AppSpecWorkflowStatus): void => {
  const phase = status?.phase;
  if (phase === undefined || !acceptedSpecPhases.has(phase)) {
    throw new Error(
      `Self-reproduction generation stopped before target preparation: no accepted build-ready AppSpec (workflow phase: ${phase ?? "unavailable"}). Preserve the design-stage tool failures as baseline evidence.`,
    );
  }
};
