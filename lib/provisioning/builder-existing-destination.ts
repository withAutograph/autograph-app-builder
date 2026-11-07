import type { toDurableHostedSessionRecord } from "../eve/hosted-store";
import type { BuilderProvisionAuthority, BuilderProvisionJournalStore } from "./journal";
import { HostedOperatorError } from "./hosted-operator-contract";

const sameAuthority = (left: BuilderProvisionAuthority, right: BuilderProvisionAuthority) =>
  left.issuer === right.issuer &&
  left.audience === right.audience &&
  left.workspaceId === right.workspaceId &&
  left.ownerUserId === right.ownerUserId;

/** Called only after authenticating the canonical session; never adopts a name or caller-supplied project reference. */
export const resolveExistingBuilderDestinationReference = async (input: {
  session: ReturnType<typeof toDurableHostedSessionRecord>;
  authority: BuilderProvisionAuthority;
  appId: string;
  findProvisioningForAppRepository?: BuilderProvisionJournalStore["findSettledAppRepository"];
}) => {
  const { session } = input;
  if (!sameAuthority(session.principal, input.authority) || session.appId !== input.appId) {
    throw new HostedOperatorError("authorization_required");
  }
  if (session.builderDestination !== undefined) {
    if (session.builderDestination.appId !== input.appId) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return session.builderDestination;
  }
  const source = session.privateBuildDecision?.existingRepositorySource;
  if (source === undefined) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence leaves ordinary new-app creation available.
    return undefined;
  }
  if (
    ![session.adapterSessionId, session.originAdapterSessionId].includes(source.sessionId) ||
    input.findProvisioningForAppRepository === undefined
  ) {
    throw new HostedOperatorError("builder_destination_configuration_required");
  }
  const rows = await input.findProvisioningForAppRepository({
    appId: input.appId,
    authority: input.authority,
    githubInstallationId: source.scope.installationId,
    repositoryId: source.repository.repositoryId,
  });
  const row = rows.length === 1 ? rows[0] : undefined;
  const github = row?.record.response.github;
  const project = row?.record.response.vercel;
  if (row === undefined || github?.status !== "succeeded" || project?.status !== "succeeded") {
    throw new HostedOperatorError("builder_destination_configuration_required");
  }
  const same = [
    row.record.response.status === "settled",
    row.record.response.status === "settled",
    row.state === "settled",
    sameAuthority(row.authority, input.authority),
    row.record.response.appId === input.appId,
    row.record.response.requestId === row.requestId,
    row.record.response.requestDigest === row.requestDigest,
    github.repositoryId === source.repository.repositoryId,
    github.installationId === source.scope.installationId,
    project.linkedGitHubRepository === github.fullName,
  ].every(Boolean);
  if (!same) {
    throw new HostedOperatorError("builder_destination_configuration_required");
  }
  return { appId: input.appId, requestDigest: row.requestDigest, requestId: row.requestId };
};
