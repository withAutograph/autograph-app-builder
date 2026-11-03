import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createPublicReleaseDispatcher } from "./public-release-dispatcher";
import type { PublicReleaseRequestAuthority } from "./public-release-dispatcher";
import type { HostedOperatorAppOwnerContext } from "./hosted-operator-owner";
import { createPostgresOperatorArtifactSelections } from "./hosted-operator-artifact-selection";
import { createPostgresOperatorArtifactStore } from "./hosted-operator-artifact-store";
import { createOperatorArtifactPublication } from "./hosted-operator-artifacts";
import { readPublicReleasePreparedRuntime } from "./public-release-readiness";
import { PublicReleasePrerequisiteError } from "./public-release-prerequisite";

/** Native composition inspects actual canonical state before offering any changed-target approval. */
export const createPublicReleaseDeployment = (input: {
  database: ReturnType<typeof openHostedPostgresDatabase>;
  owner: PublicReleaseRequestAuthority & {
    readStandardDestination: (context: HostedOperatorAppOwnerContext) => Promise<
      | {
          projectId: string;
          teamId: string;
          installationId: string;
          provisioningRequestId: string;
          provisioningDigest: string;
          deploymentAccess?: "public-app";
        }
      | undefined
    >;
  };
}) =>
  createPublicReleaseDispatcher({
    owner: input.owner,
    createPorts: async ({ input: request, assertCurrentOwner }) => {
      const appId =
        request.action === "public-release-plan"
          ? request.appId
          : request.input.plan.selection.appId;
      const owner = request.ownerContext;
      const context = {
        authority: owner.authority,
        ownerContext: owner,
        target: { appId, sessionId: owner.sessionId },
      };
      const destination = await input.owner.readStandardDestination(context);
      await assertCurrentOwner();
      if (destination === undefined || destination.deploymentAccess !== "public-app") {
        throw new PublicReleasePrerequisiteError("builder_destination_required");
      }
      const { operator } = await readPublicReleasePreparedRuntime({
        database: input.database,
        owner,
        appId,
        projectId: destination.projectId,
        assertCurrentOwner,
      });
      const selections = createPostgresOperatorArtifactSelections({
        database: input.database,
        assertCurrentOwner,
      });
      const selection = await selections.readExact?.(context, {
        artifactRef: operator.plan.release.artifactRef,
      });
      await assertCurrentOwner();
      if (
        selection === undefined ||
        selection.publishedSource === undefined ||
        selection.manifestSha256 !== operator.plan.release.sha256 ||
        selection.releaseId !== operator.plan.release.id
      ) {
        throw new PublicReleasePrerequisiteError("public_release_source_required");
      }
      const publication = createOperatorArtifactPublication({
        store: createPostgresOperatorArtifactStore({
          database: input.database,
          assertCurrentOwner,
        }),
        assertCurrentOwner,
      });
      const captured = await publication.readGeneratedRelease(context, selection);
      await assertCurrentOwner();
      if (captured.description?.backend.kind !== "generated-postgres") {
        throw new PublicReleasePrerequisiteError("public_release_source_required");
      }
      // Legacy prepared records prove isolated Preview work only. Their existing shared Auth
      // seed and frozen boundary cannot authorize a new public same-project Auth installation.
      throw new PublicReleasePrerequisiteError("same_project_auth_required");
    },
  });
