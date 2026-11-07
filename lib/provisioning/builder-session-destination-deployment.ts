import { z } from "zod";
import type { BuilderProvisionResponse } from "./contracts";
import type { DurableHostedSessionRecord } from "../eve/hosted-store";
import { isDeepStrictEqual } from "node:util";
import { createPostgresBuilderHandoffStore } from "../handoff/postgres-store";
import { readOwnerVercelProjectAccess } from "../agent/prepared-provider-context";
import { createBuilderPublicOriginStore } from "./builder-public-origin-store";
import { createBuilderPublicOriginService } from "./builder-public-origin-service";
import { readStandardBuilderPublicOrigins } from "./standard-builder-public-origin";
import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { builderResourceProvisioningFlag } from "../feature-flags";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { toDurableHostedSessionRecord } from "../eve/hosted-store";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { loadBuilderIntegrationState } from "../integrations/builder-integration-deployment";
import { createBuilderProvisioningDependencies } from "./deployment";
import { readActiveVercelInstallationToken } from "../integrations/postgres-vercel-installation";
import { readVercelIntegrationEnvironment } from "../integrations/vercel-installation";
import { createPostgresBuilderProvisionJournalStore } from "./postgres-journal";
import { executeBuilderProvisioning } from "./service";
import { createBuilderSessionDestinationService } from "./builder-session-destination";
import { createPostgresNativeTargetOnboardingStore } from "./native-target-onboarding-store";
import type { HostedPrincipal } from "../eve/hosted-auth";

export class BuilderSessionDestinationSignInRequiredError extends Error {
  constructor() {
    super("Sign in to continue this build.");
    this.name = "BuilderSessionDestinationSignInRequiredError";
  }
}

