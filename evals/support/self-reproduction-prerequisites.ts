/* oxlint-disable anti-slop/no-runtime-typeof -- Preserve runtime discrimination within JSX or template expressions and existing input handling. */
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
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
export const assertAcceptedAppSpec = (status: unknown): void => {
  const phase =
    typeof status === "object" && status !== null && "phase" in status ? status.phase : undefined;
  if (typeof phase !== "string" || !acceptedSpecPhases.has(phase)) {
    throw new Error(
      `Self-reproduction generation stopped before target preparation: no accepted build-ready AppSpec (workflow phase: ${typeof phase === "string" ? phase : "unavailable"}). Preserve the design-stage tool failures as baseline evidence.`,
    );
  }
};
