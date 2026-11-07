import { createPostgresBuilderProvisionJournalStore } from "./postgres-journal";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import { readPublicReleasePreparedRuntime } from "./public-release-readiness";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { HostedOperatorAppOwnerContext } from "./hosted-operator-owner";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";

export interface OwnedBuilderDestination {
  projectId: string;
  teamId: string;
  installationId: string;
  provisioningRequestId: string;
  provisioningDigest: string;
  deploymentAccess?: "public-app";
  repositoryId?: string;
  githubInstallationId?: string;
  productionBranch?: string;
}
export type ReadOwnedBuilderDestination = (
  context: HostedOperatorAppOwnerContext,
) => Promise<OwnedBuilderDestination | undefined>;

/** Shared read-only custody resolution. It creates no resource or delivery and never elects a history row. */
// oxlint-disable-next-line eslint/complexity -- Normal destination, exact captured source and approved runtime custody are independently checked in order.
export const readOwnedBuilderRuntime = async (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  readStandardDestination: ReadOwnedBuilderDestination;
  configuration?: HostedOperatorSourceConfiguration;
  owner: OperatorOwnerContext;
  appId: string;
  assertCurrentOwner: () => Promise<void>;
}) => {
  const { appId, assertCurrentOwner } = input;
  const context = {
    authority: input.owner.authority,
    ownerContext: input.owner,
    target: { appId, sessionId: input.owner.sessionId },
  };
  const destination = await input.readStandardDestination(context);
  await assertCurrentOwner();
  if (destination === undefined || destination.deploymentAccess !== "public-app") {
    throw new PublicReleasePrerequisiteError("builder_destination_required");
  }
  const provisioning = await createPostgresBuilderProvisionJournalStore(input.database).read({
    authority: input.owner.authority,
    requestId: destination.provisioningRequestId,
  });
  await assertCurrentOwner();
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Every accepted normal provisioning receipt field must agree with independent destination ownership.
    provisioning === undefined ||
    provisioning.state !== "settled" ||
    provisioning.requestDigest !== destination.provisioningDigest ||
    provisioning.record.response.appId !== appId ||
    provisioning.record.response.github.status !== "succeeded" ||
    provisioning.record.response.github.repositoryId !== destination.repositoryId ||
    !provisioning.record.operations.github.attempted ||
    !provisioning.record.operations.github.absentCandidates.includes(
      provisioning.record.response.github.name,
    ) ||
    !provisioning.record.operations.github.candidates.includes(
      provisioning.record.response.github.name,
    )
  ) {
    throw new PublicReleasePrerequisiteError("public_release_source_required");
  }
  const recordedBuilderDestination = {
    appId,
    projectId: destination.projectId,
    repositoryFullName: provisioning.record.response.github.fullName,
    repositoryId: provisioning.record.response.github.repositoryId,
  };
  const marker = input.configuration?.standardRuntime;
  if (marker === undefined) {
    throw new PublicReleasePrerequisiteError("same_project_auth_required");
  }
  const selections = createPostgresOperatorArtifactSelections({
    assertCurrentOwner,
    database: input.database,
  });
  const selection = await selections.read(context, marker.appSpecDigest);
  await assertCurrentOwner();
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- The selected artifact must match this exact canonical accepted app/spec/release.
    selection === undefined ||
    selection.appId !== appId ||
    selection.appSpecDigest !== marker.appSpecDigest ||
    selection.releaseId !== marker.capturedReleaseId ||
    selection.publishedSource === undefined
  ) {
    throw new PublicReleasePrerequisiteError(
      "public_release_source_required",
      recordedBuilderDestination,
    );
  }
  const prepared = await readPublicReleasePreparedRuntime({
    assertCurrentOwner,
    database: input.database,
    owner: input.owner,
    release: {
      artifactRef: selection.artifactRef,
      id: selection.releaseId,
      sha256: selection.manifestSha256,
    },
    target: {
      appId,
      branch: selection.publishedSource.branch,
      environment: "preview",
      installationId: destination.installationId,
      projectId: destination.projectId,
      scopeId: destination.teamId,
      scopeType: "team",
      sessionId: input.owner.sessionId,
    },
  });
  const publication = createOperatorArtifactPublication({
    assertCurrentOwner,
    store: createPostgresOperatorArtifactStore({
      assertCurrentOwner,
      database: input.database,
    }),
  });
  const captured = await publication.readGeneratedRelease(context, selection);
  await assertCurrentOwner();
  if (captured.description?.backend.kind !== "generated-postgres") {
    throw new PublicReleasePrerequisiteError(
      "public_release_source_required",
      recordedBuilderDestination,
    );
  }
  return {
    destination,
    recordedBuilderDestination,
    ...prepared,
    selection,
    captured,
    description: captured.description,
  };
};
