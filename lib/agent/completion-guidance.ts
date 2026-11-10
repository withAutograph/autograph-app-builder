import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";

const phaseGuidance: Partial<Record<AppBuilderWorkflowState["phase"], string>> = {
  app_spec_accepted:
    "The AppSpec is accepted but no canonical implementation proposal exists yet. For an existing app, inspect its current app-owned files and call accept_app_spec with existingAppChanges containing complete replacement contents before starting the build.",
  applied:
    "Implementation files were applied. They have not passed repository validation. For a requested private preview, start the applied app directly with start_app_preview. Run repository validation separately for reviewed delivery.",
  apply_failed:
    "Applying the implementation failed. Repair the actual reported error and retry the approved operation; do not claim delivery.",
  dependencies_prepared:
    "Dependencies are ready but no canonical implementation proposal exists yet. Retry accept_app_spec with the accepted artifact and, for an existing app, exact existingAppChanges before starting the build.",
  identity_resolved:
    "The target app was identified but no canonical implementation proposal exists yet. Retry accept_app_spec with the accepted artifact and exact existingAppChanges before starting the build.",
  planned:
    "The accepted AppSpec and canonical implementation proposal are ready. If an unapplied same-app repair is open and the user wants to continue the already applied build, use prepare_app_creation with resumeApprovedBuild: true. Otherwise continue with apply_app_creation for the planned implementation. Present the Build decision for the initial scope, including selected compute if applicable. Reuse the decision for repairs to the same approved scope. Reuse the accepted UI reference; omission of the full UI object from planning metadata is not a reason to regenerate the prototype. Genuine product revisions still follow the design acceptance flow.",
  reviewed:
    "The change set was reviewed after repository validation. Review does not establish product behavior or a reachable app preview.",
  ui_accepted:
    "The accepted UI is a design prototype. Record or reuse a build-ready AppSpec, then call accept_app_spec with exact existingAppChanges for an existing app. Apply the resulting proposal in the private checkout.",
  ui_previewed:
    "The recorded UI is a design prototype. Fixture interactions do not prove that the implemented app has persistence, authentication, orchestration, or a working backend.",
  validated:
    "Repository commands passed. Product behavior and a working app preview are not established by that result. Exercise the accepted product outcomes against the implemented app before describing those outcomes as working.",
  validation_failed:
    "Repository validation failed. Start a requested private preview if the applied app can run. Lint remains advisory for preview startup. For in-scope preview repairs, use validate_app_creation with repairOnly and the changed implementationFiles, then start the preview. For reviewed delivery, repair the reported diagnostics with corrected implementationFiles and retry validate_app_creation in the same approved checkout. App-owned data adapters, actions, obsolete demo/reset paths and their discovered tests remain implementation work within the accepted AppSpec. Continue their repair through the supported tools; a failed app-owned integration or test is not an external blocker. If a required runtime capability is actually unavailable, report that specific missing capability and the evidence.",
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
    "Later tool results supersede this turn-start snapshot. After apply_app_creation succeeds, start a requested private preview directly. Run validate_app_creation separately for reviewed delivery.",
    "Distinguish app-owned repairs from external blockers. When the accepted AppSpec requires authenticated persistence, migrate remaining app-owned fixture-only data reads, actions, reset flows and tests to the repository's documented trusted request context and prepared runtime. Inspect current exports and complete the typed integration in the same private checkout. Returning a list of remaining app-owned changes or re-running the same failing tests does not complete this work. Preserve actual role/tenant enforcement and test the accepted outcomes. If the repair changes the accepted product scope or needs a new outward effect, use the corresponding public question or approval instead.",
    "When a Builder operation fails, report the exact operation, the concrete error or command diagnostic, what it means for this app, and the supported next repair action. Preserve useful file paths, exit codes, and the provider's safe cause. Never replace a specific failure with a generic statement that app preparation could not finish. If the provider gave no cause, say the diagnostic is missing and identify the operation and session for repair.",
    "Successful repository commands establish technical validation only. A fixture preview is a prototype, not a running implementation. Verify the accepted product outcomes with real implementation evidence and describe unverified outcomes honestly.",
    "When validation returns productionHandoff, treat it as an advisory source summary. Report the described routes, release and roles, actual descriptor command failures, and the coverage of recorded observations. Unassessed installation, credential isolation, receipt or product behavior is neither a pass nor a delivery blocker. A historical nativeInstallerIsolation blocker computed only from a non-static source descriptor is not an observed credential failure. Use the existing protected Production setup and delivery status for operational facts; preserve concrete credential, authorization, provider and command refusals. Continue the owning setup/publication/merge approvals and provider-owned native activation without adding Preview, synthetic testing or manual operator qualification.",
    "For requested hosted generated-app delivery, technically validate and independently review the implementation, then use prepare_github_draft_review, complete the destination diff review, accept_change_set, seal_github_draft_pr_proposal, and the separately approved publish_github_draft_pr. Existing drafts use their update or reconciliation path. Verify appSourceRecording is recorded before full app preparation and delivery; if unavailable, resume that approved publication to record its actual source. Initial Auth/resource bootstrap may happen first. Hosted behavior remains unassessed until the actual app runs; do not wait for that behavior before publishing the reviewed source needed to deploy it. Never substitute another app or repository head for the selected release's published source.",
    "Use only an actual app URL returned by the supported runtime or delivery operation. Never invent localhost:<port>, substitute a prototype URL, or claim the working app is ready without real delivery evidence. If a runtime operation fails, repair that actual error through supported capabilities or report the incomplete delivery.",
    "The configured output directory is a publication destination. An empty destination does not prove that the private sandbox contains no implementation. Publication requires its own approval naming the outward effect; do not publish merely to populate that directory or to obtain completion evidence.",
  ].join("\n\n");
