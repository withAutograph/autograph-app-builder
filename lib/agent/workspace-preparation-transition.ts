import type { AppBuilderWorkflowState } from "./workflow-state";

/** Preparing source input must not silently replace an existing authored workflow. */
export const workspacePreparationTransition = <
  Current extends Pick<AppBuilderWorkflowState, "phase">,
>(
  current: Current,
  prepared: () => Extract<AppBuilderWorkflowState, { phase: "prepared" }>,
) => (current.phase === "empty" || current.phase === "prepared" ? prepared() : current);
