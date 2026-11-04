/** A missing proven historical source is a typed prerequisite, never a repair retry. */
export class LocalPlanningSourcePrerequisiteError extends Error {
  readonly code = "local_source_baseline_required" as const;
  readonly originalSourceSha: string;
  readonly originalWorkspaceDigest: string;
  constructor(originalSourceSha: string, originalWorkspaceDigest: string) {
    super(
      "The retained original source Git bytes do not match the saved planning baseline. No new source changes were applied to the saved app workspace; recover its original source artifact before reconciling.",
    );
    this.originalSourceSha = originalSourceSha;
    this.originalWorkspaceDigest = originalWorkspaceDigest;
    this.name = "LocalPlanningSourcePrerequisiteError";
  }
}
