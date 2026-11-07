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
import type { BuilderSessionDestination } from "../provisioning/builder-session-destination-contract";
import type { PublicationDestinationSelector } from "./github-publication-destination";

type OwnedDestination = PublicationDestinationSelector & { repositoryId: string };
const UNAVAILABLE_DESTINATION = "The saved Builder app destination is unavailable for publication.";
interface Selection {
  authority: BuilderProvisionAuthority;
  appId: string;
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
      return undefined;
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
      throw new Error(UNAVAILABLE_DESTINATION);
    }
    if (response.github.fullName !== response.vercel.linkedGitHubRepository) {
      throw new Error(UNAVAILABLE_DESTINATION);
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
      repository: response.github.fullName,
      repositoryId: response.github.repositoryId,
      selectedInstallationId: response.github.installationId,
    } satisfies PublicationDestinationSelector & { repositoryId: string };
  };

/** Resolve private canonical metadata, never an ambient template repository or model-selected owner. */
export const readBuilderPublicationDestinationForTool = async (
  ctx: ToolContext,
  appId: string,
): Promise<OwnedDestination | undefined> => {
  if (process.env.EVE_HOSTED_ADAPTER !== "1") {
    return undefined;
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
    throw new Error(UNAVAILABLE_DESTINATION);
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
        environment: process.env,
        execution,
        principal,
        sessionAuth: ctx.session.auth,
      });
      const { currentSession: session } = await readHostedOperatorCallbackSessions({
        execution,
        owner,
        store: sessions,
      });
      if (session.appId !== appId) {
        throw new Error("The saved Builder app identity changed.");
      }
      const destination = await resolveExistingBuilderDestinationReference({
        appId,
        authority,
        findProvisioningForAppRepository: provisioning.findSettledAppRepository,
        session,
      });
      return { appId, authority, destination, owner };
    },
  })();
};
