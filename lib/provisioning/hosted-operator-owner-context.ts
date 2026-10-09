import {
  createHostedOperatorConsentDiagnostic,
  operatorOwnerStoreImportErrorCodeSchema,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  HostedOperatorConsentMetadata,
} from "./hosted-operator-consent-diagnostic";
import { z } from "zod";
import { parseHostedDatabaseUrl } from "../db/postgres-connection-policy";
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
  diagnosticSink?: HostedOperatorConsentDiagnosticSink;
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
    const report = createHostedOperatorConsentDiagnostic(
      input.adapterSessionId,
      dependencies.diagnosticSink,
    );
    let stage: HostedOperatorConsentMetadata["stage"] = "owner_authority";
    const emit = (outcome: HostedOperatorConsentMetadata["outcome"]) => {
      report({ boundary: "builder", outcome, phase: "inline", stage });
    };
    const advance = (next: HostedOperatorConsentMetadata["stage"]) => {
      emit("verified");
      stage = next;
      emit("started");
    };
    emit("started");
    try {
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
      advance("owner_membership");
      if (!(await dependencies.isActiveMember(input.authority))) {
        throw new HostedOperatorError("authorization_required");
      }

      advance("owner_session_binding");
      if (handoffId === undefined) {
        const result = await resolveDirectOwnerContext({
          adapterSessionId: input.adapterSessionId,
          authority: input.authority,
          principal: input.principal,
          sessions: dependencies.sessions,
        });
        emit("verified");
        return result;
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

      emit("verified");
      return {
        adapterGeneration: session.adapterGeneration,
        adapterSessionId: session.adapterSessionId,
        authority: hostedTenantAuthoritySchema.parse(input.authority),
        kind: "handoff",
        principal: hostedPrincipalSchema.parse(input.principal),
        sessionId: session.sessionId,
        sourceHandoffId: handoffId,
      };
    } catch (error) {
      emit(
        error instanceof HostedOperatorError && error.code === "authorization_required"
          ? "operator_access_denied"
          : "setup_unavailable",
      );
      throw error;
    }
  };

const ownerReaderConfigurationSchema = z
  .strictObject({
    databaseUrl: z.string().transform((value) => parseHostedDatabaseUrl(value)),
    issuer: z.url().startsWith("https://"),
    resource: z.url().startsWith("https://"),
  })
  .superRefine((configuration, context) => {
    const issuer = new URL(configuration.issuer);
    const resource = new URL(configuration.resource);
    if (
      issuer.pathname !== "/api/auth" ||
      [issuer.username, issuer.password, issuer.search, issuer.hash].some(Boolean)
    ) {
      context.addIssue({
        code: "custom",
        message: "Owner issuer must be the exact HTTPS /api/auth URL.",
        path: ["issuer"],
      });
    }
    if (
      resource.pathname !== "/mcp" ||
      resource.origin !== issuer.origin ||
      [resource.username, resource.password, resource.search, resource.hash].some(Boolean)
    ) {
      context.addIssue({
        code: "custom",
        message: "Owner audience must be the same-origin exact HTTPS /mcp URL.",
        path: ["resource"],
      });
    }
  });

/** Reading existing ownership requires database authority and canonical identity URLs, not Auth signing credentials. */
export const readHostedOperatorOwnerReaderConfiguration = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  ownerReaderConfigurationSchema.parse({
    databaseUrl: environment.DATABASE_URL,
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
  });

let deploymentResolver: Promise<
  ReturnType<typeof createHostedOperatorOwnerContextResolver>
> | null = null;

type OwnerReaderConfiguration = ReturnType<typeof readHostedOperatorOwnerReaderConfiguration>;
type OwnerReaderStores = Pick<
  OwnerContextResolverDependencies,
  "handoffs" | "isActiveMember" | "sessions"
>;
type OpenOwnerReaderStores = (
  configuration: OwnerReaderConfiguration,
) => Promise<OwnerReaderStores>;

type OwnerInitializationStage =
  | "owner_configuration_parse"
  | "owner_store_import"
  | "owner_store_construction";
class OwnerInitializationError extends Error {
  readonly stage: OwnerInitializationStage;
  readonly ownerConfiguration: HostedOperatorConsentMetadata["ownerConfiguration"];
  readonly ownerStoreImport: HostedOperatorConsentMetadata["ownerStoreImport"];
  constructor(
    stage: OwnerInitializationStage,
    ownerConfiguration?: HostedOperatorConsentMetadata["ownerConfiguration"],
    ownerStoreImport?: HostedOperatorConsentMetadata["ownerStoreImport"],
  ) {
    super("Owner initialization unavailable.");
    this.name = "OwnerInitializationError";
    this.stage = stage;
    this.ownerConfiguration = ownerConfiguration;
    this.ownerStoreImport = ownerStoreImport;
  }
}

const ownerCanonicalUrl = (value: string | undefined, pathname: string): URL | null => {
  if (value === undefined || !value.startsWith("https://")) {
    return null;
  }
  try {
    const parsed = new URL(value);
    const valid = [
      parsed.protocol === "https:",
      parsed.pathname === pathname,
      parsed.username === "",
      parsed.password === "",
      parsed.search === "",
      parsed.hash === "",
    ].every(Boolean);
    return valid ? parsed : null;
  } catch {
    return null;
  }
};

