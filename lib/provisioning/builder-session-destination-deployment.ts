import { resolveExistingBuilderDestinationReference } from "./builder-existing-destination";
import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { builderResourceProvisioningFlag } from "../feature-flags";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { toDurableHostedSessionRecord } from "../eve/hosted-store";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { loadBuilderIntegrationState } from "../integrations/builder-integration-deployment";
import { createBuilderProvisioningDependencies } from "./deployment";
import { executeBuilderProvisioning } from "./service";
import { createBuilderSessionDestinationService } from "./builder-session-destination";
import { createPostgresNativeTargetOnboardingStore } from "./native-target-onboarding-store";
import type { HostedPrincipal } from "../eve/hosted-auth";

export const openBuilderSessionDestination = async (
  headers: Headers,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const readOwner = () => ensurePreviewOAuthDeploymentSessionOrganization({ headers, environment });
  const owner = await readOwner();
  if (owner === null || owner === undefined) {
    throw new Error("Sign in to continue this build.");
  }
  const config = readPreviewOAuthRuntimeConfig(environment);
  const authority = {
    issuer: config.issuer,
    audience: config.resource,
    ownerUserId: owner.user.id,
    workspaceId: owner.organization.workspaceId,
  };
  const principal: HostedPrincipal = { ...authority, scopes: ["autograph:session"] };
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const sessions = createPostgresHostedEveStore(database);
  const { dependencies } = createBuilderProvisioningDependencies(environment);
  const assertMember = async (selected: HostedPrincipal) => {
    const current = await readOwner();
    if (
      current?.user.id !== selected.ownerUserId ||
      current.organization.workspaceId !== selected.workspaceId ||
      selected.issuer !== authority.issuer ||
      selected.audience !== authority.audience
    ) {
      throw new Error("Sign in to continue this build.");
    }
  };
  return {
    principal,
    authority,
    sessions,
    dependencies,
    service: createBuilderSessionDestinationService({
      sessions,
      provisioning: dependencies,
      execute: executeBuilderProvisioning,
      assertMember,
      readNativeTarget: createPostgresNativeTargetOnboardingStore(database).read,
    }),
    readPage: async (sessionId: string) => {
      const stored = await sessions.getSession(principal, sessionId);
      if (stored === null) {
        throw new Error("This build is unavailable.");
      }
      const original = toDurableHostedSessionRecord(stored);
      const session =
        sessions.readCurrentBuildSession === undefined
          ? original
          : await sessions.readCurrentBuildSession({
              principal,
              authoritySessionId:
                original.nativeRecoveryBinding?.originalAuthoritySessionId ?? original.sessionId,
              logicalSessionId:
                original.nativeRecoveryBinding?.logicalSessionId ?? original.adapterSessionId,
            });
      if (session.appId === undefined) {
        throw new Error("Choose an app before selecting its destination.");
      }
      const reference = await resolveExistingBuilderDestinationReference({
        session,
        authority,
        appId: session.appId,
        findProvisioningForAppRepository: dependencies.journal.findSettledAppRepository,
      });
      await assertMember(principal);
      const row =
        reference === undefined
          ? undefined
          : await dependencies.journal.read({ authority, requestId: reference.requestId });
      if (
        reference !== undefined &&
        [
          reference.appId !== session.appId,
          row?.requestDigest !== reference.requestDigest,
          row?.record.response.appId !== session.appId,
        ].some(Boolean)
      ) {
        throw new Error("This build's saved destination is unavailable.");
      }
      const integrations = await loadBuilderIntegrationState({
        authenticated: true,
        environment,
        organizationId: owner.organization.organizationId,
        userId: owner.user.id,
        workspaceId: owner.organization.workspaceId,
      });
      return {
        sessionId: session.sessionId,
        appId: session.appId,
        title: session.title,
        expected: {
          adapterSessionId: session.adapterSessionId,
          adapterGeneration: session.adapterGeneration,
          cancellationRevision: session.cancellationRevision ?? 0,
          checkpointDigest: session.checkpointDigest,
        },
        request: row?.record.request,
        ready: row?.state === "settled" && row.record.response.vercel.status === "succeeded",
        selectable:
          session.status === "waiting" &&
          session.sourceHandoffId === undefined &&
          session.privateBuildDecision?.existingRepositorySource === undefined,
        enabled: await builderResourceProvisioningFlag(),
        github: integrations.github.scopes,
        vercel: integrations.vercel.scopes,
      };
    },
  };
};
