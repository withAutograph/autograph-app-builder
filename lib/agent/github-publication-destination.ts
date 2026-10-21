import type { GitHubPublicationDestinationIdentity } from "./github-publication-runtime";
import { repositoryAccessReceiptSchema } from "./repository-access-state";
import type { RepositoryAccessReceipt } from "./repository-access-state";
import { assertGitHubDestinationReviewBinding } from "../repository/github-destination-review";
import type { GitHubDestinationReviewBinding } from "../repository/github-destination-review";
import type { ToolContext } from "eve/tools";
import type { ImmutableGitHubSourceReceipt } from "../repository/github-publication";
import type { SourceKind } from "../repository/source-receipt";
import type { RepositoryAccessResult } from "../integrations/repository-access";
import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "./repository-access-tool";

export interface PublicationDestinationSelector {
  repository: string;
  selectedInstallationId?: string | null;
}

type PublicationTarget =
  | { githubSource: ImmutableGitHubSourceReceipt; destination?: never }
  | { githubSource?: never; destination: GitHubPublicationDestinationIdentity };

/** Destination access never changes the acquired source or grants publication authority. */
export const publicationDestinationFromAccess = (
  receipt: RepositoryAccessReceipt,
  sessionId: string,
): GitHubPublicationDestinationIdentity => {
  const access = repositoryAccessReceiptSchema.parse(receipt);
  if (access.sessionId !== sessionId) {
    throw new Error("The publication destination access belongs to another session.");
  }
  return {
    defaultBranch: access.repository.defaultBranch,
    installationId: access.scope.installationId,
    name: access.repository.name,
    owner: access.repository.owner,
    repositoryId: access.repository.repositoryId,
  };
};

/** Reuse only the actual immutable destination snapshot exposed for review. */
export const publicationDestinationFromReview = (
  binding: GitHubDestinationReviewBinding,
): GitHubPublicationDestinationIdentity => {
  assertGitHubDestinationReviewBinding(binding, binding);
  return {
    defaultBranch: binding.repository.defaultBranch,
    installationId: binding.installation.installationId,
    name: binding.repository.name,
    owner: binding.repository.owner,
    repositoryId: binding.repository.repositoryId,
  };
};

/** Use the ordinary owned connection flow without replacing an acquired checkout. */
export const resolvePublicationTargetForTool = async (input: {
  ctx: ToolContext;
  destination?: PublicationDestinationSelector;
  githubSource?: ImmutableGitHubSourceReceipt;
  sourceKind: SourceKind;
  destinationReview?: GitHubDestinationReviewBinding;
}): Promise<
  | { kind: "ready"; target: PublicationTarget }
  | { kind: "missing" }
  | { kind: "selection"; access: RepositoryAccessResult }
> => {
  if (input.githubSource !== undefined) {
    if (
      input.destination !== undefined &&
      input.destination.repository.toLowerCase() !==
        `${input.githubSource.repository.owner}/${input.githubSource.repository.name}`.toLowerCase()
    ) {
      throw new Error("The publication destination differs from the selected GitHub repository.");
    }
    return { kind: "ready", target: { githubSource: input.githubSource } };
  }
  if (input.sourceKind !== "fresh-template") {
    throw new Error("Restore the selected GitHub source before preparing its destination review.");
  }
  const retained =
    input.destinationReview === undefined
      ? undefined
      : publicationDestinationFromReview(input.destinationReview);
  const destination =
    input.destination ??
    (retained === undefined
      ? undefined
      : {
          repository: `${retained.owner}/${retained.name}`,
          selectedInstallationId: retained.installationId,
        });
  if (destination === undefined) {
    return { kind: "missing" };
  }
  const access = await resolveRepositoryAccessForTool(
    {
      repository: destination.repository,
      selectedInstallationId: destination.selectedInstallationId ?? undefined,
    },
    input.ctx,
    await repositoryAccessRuntimeForSession(input.ctx.session.auth),
  );
  if (access.kind === "selection") {
    return { kind: "selection", access: access.access };
  }
  return {
    kind: "ready",
    target: { destination: publicationDestinationFromAccess(access.receipt, input.ctx.session.id) },
  };
};
