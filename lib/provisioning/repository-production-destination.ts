import type { ExistingRepositoryDestination } from "./builder-session-destination-contract";
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
import type {
  AppPublicationDestination,
  CompiledOperatorReleaseSelection,
} from "./hosted-operator-artifact-selection";
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

const assertAppSpecification = (
  expected: Pick<AppPublicationDestination, "appId" | "appSpecDigest">,
  value: Pick<AppPublicationDestination, "appId" | "appSpecDigest"> | undefined,
) => {
  if (
    value !== undefined &&
    (value.appId !== expected.appId || value.appSpecDigest !== expected.appSpecDigest)
  ) {
    throw new Error("repository_production_capture_unavailable");
  }
};

/** Source acquisition and reviewed publication are separate, independently owned authorities. */
export const resolveRepositoryProductionDestination = <Profile extends DestinationProfile>(input: {
  workspaceId: string;
  appId: string;
  appSpecDigest: string;
  source?: ApprovedBuildDecision["existingRepositorySource"];
  selection?: CompiledOperatorReleaseSelection;
  destination?: AppPublicationDestination;
  repositoryDestination?: ExistingRepositoryDestination;
  repositories: readonly Profile[];
}) => {
  const { source, selection, destination, repositoryDestination } = input;
  if (repositoryDestination !== undefined && repositoryDestination.appId !== input.appId) {
    throw new Error("repository_production_scope_denied");
  }
  assertAppSpecification(input, selection);
  assertAppSpecification(input, destination);
  if (
    selection?.publishedSource !== undefined &&
    destination !== undefined &&
    selection.publishedSource.repositoryId !== destination.publishedSource.repositoryId
  ) {
    throw new Error("repository_production_scope_denied");
  }
  const published = selection?.publishedSource ?? destination?.publishedSource;
  if (
    source !== undefined &&
    published !== undefined &&
    source.repository.repositoryId !== published.repositoryId
  ) {
    throw new Error("repository_production_scope_denied");
  }
  const repositoryId =
    published?.repositoryId ??
    source?.repository.repositoryId ??
    repositoryDestination?.repository.repositoryId;
  if (
    repositoryDestination !== undefined &&
    repositoryId !== repositoryDestination.repository.repositoryId
  ) {
    throw new Error("repository_production_scope_denied");
  }
  const sourceSha = published?.gitSha ?? source?.repository.headSha;
  if (repositoryId === undefined || sourceSha === undefined) {
    throw new RepositoryProductionDestinationRequiredError();
  }
  const profiles = input.repositories.filter((profile) => {
    const matchesDestination =
      repositoryDestination === undefined ||
      profile.repositoryFullName ===
        `${repositoryDestination.repository.owner}/${repositoryDestination.repository.name}`;
    const matchesSource =
      source === undefined ||
      profile.repositoryFullName === `${source.repository.owner}/${source.repository.name}`;
    return [
      profile.workspaceId === input.workspaceId,
      profile.repositoryId === repositoryId,
      matchesDestination,
      matchesSource,
    ].every(Boolean);
  });
  if (profiles.length !== 1) {
    throw new Error("repository_production_scope_denied");
  }
  // The publication marker supplies the globally unique repository identity;
  // the operator's explicit workspace mapping supplies its authorized runtime destination.
  return { profile: profiles[0], sourceSha };
};
