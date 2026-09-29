import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";

const phaseGuidance: Partial<Record<AppBuilderWorkflowState["phase"], string>> = {
  app_spec_accepted:
    "The AppSpec is accepted but no canonical implementation proposal exists yet. For an existing app, inspect its current app-owned files and call accept_app_spec with existingAppChanges containing complete replacement contents before requesting build approval.",
  applied:
    "Implementation files were applied. They have not passed repository validation. Call validate_app_creation next in the approved private checkout.",
  apply_failed:
    "Applying the implementation failed. Repair the actual reported error and retry the approved operation; do not claim delivery.",
  dependencies_prepared:
    "Dependencies are ready but no canonical implementation proposal exists yet. Retry accept_app_spec with the accepted artifact and, for an existing app, exact existingAppChanges before requesting build approval.",
  identity_resolved:
    "The target app was identified but no canonical implementation proposal exists yet. Retry accept_app_spec with the accepted artifact and exact existingAppChanges before requesting build approval.",
  reviewed:
    "The change set was reviewed after repository validation. Review does not establish product behavior or a reachable app preview.",
  ui_accepted:
    "The accepted UI is a design prototype. Record or reuse a build-ready AppSpec, then call accept_app_spec with exact existingAppChanges for an existing app. Build approval requires its planned proposal.",
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
    "When a Builder operation fails, report the exact operation, the concrete error or command diagnostic, what it means for this app, and the supported next repair action. Preserve useful file paths, exit codes, and the provider's safe cause. Never replace a specific failure with a generic statement that app preparation could not finish. If the provider gave no cause, say the diagnostic is missing and identify the operation and session for repair.",
    "Successful repository commands establish technical validation only. A fixture preview is a prototype, not a running implementation. Verify the accepted product outcomes with real implementation evidence and describe unverified outcomes honestly.",
    "When validation returns productionHandoff, report the repository-described routes, checked source release, declared roles, blockers, and the actual coverage of recorded runtime evidence. Its descriptor is not proof of database installation, authenticated schema receipt behavior, tenant isolation, or durable product outcomes. Keep unassessed facts explicit and obtain separate operator approval for hosted preparation and provider activation.",
    "Use only an actual app URL returned by the supported runtime or delivery operation. Never invent localhost:<port>, substitute a prototype URL, or claim the working app is ready without real delivery evidence. If a runtime operation fails, repair that actual error through supported capabilities or report the incomplete delivery.",
    "The configured output directory is a publication destination. An empty destination does not prove that the private sandbox contains no implementation. Publication requires its own approval naming the outward effect; do not publish merely to populate that directory or to obtain completion evidence.",
  ].join("\n\n");
