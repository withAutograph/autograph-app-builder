import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

/** Hosted generated releases deploy their own published source, never a configured sample SHA. */
export const resolvePublishedAppDelivery = (
  application: Pick<
    HostedOperatorSourceConfiguration["applications"][string],
    "branch" | "gitSha" | "projectId" | "repoId"
  >,
  selectedRelease?: CompiledOperatorReleaseSelection,
): NonNullable<HostedOperatorPlan["delivery"]> => {
  if (selectedRelease !== undefined) {
    const source = selectedRelease.publishedSource;
    if (source === undefined) {
      throw new HostedOperatorError("operator_unavailable");
    }
    return {
      branch: source.branch,
      gitSha: source.gitSha,
      projectId: application.projectId,
      repoId: source.repositoryId,
    };
  }
  // Retain the pre-existing explicitly configured caller contract outside hosted release planning.
  if (application.repoId === undefined || application.gitSha === undefined) {
    throw new HostedOperatorError("operator_unavailable");
  }
  return {
    branch: application.branch,
    gitSha: application.gitSha,
    projectId: application.projectId,
    repoId: application.repoId,
  };
};
