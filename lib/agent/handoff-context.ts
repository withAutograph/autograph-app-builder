import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import { BuilderHandoffUnavailableError } from "../handoff/service";
import {
  exactForwardedSessionAuthority,
  sourceHandoffIdForSessionAuth,
} from "../hosted/session-authority";
import type { HostedSessionTenantAuthority } from "../hosted/session-authority";
import { z } from "zod";

const preparedHandoffSessionAuthSchema = z.strictObject({
  current: z.unknown(),
  initiator: z.unknown(),
});
type PreparedHandoffSessionAuth = z.infer<typeof preparedHandoffSessionAuthSchema>;
type SessionAuth = Parameters<typeof exactForwardedSessionAuthority>[0];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPreparedHandoffReader(input: {
  read: BuilderHandoffStore["read"];
  isActiveMember: (authority: HostedSessionTenantAuthority) => Promise<boolean>;
}) {
  return async (sessionAuth: PreparedHandoffSessionAuth) => {
    const handoffId = sourceHandoffIdForSessionAuth(sessionAuth);
    if (handoffId === undefined) {
      return null;
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
      Object.entries(authority).some(([key, value]) =>
        Object.entries(record.authority).some(
          ([recordKey, recordValue]) => recordKey === key && recordValue !== value,
        ),
      )
    ) {
      throw new BuilderHandoffUnavailableError();
    }
    // Initial redemption checks expiry. A trusted session retains its prepared
    // context afterwards, including when its engine is restarted or recovered.
    return record.intent ?? null;
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
    isActiveMember: async (value) => await membership.isActiveMember(value),
    read: createPostgresBuilderHandoffStore(database).read,
  });
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  return async (sessionAuth: PreparedHandoffSessionAuth) => {
    const { authority } = exactForwardedSessionAuthority(sessionAuth);
    if (authority.issuer !== config.issuer || authority.audience !== config.resource) {
      throw new BuilderHandoffUnavailableError();
    }
    return await read(sessionAuth);
  };
}

// Cache only principal-free infrastructure. Membership, owner-bound context,
// and provider credentials are always resolved anew for each invocation.
let deploymentReader: ReturnType<typeof createDeploymentPreparedHandoffReader> | null = null;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readPreparedHandoffContext(sessionAuth: SessionAuth) {
  if (sourceHandoffIdForSessionAuth(sessionAuth) === undefined) {
    return null;
  }
  // Preserve the shared lazy promise while clearing it after a failed creation.
  // oxlint-disable promise/prefer-await-to-callbacks
  // oxlint-disable-next-line promise/prefer-await-to-callbacks
  // Preserve the shared lazy promise while clearing it after a failed creation.
  // oxlint-disable-next-line promise/prefer-await-to-then
  deploymentReader ??= createDeploymentPreparedHandoffReader();
  try {
    return await (
      await deploymentReader
    )(sessionAuth);
  } catch {
    deploymentReader = null;
    throw new BuilderHandoffUnavailableError();
  }
}
