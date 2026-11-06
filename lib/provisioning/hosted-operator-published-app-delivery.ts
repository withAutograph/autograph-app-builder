import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorPublicResult } from "./hosted-operator-contract";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import type { AppDescription } from "../repository/app-description";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

/** Hosted generated releases deploy their own published source, never a configured sample SHA. */
export const resolvePublishedAppDelivery = (
  application: Pick<
    HostedOperatorSourceConfiguration["applications"][string],
    "branch" | "gitSha" | "projectId" | "projectSettings" | "repoId"
  >,
  selectedRelease?: CompiledOperatorReleaseSelection,
  sourceDescription?: AppDescription,
): NonNullable<HostedOperatorPlan["delivery"]> => {
  if (selectedRelease !== undefined) {
    const source = selectedRelease.publishedSource;
    if (source === undefined) {
      throw new HostedOperatorError("app_source_publication_required");
    }
    let { projectSettings } = application;
    if (
      sourceDescription !== undefined &&
      !(
        application.projectSettings?.framework === "services" &&
        application.projectSettings.rootDirectory === "."
      )
    ) {
      projectSettings = sourceDescription.deployment ?? application.projectSettings;
      if (projectSettings === undefined) {
        projectSettings = {
          rootDirectory: sourceDescription.app.workspacePath,
        };
      } else {
        projectSettings = {
          ...projectSettings,
          rootDirectory: sourceDescription.app.workspacePath,
        };
      }
    }
    const delivery: NonNullable<HostedOperatorPlan["delivery"]> = {
      branch: source.branch,
      gitSha: source.gitSha,
      projectId: application.projectId,
      repoId: source.repositoryId,
    };
    if (projectSettings !== undefined) {
      delivery.projectSettings = projectSettings;
    }
    return delivery;
  }
  // Retain the pre-existing explicitly configured caller contract outside hosted release planning.
  if (application.repoId === undefined || application.gitSha === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  const delivery: NonNullable<HostedOperatorPlan["delivery"]> = {
    branch: application.branch,
    gitSha: application.gitSha,
    projectId: application.projectId,
    repoId: application.repoId,
  };
  if (application.projectSettings !== undefined) {
    delivery.projectSettings = application.projectSettings;
  }
  return delivery;
};

/** Continue normal publication when a selected generated release has no published source yet. */
export const withAppPublicationGuidance = <T extends Pick<OperatorPublicResult, "code" | "status">>(
  result: T,
) => {
  if (result.status !== "blocked" || result.code !== "app_source_publication_required") {
    return result;
  }
  return {
    ...result,
    nextAction:
      "Continue this session's normal draft publication workflow for the technically validated and reviewed app source, using the existing initial publication, draft update, or reconciliation path and its separate publication approval. Verify appSourceRecording is recorded; if unavailable, resume that same approved publication to record its actual source. Then plan hosted preparation again in this session. Keep the existing resources. Hosted behavior remains unassessed until the delivered app is exercised.",
  };
};
