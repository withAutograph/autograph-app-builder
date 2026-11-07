import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import type { RepositoryProductionRepository } from "./repository-production-configuration";

export class RepositoryProductionDestinationRequiredError extends Error {
  readonly code = "app_setup_destination_required";

  constructor() {
    super("This app has no saved repository destination available for Production setup.");
    this.name = "RepositoryProductionDestinationRequiredError";
  }
}

type DestinationProfile = Pick<
  RepositoryProductionRepository,
  "workspaceId" | "repositoryId" | "repositoryFullName"
>;

/** Source acquisition and reviewed publication are separate, independently owned authorities. */
export const resolveRepositoryProductionDestination = <Profile extends DestinationProfile>(input: {
  workspaceId: string;
  appId: string;
  appSpecDigest: string;
  source?: ApprovedBuildDecision["existingRepositorySource"];
  selection?: CompiledOperatorReleaseSelection;
  repositories: readonly Profile[];
}) => {
  const { source, selection } = input;
  if (
    selection !== undefined &&
    (selection.appId !== input.appId || selection.appSpecDigest !== input.appSpecDigest)
  ) {
    throw new Error("repository_production_capture_unavailable");
  }
  const published = selection?.publishedSource;
  if (
    source !== undefined &&
    published !== undefined &&
    source.repository.repositoryId !== published.repositoryId
  ) {
    throw new Error("repository_production_scope_denied");
  }
  const repositoryId = published?.repositoryId ?? source?.repository.repositoryId;
  const sourceSha = published?.gitSha ?? source?.repository.headSha;
  if (repositoryId === undefined || sourceSha === undefined) {
    throw new RepositoryProductionDestinationRequiredError();
  }
  const profiles = input.repositories.filter(
    (profile) =>
      profile.workspaceId === input.workspaceId &&
      profile.repositoryId === repositoryId &&
      (source === undefined ||
        profile.repositoryFullName === `${source.repository.owner}/${source.repository.name}`),
  );
  if (profiles.length !== 1) {
    throw new Error("repository_production_scope_denied");
  }
  // The publication marker supplies the globally unique repository identity;
  // the operator's explicit workspace mapping supplies its authorized runtime destination.
  return { profile: profiles[0], sourceSha };
};
