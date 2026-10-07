import {
  exactForwardedSessionAuthority,
  sourceHandoffIdForSessionAuth,
} from "../hosted/session-authority";
import type { HostedSessionTenantAuthority } from "../hosted/session-authority";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "../eve/hosted-store";
import type { HostedEveStore } from "../eve/hosted-store";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

interface OwnerContextResolverDependencies {
  handoffs: Pick<BuilderHandoffStore, "read">;
  sessions: Pick<HostedEveStore, "getSession"> &
    Partial<Pick<HostedEveStore, "getSessionByAdapterSessionId">>;
  isActiveMember: (authority: HostedSessionTenantAuthority) => Promise<boolean>;
  issuer: string;
  audience: string;
}

const sameAuthority = (left: HostedSessionTenantAuthority, right: HostedSessionTenantAuthority) =>
  JSON.stringify([left.issuer, left.audience, left.workspaceId, left.ownerUserId]) ===
  JSON.stringify([right.issuer, right.audience, right.workspaceId, right.ownerUserId]);

const samePrincipal = (left: HostedPrincipal, right: HostedPrincipal) =>
  sameAuthority(left, right) &&
  JSON.stringify([...left.scopes].toSorted()) === JSON.stringify([...right.scopes].toSorted());

const resolveDirectOwnerContext = async (input: {
  adapterSessionId: string;
  authority: HostedSessionTenantAuthority;
  principal: HostedPrincipal;
  sessions: OwnerContextResolverDependencies["sessions"];
}): Promise<OperatorOwnerContext> => {
  const { getSessionByAdapterSessionId } = input.sessions;
  if (getSessionByAdapterSessionId === undefined) {
    throw new HostedOperatorError("authorization_required");
  }
  const storedSession = await getSessionByAdapterSessionId.call(
    input.sessions,
    input.principal,
    input.adapterSessionId,
  );
  const storedSessionRecord = hostedSessionRecordSchema.safeParse(storedSession);
  if (!storedSessionRecord.success || storedSessionRecord.data.version !== 2) {
    throw new HostedOperatorError("authorization_required");
  }
  const session = toDurableHostedSessionRecord(storedSessionRecord.data);
  if (
    session.sourceHandoffId !== undefined ||
    session.adapterSessionId !== input.adapterSessionId ||
    !samePrincipal(session.principal, input.principal)
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  return {
    adapterGeneration: session.adapterGeneration,
    adapterSessionId: session.adapterSessionId,
    authority: hostedTenantAuthoritySchema.parse(input.authority),
    kind: "direct",
    principal: hostedPrincipalSchema.parse(input.principal),
    sessionId: session.sessionId,
  };
};

/** Resolves only through exact tenant-scoped durable handoff or adapter bindings. */
export const createHostedOperatorOwnerContextResolver =
  (dependencies: OwnerContextResolverDependencies) =>
  async (input: {
    adapterSessionId: string;
    authority: HostedSessionTenantAuthority;
    principal: HostedPrincipal;
    sessionAuth: unknown;
  }): Promise<OperatorOwnerContext> => {
    const handoffId = sourceHandoffIdForSessionAuth(input.sessionAuth);
    const forwarded = exactForwardedSessionAuthority(input.sessionAuth);
    if (
      input.authority.issuer !== dependencies.issuer ||
      input.authority.audience !== dependencies.audience
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    if (!sameAuthority(input.authority, forwarded.authority)) {
      throw new HostedOperatorError("authorization_required");
    }
    if (!samePrincipal(input.principal, forwarded.principal)) {
      throw new HostedOperatorError("authorization_required");
    }
    if (!(await dependencies.isActiveMember(input.authority))) {
      throw new HostedOperatorError("authorization_required");
    }

    if (handoffId === undefined) {
      return await resolveDirectOwnerContext({
        adapterSessionId: input.adapterSessionId,
        authority: input.authority,
        principal: input.principal,
        sessions: dependencies.sessions,
      });
    }

    const storedHandoff = await dependencies.handoffs.read({
      authority: hostedTenantAuthoritySchema.parse(input.authority),
      handoffId,
    });
    const handoff = builderHandoffRecordSchema.safeParse(storedHandoff);
    if (!handoff.success) {
      throw new HostedOperatorError("authorization_required");
    }
    if (handoff.data.handoffId !== handoffId || handoff.data.sessionId === undefined) {
      throw new HostedOperatorError("authorization_required");
    }
    if (!sameAuthority(handoff.data.authority, input.authority)) {
      throw new HostedOperatorError("authorization_required");
    }

    const storedSession = await dependencies.sessions.getSession(
      input.principal,
      handoff.data.sessionId,
    );
    const storedSessionRecord = hostedSessionRecordSchema.safeParse(storedSession);
    if (!storedSessionRecord.success) {
      throw new HostedOperatorError("authorization_required");
    }
    const session = toDurableHostedSessionRecord(storedSessionRecord.data);
    if (
      session.sessionId !== handoff.data.sessionId ||
      (storedSessionRecord.data.version === 2 &&
        storedSessionRecord.data.sourceHandoffId !== handoffId)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    if (session.adapterSessionId !== input.adapterSessionId) {
      throw new HostedOperatorError("authorization_required");
    }
    if (!samePrincipal(session.principal, input.principal)) {
      throw new HostedOperatorError("authorization_required");
    }

    return {
      adapterGeneration: session.adapterGeneration,
      adapterSessionId: session.adapterSessionId,
      authority: hostedTenantAuthoritySchema.parse(input.authority),
      kind: "handoff",
      principal: hostedPrincipalSchema.parse(input.principal),
      sessionId: session.sessionId,
      sourceHandoffId: handoffId,
    };
  };

let deploymentResolver: Promise<
  ReturnType<typeof createHostedOperatorOwnerContextResolver>
> | null = null;

const createDeploymentResolver = async (
  environment: Readonly<Record<string, string | undefined>>,
) => {
  const [
    { readPreviewOAuthRuntimeConfig },
    { openHostedPostgresDatabase },
    { createPostgresBuilderHandoffStore },
    { createPostgresHostedEveStore },
    { createPostgresPreviewOrganizationAuthority },
  ] = await Promise.all([
    import("../auth/preview-oauth-runtime"),
    import("../mcp/hosted-route"),
    import("../handoff/postgres-store"),
    import("../eve/postgres-hosted-store"),
    import("../auth/postgres-organization-user-authority"),
  ]);
  const config = readPreviewOAuthRuntimeConfig({ ...environment });
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const membership = createPostgresPreviewOrganizationAuthority(database, {
    audience: config.resource,
    issuer: config.issuer,
  });
  return createHostedOperatorOwnerContextResolver({
    audience: config.resource,
    handoffs: createPostgresBuilderHandoffStore(database),
    isActiveMember: async (authority) => {
      const active = await membership.isActiveMember(authority);
      return active;
    },
    issuer: config.issuer,
    sessions: createPostgresHostedEveStore(database),
  });
};

/** Server-owned deployment resolver; principal and session rows are re-read for every call. */
export const resolveHostedOperatorOwnerContext = async (input: {
  adapterSessionId: string;
  authority: HostedSessionTenantAuthority;
  principal: HostedPrincipal;
  sessionAuth: unknown;
  environment: Readonly<Record<string, string | undefined>>;
}): Promise<OperatorOwnerContext> => {
  deploymentResolver ??= createDeploymentResolver(input.environment);
  const pendingResolver = deploymentResolver;
  let resolver: Awaited<typeof pendingResolver>;
  try {
    resolver = await pendingResolver;
  } catch {
    deploymentResolver = null;
    throw new HostedOperatorError("operator_unavailable");
  }
  return await resolver(input);
};
