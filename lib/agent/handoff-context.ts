import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import { BuilderHandoffUnavailableError } from "../handoff/service";
import {
  exactForwardedSessionAuthority,
  sourceHandoffIdForSessionAuth,
} from "../hosted/session-authority";
import type { HostedSessionTenantAuthority } from "../hosted/session-authority";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPreparedHandoffReader(input: {
  read: BuilderHandoffStore["read"];
  isActiveMember: (authority: HostedSessionTenantAuthority) => Promise<boolean>;
}) {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
  return async (sessionAuth: unknown) => {
    const handoffId = sourceHandoffIdForSessionAuth(sessionAuth);
    if (handoffId === undefined) {
      return;
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
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
        ([key, value]) => record.authority[key as keyof HostedSessionTenantAuthority] !== value,
      )
    ) {
      throw new BuilderHandoffUnavailableError();
    }
    // Initial redemption checks expiry. A trusted session retains its prepared
    // context afterwards, including when its engine is restarted or recovered.
    // oxlint-disable-next-line typescript/consistent-return -- Preserve absent handoff context during recovery.
    return record.intent;
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
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
    isActiveMember: (value) => membership.isActiveMember(value),
    read: createPostgresBuilderHandoffStore(database).read,
  });
  // oxlint-disable-next-line eslint/require-await, anti-slop/no-unknown-parameters -- preserve Promise-returning framework or interface contract Preserve the existing unknown input contract.
  return async (sessionAuth: unknown) => {
    const { authority } = exactForwardedSessionAuthority(sessionAuth);
    if (authority.issuer !== config.issuer || authority.audience !== config.resource) {
      throw new BuilderHandoffUnavailableError();
    }
    return await read(sessionAuth);
  };
}

// Cache only principal-free infrastructure. Membership, owner-bound context,
// and provider credentials are always resolved anew for each invocation.
let deploymentReader: ReturnType<typeof createDeploymentPreparedHandoffReader> | undefined;

// oxlint-disable-next-line eslint/func-style, anti-slop/no-unknown-parameters -- Preserve function declaration hoisting and initialization timing. Preserve the existing unknown input contract.
export async function readPreparedHandoffContext(sessionAuth: unknown) {
  if (sourceHandoffIdForSessionAuth(sessionAuth) === undefined) {
    return;
  }
  // Preserve the shared lazy promise while clearing it after a failed creation.
  // oxlint-disable promise/prefer-await-to-callbacks
  // oxlint-disable-next-line promise/prefer-await-to-callbacks
  // Preserve the shared lazy promise while clearing it after a failed creation.
  // oxlint-disable-next-line promise/prefer-await-to-then
  // oxlint-disable-next-line github/no-then, promise/prefer-await-to-then, anti-slop/no-unknown-parameters -- Preserve the shared initialization promise and its unknown rejection boundary.
  deploymentReader ??= createDeploymentPreparedHandoffReader().catch((error: unknown) => {
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    deploymentReader = undefined;
    throw error;
  });
  // oxlint-enable promise/prefer-await-to-callbacks
  // oxlint-disable-next-line typescript/consistent-return -- Preserve absent handoff context during recovery.
  return await (
    await deploymentReader
  )(sessionAuth);
}
