import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import { BuilderHandoffUnavailableError } from "../handoff/service";
import {
  exactForwardedSessionAuthority,
  sourceHandoffIdForSessionAuth,
} from "../hosted/session-authority";
import type { HostedSessionTenantAuthority } from "../hosted/session-authority";

export function createPreparedHandoffReader(input: {
  read: BuilderHandoffStore["read"];
  isActiveMember(authority: HostedSessionTenantAuthority): Promise<boolean>;
}) {
  return async (sessionAuth: unknown) => {
    const handoffId = sourceHandoffIdForSessionAuth(sessionAuth);
    if (handoffId === undefined) {
      return undefined;
    }
    const { authority } = exactForwardedSessionAuthority(sessionAuth);
    if (!(await input.isActiveMember(authority))) {
      throw new BuilderHandoffUnavailableError();
    }
    const stored = await input.read({ authority, handoffId });
    if (!stored) {
      throw new BuilderHandoffUnavailableError();
    }
    const record = builderHandoffRecordSchema.parse(stored);
    if (
      record.handoffId !== handoffId ||
      Object.entries(authority).some(
        ([key, value]) =>
          record.authority[key as keyof HostedSessionTenantAuthority] !== value
      )
    ) {
      throw new BuilderHandoffUnavailableError();
    }
    // Initial redemption checks expiry. A trusted session retains its prepared
    // context afterwards, including when its engine is restarted or recovered.
    return record.intent;
  };
}

async function createDeploymentPreparedHandoffReader() {
  const [
    { readPreviewOAuthRuntimeConfig },
    { openHostedPostgresDatabase },
    { createPostgresBuilderHandoffStore },
    { createPostgresPreviewOrganizationAuthority },
  ] = await Promise.all([
    import("../auth/preview-oauth-runtime"),
    import("../mcp/hosted-route"),
    import("../handoff/postgres-store"),
    import("../auth/postgres-organization-user-authority"),
  ]);
  const config = readPreviewOAuthRuntimeConfig(process.env);
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const membership = createPostgresPreviewOrganizationAuthority(database, {
    audience: config.resource,
    issuer: config.issuer,
  });
  const read = createPreparedHandoffReader({
    isActiveMember: (value) => membership.isActiveMember(value),
    read: createPostgresBuilderHandoffStore(database).read,
  });
  return async (sessionAuth: unknown) => {
    const { authority } = exactForwardedSessionAuthority(sessionAuth);
    if (
      authority.issuer !== config.issuer ||
      authority.audience !== config.resource
    ) {
      throw new BuilderHandoffUnavailableError();
    }
    return read(sessionAuth);
  };
}

// Cache only principal-free infrastructure. Membership, owner-bound context,
// and provider credentials are always resolved anew for each invocation.
let deploymentReader:
  | ReturnType<typeof createDeploymentPreparedHandoffReader>
  | undefined;

export async function readPreparedHandoffContext(sessionAuth: unknown) {
  if (sourceHandoffIdForSessionAuth(sessionAuth) === undefined) {
    return undefined;
  }
  deploymentReader ??= createDeploymentPreparedHandoffReader().catch(
    (error: unknown) => {
      deploymentReader = undefined;
      throw error;
    }
  );
  return (await deploymentReader)(sessionAuth);
}
