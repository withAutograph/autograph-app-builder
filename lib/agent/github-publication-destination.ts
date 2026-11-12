import {
  readBuilderPublicationDestinationForTool,
  recordBuilderPublicationDestinationForTool,
} from "./builder-publication-destination";
import { withBuilderDestinationGuidance } from "../provisioning/builder-destination-guidance";

import type { DirectProductionSubject } from "./direct-production-authorization";
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

type ApprovedProductionDestination = Pick<
  DirectProductionSubject,
  "repositoryFullName" | "repositoryId" | "installationId" | "baseBranch"
>;

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
interface PublicationResolverPorts<Context> {
  readOwnedDestination: (
    ctx: Context,
    appId: string,
  ) => ReturnType<typeof readBuilderPublicationDestinationForTool>;
  persistDestination?: (
    ctx: Context,
    appId: string,
    receipt: RepositoryAccessReceipt,
    options?: { requireExactReadback: boolean },
  ) => Promise<void>;
  resolveAccess: (
    destination: PublicationDestinationSelector,
    ctx: Context,
  ) => ReturnType<typeof resolveRepositoryAccessForTool>;
}
const assertPublicationDestinationConstraints = (
  input: {
    destination?: PublicationDestinationSelector;
    githubSource?: ImmutableGitHubSourceReceipt;
  },
  ownedDestination: Awaited<
    ReturnType<typeof readBuilderPublicationDestinationForTool>
  >["destination"],
) => {
  if (ownedDestination !== undefined && input.destination !== undefined) {
    const selectedInstallation =
      input.destination.selectedInstallationId ?? ownedDestination.selectedInstallationId;
    if (
      input.destination.repository.toLowerCase() !== ownedDestination.repository.toLowerCase() ||
      selectedInstallation !== ownedDestination.selectedInstallationId
    ) {
      throw new Error("Publication must retain this Builder app's recorded repository.");
    }
  }
  if (input.githubSource !== undefined) {
    if (
      ownedDestination !== undefined &&
      input.githubSource.repository.repositoryId !== ownedDestination.repositoryId
    ) {
      throw new Error("The revision source differs from this Builder app's repository.");
    }
    if (
      ownedDestination !== undefined &&
      input.githubSource.repository.repositoryId !== ownedDestination.repositoryId
    ) {
      throw new Error("The revision source differs from this Builder app's repository.");
    }
    if (
      input.destination !== undefined &&
      input.destination.repository.toLowerCase() !==
        `${input.githubSource.repository.owner}/${input.githubSource.repository.name}`.toLowerCase()
    ) {
      throw new Error("The publication destination differs from the selected GitHub repository.");
    }
  }
};

const missingDestinationGuidance = (publicSessionId?: string) => {
  const blocked = {
    status: "blocked" as const,
    code: "builder_destination_required" as const,
    nextAction:
      "For a new app, choose the destination in the saved build's destination setup in hosted Builder. If the user already chose an existing repository, use that repository's normal connection flow.",
  };
  return publicSessionId === undefined
    ? blocked
    : withBuilderDestinationGuidance(blocked, publicSessionId);
};

const assertApprovedProductionSelection = (
  approved: ApprovedProductionDestination,
  selected: PublicationDestinationSelector,
) => {
  const installationId = selected.selectedInstallationId ?? approved.installationId;
  if (
    selected.repository.toLowerCase() !== approved.repositoryFullName.toLowerCase() ||
    installationId !== approved.installationId
  ) {
    throw new Error(
      "Publication must use the repository and GitHub account approved for Production.",
    );
  }
};

const assertVerifiedProductionDestination = (
  approved: ApprovedProductionDestination,
  selected: GitHubPublicationDestinationIdentity,
) => {
  if (
    `${selected.owner}/${selected.name}` !== approved.repositoryFullName ||
    selected.repositoryId !== approved.repositoryId ||
    selected.installationId !== approved.installationId ||
    selected.defaultBranch !== approved.baseBranch
  ) {
    throw new Error("The verified GitHub destination changed after Production approval.");
  }
};