const originEpoch = (session: DurableHostedSessionRecord) => {
  const idle = [
    session.status === "waiting",
    (session.checkpoint?.inputRequests?.length ?? 0) === 0,
    (session.cancellationRevision ?? 0) === (session.resumedCancellationRevision ?? 0),
  ].every(Boolean);
  if (!idle) {
    throw new Error("Wait for this build to finish before choosing its public domain.");
  }
  return {
    appId: z.string().min(1).parse(session.appId),
    expected: {
      adapterGeneration: session.adapterGeneration,
      adapterSessionId: session.adapterSessionId,
      cancellationRevision: session.cancellationRevision ?? 0,
      checkpointDigest: session.checkpointDigest,
    },
  };
};
const publicOriginDestination = (appId: string, receipt: BuilderProvisionResponse | undefined) => {
  if (
    receipt === undefined ||
    receipt.appId !== appId ||
    receipt.status !== "settled" ||
    receipt.deploymentAccess !== "public-app"
  ) {
    throw new Error("This app's public destination is not ready.");
  }
  const { vercel, github } = receipt;
  if (
    vercel.status !== "succeeded" ||
    github.status !== "succeeded" ||
    vercel.scope.type !== "team"
  ) {
    throw new Error("This app's public destination is not ready.");
  }
  return {
    repositoryId: github.repositoryId,
    scope: {
      appId,
      installationId: vercel.installationId,
      projectId: vercel.projectId,
      provisioningDigest: receipt.requestDigest,
      provisioningRequestId: receipt.requestId,
      teamId: vercel.scope.id,
    },
  };
};
export const openBuilderSessionDestination = async (
  headers: Headers,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const readOwner = async () =>
    await ensurePreviewOAuthDeploymentSessionOrganization({ environment, headers });
  const owner = await readOwner();
  if (owner === null || owner === undefined) {
    throw new BuilderSessionDestinationSignInRequiredError();
  }
  const config = readPreviewOAuthRuntimeConfig(environment);
  const authority = {
    audience: config.resource,
    issuer: config.issuer,
    ownerUserId: owner.user.id,
    workspaceId: owner.organization.workspaceId,
  };
  const principal: HostedPrincipal = { ...authority, scopes: ["autograph:session"] };
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const sessions = createPostgresHostedEveStore(database);
  const journal = createPostgresBuilderProvisionJournalStore(database);
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
  const publicOrigins = createBuilderPublicOriginService({
    resolve: async (selected, sessionId) => {
      await assertMember(selected);
      const readTarget = async () => {
        await assertMember(selected);
        const stored = await sessions.getSession(selected, sessionId);
        if (stored === null) {
          throw new Error("This build is unavailable.");
        }
        const session = toDurableHostedSessionRecord(stored);
        const epoch = originEpoch(session);
        let receipt;
        if (session.sourceHandoffId === undefined) {
          const reference = session.builderDestination;
          if (reference === undefined || reference.appId !== session.appId) {
            throw new Error("Select this app's normal destination first.");
          }
          const row = await journal.read({
            authority,
            requestId: reference.requestId,
          });
          if (
            row === undefined ||
            row.state !== "settled" ||
            row.requestDigest !== reference.requestDigest
          ) {
            throw new Error("This build's destination is unavailable.");
          }
          receipt = row.record.response;
        } else {
          const handoff = await createPostgresBuilderHandoffStore(database).read({
            authority,
            handoffId: session.sourceHandoffId,
          });
          if (
            handoff === undefined ||
            handoff.sessionId !== sessionId ||
            handoff.intent.appId !== session.appId
          ) {
            throw new Error("This build's destination is unavailable.");
          }
          receipt = handoff.intent.provisioning;
        }
        return { ...publicOriginDestination(epoch.appId, receipt), expected: epoch.expected };
      };
      const target = await readTarget();
      const assertCurrent = async () => {
        if (!isDeepStrictEqual(await readTarget(), target)) {
          throw new Error("This build's destination changed. Refresh before choosing a domain.");
        }
      };
      const readCredential = (input: { installationId: string }) =>
        readActiveVercelInstallationToken({
          authority,
          config: readVercelIntegrationEnvironment(environment),
          database,
          installationId: input.installationId,
        });
      return {
        assertCurrent,
        expected: target.expected,
        readOrigins: async () => {
          await assertCurrent();
          const access = await readOwnerVercelProjectAccess({
            authority,
            installationId: target.scope.installationId,
            projectId: target.scope.projectId,
            readCredential,
            requireExpectedRepositoryId: target.repositoryId,
            requirePublicAppConfiguration: true,
            requireServicesRoot: true,
          });
          if (
            access.status !== "ready" ||
            access.scope.type !== "team" ||
            access.scope.id !== target.scope.teamId ||
            access.project?.id !== target.scope.projectId
          ) {
            throw new Error("This app's current project is unavailable.");
          }
          return await readStandardBuilderPublicOrigins({
            assertCurrent,
            destination: target.scope,
            readCredential: async () =>
              await readCredential({
                installationId: target.scope.installationId,
              }),
          });
        },
        scope: target.scope,
      };
    },
    store: createBuilderPublicOriginStore(database),
  });
  return {
    authority,
    dependencies,
    principal,
    publicOrigins,
    readPage: async (sessionId: string) => {
      const stored = await sessions.getSession(principal, sessionId);
      if (stored === null) {
        throw new Error("This build is unavailable.");
      }
      const session = toDurableHostedSessionRecord(stored);
      if (session.appId === undefined) {
        throw new Error("Choose an app before selecting its destination.");
      }
      let reference = session.builderDestination;
      if (reference === undefined && session.sourceHandoffId !== undefined) {
        const handoff = await createPostgresBuilderHandoffStore(database).read({
          authority,
          handoffId: session.sourceHandoffId,
        });
        const receipt = handoff?.intent.provisioning;
        if (handoff?.sessionId !== sessionId || receipt?.appId !== session.appId) {
          throw new Error("This build's saved destination is unavailable.");
        }
        reference = {
          appId: receipt.appId,
          requestDigest: receipt.requestDigest,
          requestId: receipt.requestId,
        };
      }
      const row =
        reference === undefined
          ? undefined
          : await journal.read({ authority, requestId: reference.requestId });
      if (reference !== undefined && row?.requestDigest !== reference.requestDigest) {
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
        appId: session.appId,
        enabled: await builderResourceProvisioningFlag(),
        expected: {
          adapterGeneration: session.adapterGeneration,
          adapterSessionId: session.adapterSessionId,
          cancellationRevision: session.cancellationRevision ?? 0,
          checkpointDigest: session.checkpointDigest,
        },
        github: integrations.github.scopes,
        ready: row?.record.response.vercel.status === "succeeded",
        request: row?.record.request,
        selectable: session.status === "waiting" && session.sourceHandoffId === undefined,
        sessionId,
        title: session.title,
        vercel: integrations.vercel.scopes,
      };
    },
    service: {
      select: (
        input: Parameters<ReturnType<typeof createBuilderSessionDestinationService>["select"]>[0],
      ) =>
        createBuilderSessionDestinationService({
          sessions,
          provisioning: createBuilderProvisioningDependencies(environment).dependencies,
          execute: executeBuilderProvisioning,
          assertMember,
          readNativeTarget: createPostgresNativeTargetOnboardingStore(database).read,
        }).select(input),
    },
    sessions,
  };
};
