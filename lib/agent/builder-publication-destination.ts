import { isDeepStrictEqual } from "node:util";
import type { ToolContext } from "eve/tools";
import type {
  BuilderProvisionJournalStore,
  BuilderProvisionAuthority,
} from "../provisioning/journal";
import type { BuilderSessionDestination } from "../provisioning/builder-session-destination-contract";
import type { PublicationDestinationSelector } from "./github-publication-destination";

type OwnedDestination = PublicationDestinationSelector & { repositoryId: string };
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
  async (): Promise<OwnedDestination | undefined> => {
    const selected = await deps.readSelection();
    const ref = selected.destination;
    if (ref === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional destination is an explicit result of this typed async reader.
      return undefined;
    }
    const row = await deps.readProvisioning({
      authority: selected.authority,
      requestId: ref.requestId,
    });
    const retainedReceipt = JSON.stringify(row);
    const response = row?.record.response;
    const matches = [
      ref.appId === selected.appId,
      row?.state === "settled",
      row?.requestDigest === ref.requestDigest,
      response?.appId === selected.appId,
    ].every(Boolean);
    if (
      !matches ||
      response?.github.status !== "succeeded" ||
      response.vercel.status !== "succeeded"
    ) {
      throw new Error("The saved Builder app destination is unavailable for publication.");
    }
    if (response.github.fullName !== response.vercel.linkedGitHubRepository) {
      throw new Error("The saved Builder app destination is unavailable for publication.");
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
    { toDurableHostedSessionRecord },
    { createPostgresBuilderProvisionJournalStore },
  ] = await Promise.all([
    import("../hosted/session-authority"),
    import("../provisioning/hosted-operator-owner-context"),
    import("../auth/preview-oauth-runtime"),
    import("../mcp/hosted-route"),
    import("../eve/postgres-hosted-store"),
    import("../eve/hosted-store"),
    import("../provisioning/postgres-journal"),
  ]);
  const { authority, principal } = exactForwardedSessionAuthority(ctx.session.auth);
  const config = readPreviewOAuthRuntimeConfig(process.env);
  if (authority.issuer !== config.issuer || authority.audience !== config.resource) {
    throw new Error("The saved Builder app destination is unavailable for publication.");
  }
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const sessions = createPostgresHostedEveStore(database);
  return await createBuilderPublicationDestinationReader({
    readProvisioning: createPostgresBuilderProvisionJournalStore(database).read,
    readSelection: async () => {
      const owner = await resolveHostedOperatorOwnerContext({
        adapterSessionId: ctx.session.id,
        authority,
        principal,
        sessionAuth: ctx.session.auth,
        environment: process.env,
      });
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Owner verification must precede reading canonical private app metadata.
      const stored = await sessions.getSessionByAdapterSessionId?.(principal, ctx.session.id);
      if (stored === null || stored === undefined) {
        throw new Error("The saved Builder app is unavailable.");
      }
      const session = toDurableHostedSessionRecord(stored);
      if (session.appId !== appId) {
        throw new Error("The saved Builder app identity changed.");
      }
      return { authority, appId, owner, destination: session.builderDestination };
    },
  })();
};
