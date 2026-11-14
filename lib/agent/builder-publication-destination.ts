import {
  existingRepositoryDestinationSchema,
  isExistingRepositoryDestination,
} from "../provisioning/builder-session-destination-contract";
import type { RepositoryAccessReceipt } from "./repository-access-state";
/* oxlint-disable sonarjs/expression-complexity -- Destination authority requires all exact recorded repository, installation and provider project comparisons. */
import { isDeepStrictEqual } from "node:util";
import { resolveExistingBuilderDestinationReference } from "../provisioning/builder-existing-destination";
import type { ToolContext } from "eve/tools";
import {
  hostedOperatorCallbackExecution,
  readHostedOperatorCallbackSessions,
} from "../provisioning/hosted-operator-callback-owner";
import type {
  BuilderProvisionJournalStore,
  BuilderProvisionAuthority,
} from "../provisioning/journal";
import type {
  BuilderSessionDestination,
  ExistingRepositoryDestination,
} from "../provisioning/builder-session-destination-contract";
import type { PublicationDestinationSelector } from "./github-publication-destination";

const DESTINATION_UNAVAILABLE = "The saved Builder app destination is unavailable for publication.";

type OwnedDestination = PublicationDestinationSelector & { repositoryId: string };
interface Selection {
  authority: BuilderProvisionAuthority;
  appId: string;
  publicSessionId: string;
  destination?: BuilderSessionDestination;
  /** Exact current private owner context, including recovery/cancellation generation. */
  owner: object;
}
export const createBuilderPublicationDestinationReader =
  (deps: {
    readSelection: () => Promise<Selection>;
    readProvisioning: BuilderProvisionJournalStore["read"];
  }) =>
  async () => {
    const selected = await deps.readSelection();
    const ref = selected.destination;
    if (ref === undefined) {
      return { publicSessionId: selected.publicSessionId };
    }
    if (isExistingRepositoryDestination(ref)) {
      if (
        ref.appId !== selected.appId ||
        !isDeepStrictEqual(await deps.readSelection(), selected)
      ) {
        throw new Error(DESTINATION_UNAVAILABLE);
      }
      return {
        publicSessionId: selected.publicSessionId,
        destination: {
          repository: `${ref.repository.owner}/${ref.repository.name}`,
          repositoryId: ref.repository.repositoryId,
          selectedInstallationId: ref.installationId,
        } satisfies OwnedDestination,
      };
    }
    const row = await deps.readProvisioning({
      authority: selected.authority,
      requestId: ref.requestId,
    });
    const retainedReceipt = JSON.stringify(row);
    const response = row?.record.response;
    if (
      ref.appId !== selected.appId ||
      row?.state !== "settled" ||
      row.requestDigest !== ref.requestDigest ||
      response?.appId !== selected.appId ||
      response.github.status !== "succeeded" ||
      response.vercel.status !== "succeeded" ||
      response.github.fullName !== response.vercel.linkedGitHubRepository
    ) {
      throw new Error(DESTINATION_UNAVAILABLE);
    }
    if (response.github.fullName !== response.vercel.linkedGitHubRepository) {
      throw new Error(DESTINATION_UNAVAILABLE);
    }
    const current = await deps.readSelection();
    const latest = await deps.readProvisioning({
      authority: current.authority,
      requestId: ref.requestId,
    });
    if (!isDeepStrictEqual(selected, current) || JSON.stringify(latest) !== retainedReceipt) {
      throw new Error("The saved Builder app destination changed during publication review.");
    }
    return {
      publicSessionId: selected.publicSessionId,
      destination: {
        repository: response.github.fullName,
        repositoryId: response.github.repositoryId,
        selectedInstallationId: response.github.installationId,
      } satisfies OwnedDestination,
    };
  };

/** Resolve private canonical metadata, never an ambient template repository or model-selected owner. */
export const readBuilderPublicationDestinationForTool = async (
  ctx: ToolContext,
  appId: string,
): Promise<{ publicSessionId?: string; destination?: OwnedDestination }> => {
  if (process.env.EVE_HOSTED_ADAPTER !== "1") {
    return {};
  }
  const [
    { exactForwardedSessionAuthority },
    { resolveHostedOperatorOwnerContext },
    { readPreviewOAuthRuntimeConfig },
    { openHostedPostgresDatabase },
    { createPostgresHostedEveStore },
    { createPostgresBuilderProvisionJournalStore },
  ] = await Promise.all([
    import("../hosted/session-authority"),
    import("../provisioning/hosted-operator-owner-context"),
    import("../auth/preview-oauth-runtime"),
    import("../mcp/hosted-route"),
    import("../eve/postgres-hosted-store"),
    import("../provisioning/postgres-journal"),
  ]);
  const execution = hostedOperatorCallbackExecution(ctx.session);
  const { authority, principal } = exactForwardedSessionAuthority(ctx.session.auth, {
    realmContinuation: { adapterSessionId: execution.ownerAnchorRunId ?? ctx.session.id },
  });
  const config = readPreviewOAuthRuntimeConfig(process.env);
  if (authority.issuer !== config.issuer || authority.audience !== config.resource) {
    throw new Error(DESTINATION_UNAVAILABLE);
  }
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const sessions = createPostgresHostedEveStore(database);
  const provisioning = createPostgresBuilderProvisionJournalStore(database);
  return await createBuilderPublicationDestinationReader({
    readProvisioning: provisioning.read,
    readSelection: async () => {
      const owner = await resolveHostedOperatorOwnerContext({
        adapterSessionId: ctx.session.id,
        authority,
        principal,
        sessionAuth: ctx.session.auth,
        environment: process.env,
        execution,
      });
      const { currentSession: session } = await readHostedOperatorCallbackSessions({
        store: sessions,
        owner,
        execution,
      });
      if (session.appId !== appId) {
        throw new Error("The saved Builder app identity changed.");
      }
      const destination = await resolveExistingBuilderDestinationReference({
        session,
        authority,
        appId,
        findProvisioningForAppRepository: provisioning.findSettledAppRepository,
      });
      return { authority, appId, owner, destination, publicSessionId: session.sessionId };
    },
  })();
};