/** Fixed booleans explain configuration failures without retaining any input or exception. */
const ownerConfigurationDiagnostic = (
  environment: Readonly<Record<string, string | undefined>>,
): HostedOperatorConsentMetadata["ownerConfiguration"] => {
  try {
    const databaseUrl = environment.DATABASE_URL;
    const issuer = environment.BETTER_AUTH_URL;
    const resource = environment.MCP_RESOURCE_URL;
    let databasePolicyValid = false;
    try {
      parseHostedDatabaseUrl(databaseUrl);
      databasePolicyValid = true;
    } catch {
      /* Only the policy result is diagnostic. */
    }
    const issuerUrl = ownerCanonicalUrl(issuer, "/api/auth");
    const resourceUrl = ownerCanonicalUrl(resource, "/mcp");
    return {
      databasePolicyValid,
      databaseUrlConfigured: databaseUrl !== undefined && databaseUrl !== "",
      issuerCanonical: issuerUrl !== null,
      issuerConfigured: issuer !== undefined && issuer !== "",
      resourceCanonical:
        issuerUrl !== null && resourceUrl !== null && resourceUrl.origin === issuerUrl.origin,
      resourceConfigured: resource !== undefined && resource !== "",
    };
  } catch {
    // Hostile configuration getters must not change the unavailable behavior.
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional diagnostic is absent after a hostile getter.
    return undefined;
  }
};

const loadOwnerReaderModule = async <ImportedModule>(
  module: NonNullable<HostedOperatorConsentMetadata["ownerStoreImport"]>["module"],
  load: () => Promise<ImportedModule>,
): Promise<ImportedModule> => {
  try {
    return await load();
  } catch (error) {
    const failure: NonNullable<HostedOperatorConsentMetadata["ownerStoreImport"]> = { module };
    try {
      const parsed = z
        .object({ code: operatorOwnerStoreImportErrorCodeSchema.optional() })
        .safeParse(error);
      if (parsed.success && parsed.data.code !== undefined) {
        failure.errorCode = parsed.data.code;
      }
    } catch {
      /* A hostile error getter never becomes diagnostic data. */
    }
    throw new OwnerInitializationError("owner_store_import", undefined, failure);
  }
};

const openOwnerReaderStores: OpenOwnerReaderStores = async (config) => {
  const [
    { openHostedPostgresDatabase },
    { createPostgresBuilderHandoffStore },
    { createPostgresHostedEveStore },
    { createPostgresPreviewOrganizationAuthority },
  ] = await Promise.all([
    loadOwnerReaderModule("database", async () => await import("../mcp/hosted-route")),
    loadOwnerReaderModule("handoff", async () => await import("../handoff/postgres-store")),
    loadOwnerReaderModule("session", async () => await import("../eve/postgres-hosted-store")),
    loadOwnerReaderModule(
      "membership",
      async () => await import("../auth/postgres-organization-user-authority"),
    ),
  ]);
  try {
    const database = openHostedPostgresDatabase(config.databaseUrl);
    const membership = createPostgresPreviewOrganizationAuthority(database, {
      audience: config.resource,
      issuer: config.issuer,
    });
    return {
      handoffs: createPostgresBuilderHandoffStore(database),
      isActiveMember: async (authority) => {
        const active = await membership.isActiveMember(authority);
        return active;
      },
      sessions: createPostgresHostedEveStore(database),
    };
  } catch {
    throw new OwnerInitializationError("owner_store_construction");
  }
};

export const createHostedOperatorDeploymentOwnerContextResolver = async (
  environment: Readonly<Record<string, string | undefined>>,
  openStores: OpenOwnerReaderStores = openOwnerReaderStores,
) => {
  let config: OwnerReaderConfiguration;
  try {
    config = readHostedOperatorOwnerReaderConfiguration(environment);
  } catch {
    throw new OwnerInitializationError(
      "owner_configuration_parse",
      ownerConfigurationDiagnostic(environment),
    );
  }
  try {
    const stores = await openStores(config);
    return createHostedOperatorOwnerContextResolver({
      ...stores,
      audience: config.resource,
      issuer: config.issuer,
    });
  } catch (error) {
    if (error instanceof OwnerInitializationError) {
      throw error;
    }
    throw new OwnerInitializationError("owner_store_construction");
  }
};

/** Server-owned deployment resolver; principal and session rows are re-read for every call. */
export const resolveHostedOperatorOwnerContext = async (input: {
  adapterSessionId: string;
  authority: HostedSessionTenantAuthority;
  principal: HostedPrincipal;
  sessionAuth: unknown;
  environment: Readonly<Record<string, string | undefined>>;
}): Promise<OperatorOwnerContext> => {
  const report = createHostedOperatorConsentDiagnostic(input.adapterSessionId);
  report({
    boundary: "builder",
    outcome: "started",
    phase: "inline",
    stage: "owner_configuration",
  });
  deploymentResolver ??= createHostedOperatorDeploymentOwnerContextResolver(input.environment);
  const pendingResolver = deploymentResolver;
  let resolver: Awaited<typeof pendingResolver>;
  try {
    resolver = await pendingResolver;
  } catch (error) {
    deploymentResolver = null;
    const diagnostic: HostedOperatorConsentMetadata = {
      boundary: "builder",
      outcome: "setup_unavailable",
      phase: "inline",
      stage: error instanceof OwnerInitializationError ? error.stage : "owner_configuration",
    };
    if (error instanceof OwnerInitializationError && error.ownerConfiguration !== undefined) {
      diagnostic.ownerConfiguration = error.ownerConfiguration;
    }
    if (error instanceof OwnerInitializationError && error.ownerStoreImport !== undefined) {
      diagnostic.ownerStoreImport = error.ownerStoreImport;
    }
    report(diagnostic);
    throw new HostedOperatorError("operator_unavailable");
  }
  report({
    boundary: "builder",
    outcome: "verified",
    phase: "inline",
    stage: "owner_configuration",
  });
  return await resolver(input);
};