export const createPublicationTargetResolver =
  <Context extends { session: { id: string } }>(ports: PublicationResolverPorts<Context>) =>
  async (input: {
    ctx: Context;
    destination?: PublicationDestinationSelector;
    githubSource?: ImmutableGitHubSourceReceipt;
    sourceKind: SourceKind;
    approvedProduction?: ApprovedProductionDestination;
    destinationReview?: GitHubDestinationReviewBinding;
    appId: string;
  }): Promise<
    | { kind: "ready"; target: PublicationTarget }
    | { kind: "missing"; guidance: ReturnType<typeof missingDestinationGuidance> }
    | { kind: "selection"; access: RepositoryAccessResult }
  > => {
    const ownedSelection = await ports.readOwnedDestination(input.ctx, input.appId);
    const ownedDestination = ownedSelection.destination;
    const { approvedProduction } = input;
    if (approvedProduction !== undefined) {
      if (input.destination !== undefined) {
        assertApprovedProductionSelection(approvedProduction, input.destination);
      }
      if (ownedDestination !== undefined) {
        assertApprovedProductionSelection(approvedProduction, ownedDestination);
      }
    }
    assertPublicationDestinationConstraints(input, ownedDestination);
    if (input.githubSource !== undefined && ownedDestination === undefined) {
      return { kind: "ready", target: { githubSource: input.githubSource } };
    }
    if (input.githubSource === undefined && input.sourceKind !== "fresh-template") {
      throw new Error(
        "Restore the selected GitHub source before preparing its destination review.",
      );
    }
    const retained =
      input.destinationReview === undefined
        ? undefined
        : publicationDestinationFromReview(input.destinationReview);
    const approvedSelector =
      approvedProduction === undefined
        ? input.destination
        : {
            repository: approvedProduction.repositoryFullName,
            selectedInstallationId: approvedProduction.installationId,
          };
    const destination =
      ownedDestination ??
      approvedSelector ??
      (retained === undefined
        ? undefined
        : {
            repository: `${retained.owner}/${retained.name}`,
            selectedInstallationId: retained.installationId,
          });
    if (destination === undefined) {
      return {
        kind: "missing",
        guidance: missingDestinationGuidance(ownedSelection.publicSessionId),
      };
    }
    const access = await ports.resolveAccess(destination, input.ctx);
    if (access.kind === "selection") {
      return { kind: "selection", access: access.access };
    }
    const selected = publicationDestinationFromAccess(access.receipt, input.ctx.session.id);
    if (approvedProduction !== undefined) {
      assertVerifiedProductionDestination(approvedProduction, selected);
    }
    if (ownedDestination !== undefined) {
      const current = await ports.readOwnedDestination(input.ctx, input.appId);
      if (
        selected.repositoryId !== ownedDestination.repositoryId ||
        selected.installationId !== ownedDestination.selectedInstallationId ||
        JSON.stringify(current) !== JSON.stringify(ownedSelection)
      ) {
        throw new Error("The saved Builder app destination changed during publication review.");
      }
    }
    await ports.persistDestination?.(
      input.ctx,
      input.appId,
      access.receipt,
      approvedProduction === undefined ? undefined : { requireExactReadback: true },
    );
    return { kind: "ready", target: { destination: selected } };
  };

// oxlint-disable-next-line eslint/complexity -- Canonical app destination checks preserve the existing fresh, revision, retained-review and access-selection branches.
export const resolvePublicationTargetForTool = createPublicationTargetResolver<ToolContext>({
  readOwnedDestination: readBuilderPublicationDestinationForTool,
  persistDestination: recordBuilderPublicationDestinationForTool,
  resolveAccess: async (destination, ctx) =>
    await resolveRepositoryAccessForTool(
      {
        repository: destination.repository,
        selectedInstallationId: destination.selectedInstallationId ?? undefined,
      },
      ctx,
      await repositoryAccessRuntimeForSession(ctx.session.auth),
    ),
});