const assertExactExistingDestination = (
  saved: BuilderSessionDestination | undefined,
  destination: ExistingRepositoryDestination,
): void => {
  if (
    saved === undefined ||
    !isExistingRepositoryDestination(saved) ||
    saved.appId !== destination.appId ||
    saved.installationId !== destination.installationId ||
    !isDeepStrictEqual(saved.repository, destination.repository)
  ) {
    throw new Error("The saved Builder app destination differs from the verified repository.");
  }
};

/** Reuse an already verified selection without entering the destination mutation flow. */
export const confirmBuilderPublicationDestination = async (input: {
  saved?: BuilderSessionDestination | undefined;
  destination: ExistingRepositoryDestination;
  attach: () => Promise<void>;
  readSaved: () => Promise<BuilderSessionDestination | undefined>;
  requireExactReadback?: boolean | undefined;
}): Promise<void> => {
  const { saved, destination } = input;
  if (saved !== undefined) {
    if (isExistingRepositoryDestination(saved)) {
      assertExactExistingDestination(saved, destination);
    } else if (input.requireExactReadback === true) {
      throw new Error(DESTINATION_UNAVAILABLE);
    }
    return;
  }
  await input.attach();
  const stored = await input.readSaved();
  if (input.requireExactReadback === true) {
    assertExactExistingDestination(stored, destination);
  }
};

/** Metadata-only persistence after the normal GitHub access flow; grants no publication approval. */
export const recordBuilderPublicationDestinationForTool = async (
  ctx: ToolContext,
  appId: string,
  receipt: RepositoryAccessReceipt,
  options?: { requireExactReadback: boolean },
): Promise<void> => {
  if (process.env.EVE_HOSTED_ADAPTER !== "1") {
    return;
  }
  if (receipt.sessionId !== ctx.session.id) {
    throw new Error(DESTINATION_UNAVAILABLE);
  }
  const [
    { exactForwardedSessionAuthority },
    { resolveHostedOperatorOwnerContext },
    { readPreviewOAuthRuntimeConfig },
    { openHostedPostgresDatabase },
    { createPostgresHostedEveStore },
  ] = await Promise.all([
    import("../hosted/session-authority"),
    import("../provisioning/hosted-operator-owner-context"),
    import("../auth/preview-oauth-runtime"),
    import("../mcp/hosted-route"),
    import("../eve/postgres-hosted-store"),
  ]);
  const execution = hostedOperatorCallbackExecution(ctx.session);
  const { authority, principal } = exactForwardedSessionAuthority(ctx.session.auth, {
    realmContinuation: { adapterSessionId: execution.ownerAnchorRunId ?? ctx.session.id },
  });
  const config = readPreviewOAuthRuntimeConfig(process.env);
  if (authority.issuer !== config.issuer || authority.audience !== config.resource) {
    throw new Error(DESTINATION_UNAVAILABLE);
  }
  const sessions = createPostgresHostedEveStore(openHostedPostgresDatabase(config.databaseUrl));
  const owner = await resolveHostedOperatorOwnerContext({
    adapterSessionId: ctx.session.id,
    authority,
    principal,
    sessionAuth: ctx.session.auth,
    environment: process.env,
    execution,
  });
  const { currentSession: session } = await readHostedOperatorCallbackSessions({
    store: sessions,
    owner,
    execution,
  });
  if (session.appId !== appId) {
    throw new Error(DESTINATION_UNAVAILABLE);
  }
  const { repository } = receipt;
  const destination = existingRepositoryDestinationSchema.parse({
    kind: "existing-repository",
    version: 1,
    appId,
    repository: {
      repositoryId: repository.repositoryId,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.defaultBranch,
    },
    installationId: receipt.scope.installationId,
    confirmedByCallId: receipt.confirmedByCallId,
  });
  await confirmBuilderPublicationDestination({
    saved: session.builderDestination,
    destination,
    requireExactReadback: options?.requireExactReadback,
    attach: async () => {
      if (sessions.attachBuilderDestination === undefined) {
        throw new Error(DESTINATION_UNAVAILABLE);
      }
      await sessions.attachBuilderDestination({
        principal: owner.principal,
        sessionId: session.sessionId,
        destination,
        activeBuild: true,
        activeBuildTurn: ctx.session.turn,
        expected: {
          adapterSessionId: session.adapterSessionId,
          adapterGeneration: session.adapterGeneration,
          cancellationRevision: session.cancellationRevision ?? 0,
          checkpointDigest: session.checkpointDigest,
        },
        nowEpochMs: Date.now(),
      });
    },
    readSaved: async () => {
      const { currentSession } = await readHostedOperatorCallbackSessions({
        store: sessions,
        owner,
        execution,
      });
      return currentSession.builderDestination;
    },
  });
};
