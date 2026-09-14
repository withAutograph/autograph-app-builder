import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";

const phaseGuidance: Partial<Record<AppBuilderWorkflowState["phase"], string>> = {
  applied:
    "Implementation files were applied. They have not passed repository validation. Call validate_app_creation next in the approved private checkout.",
  apply_failed:
    "Applying the implementation failed. Repair the actual reported error and retry the approved operation; do not claim delivery.",
  reviewed:
    "The change set was reviewed after repository validation. Review does not establish product behavior or a reachable app preview.",
  ui_accepted:
    "The accepted UI is a design prototype. UI acceptance is not implementation or product verification.",
  ui_previewed:
    "The recorded UI is a design prototype. Fixture interactions do not prove that the implemented app has persistence, authentication, orchestration, or a working backend.",
  validated:
    "Repository commands passed. Product behavior and a working app preview are not established by that result. Exercise the accepted product outcomes against the implemented app before describing those outcomes as working.",
  validation_failed:
    "Repository validation failed. Repair the reported diagnostics with corrected implementationFiles and retry validate_app_creation in the same approved checkout. If recovery is unavailable, explain the actual incomplete outcome.",
  validation_pending:
    "Repository validation is unfinished. Continue validate_app_creation and use its actual result before describing the implementation as checked.",
};

/** Context for the model, never a workflow transition or a completion gate. */
export const completionGuidance = (state: Pick<AppBuilderWorkflowState, "phase">): string =>
  [
    "App delivery context at the start of this turn:",
    `Workflow phase: ${state.phase}.`,
    phaseGuidance[state.phase] ??
      "Use the current tool results to describe what has actually completed; this phase alone is not proof of working product behavior.",
    "Later tool results supersede this turn-start snapshot. After apply_app_creation succeeds, always continue with validate_app_creation; applied does not mean validated.",
    "Successful repository commands establish technical validation only. A fixture preview is a prototype, not a running implementation. Verify the accepted product outcomes with real implementation evidence and describe unverified outcomes honestly.",
    "Use only an actual app URL returned by the supported runtime or delivery operation. Never invent localhost:<port>, substitute a prototype URL, or claim the working app is ready without real delivery evidence. If a runtime operation fails, repair that actual error through supported capabilities or report the incomplete delivery.",
    "The configured output directory is a publication destination. An empty destination does not prove that the private sandbox contains no implementation. Publication requires its own approval naming the outward effect; do not publish merely to populate that directory or to obtain completion evidence.",
  ].join("\n\n");
