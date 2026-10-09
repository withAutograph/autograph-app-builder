import { getToken } from "@vercel/connect";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import postgres from "postgres";
import { z } from "zod";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  readNativePreviewNeonProvenance,
  snapshotSyntheticNeonEnrollment,
  syntheticNeonEnrollmentSchema,
} from "./hosted-operator-synthetic-neon-provenance";
import type {
  NativePreviewNeonInitSource,
  SyntheticNeonEnrollment,
} from "./hosted-operator-synthetic-neon-provenance";

const id = z.string().regex(/^[a-z0-9-]{1,60}$/u);
const sqlName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
export const scopeSchema = z.strictObject({
  branchId: id,
  endpointId: id,
  hostname: z.string().endsWith(".neon.tech"),
  maintenanceDatabase: sqlName,
  maintenanceRole: sqlName,
  projectId: id,
});
export type NativePreviewNeonScope = z.infer<typeof scopeSchema>;
export interface NativePreviewNeonStoreBinding {
  configurationId: string;
  resourceId: string;
  sourceProjectId: string;
}
export interface NativePreviewNeonConfiguration {
  /** Deployment-owned Connect registration; never supplied by request/model input. */
  connector: string;
  connectorInstallationId: string;
  /** Existing owner-authorized source/operator connection; never the generated app project. */
  nativeStore: NativePreviewNeonStoreBinding;
  /** Reviewed deployment-owned authority; never derived from a request, name or init_source. */
  syntheticEnrollment?: SyntheticNeonEnrollment;
  operator: {
    projectId: string;
    environment: "preview" | "production";
    ownerId: string;
    issuer: string;
    audience: string;
  };
}
export const configurationSchema = z.strictObject({
  connector: z.string().min(1),
  connectorInstallationId: z.string().min(1),
  nativeStore: z.strictObject({
    configurationId: z.string().min(1),
    resourceId: z.string().min(1),
    sourceProjectId: z.string().min(1),
  }),
  operator: z.strictObject({
    audience: z.url(),
    environment: z.enum(["preview", "production"]),
    issuer: z.url(),
    ownerId: z.string().min(1),
    projectId: z.string().min(1),
  }),
  syntheticEnrollment: syntheticNeonEnrollmentSchema.optional(),
});
export interface NativePreviewNeonDependencies {
  configuration: NativePreviewNeonConfiguration;
  /** Re-resolve current owner membership/installation and read the exact native Vercel store. */
  readCurrentOwnerNativeStore: (
    context: HostedOperatorContext,
    binding: Readonly<NativePreviewNeonStoreBinding>,
  ) => Promise<{
    ownerId: string;
    resourceId: string;
    vercelProjectId: string;
    configurationId: string;
    neonProjectId: string;
  }>;
  /** Re-read the actual approved operation/journal and require this exact frozen resource scope. */
  assertApprovedScope: (
    context: HostedOperatorContext,
    scope: NativePreviewNeonScope,
  ) => Promise<void>;
  fetch?: typeof fetch;
  /** Trusted execution boundary, injectable for owned source fixtures only. */
  io?: NativePreviewNeonIo;
}
export interface NativePreviewNeonIo {
  getOidc: typeof getVercelOidcToken;
  verifyOidc: (
    token: string,
    options: Parameters<typeof verifyVercelOidcToken>[1],
  ) => Promise<void>;
  getOwnerToken: typeof getToken;
  readSqlIdentity: (url: string) => Promise<{ role: string; database: string }>;
}
const unavailable = () => new Error("Protected native Preview credential is unavailable.");
const verifiedTls = "verify-full";
export const readSqlIdentity: NativePreviewNeonIo["readSqlIdentity"] = async (url) => {
  const sql = postgres(url, {
    connect_timeout: 15,
    max: 1,
    onnotice: () => {
      /* Notices may contain private credentials. */
    },
    ssl: verifiedTls,
  });
  try {
    const rows = await sql.begin(
      "read only",
      async (transaction) =>
        await transaction`select current_user as role, current_database() as database`,
    );
    return z.object({ database: z.string(), role: z.string() }).parse(rows[0]);
  } finally {
    await sql.end({ timeout: 5 });
  }
};
const defaultIo: NativePreviewNeonIo = {
  getOidc: getVercelOidcToken,
  getOwnerToken: getToken,
  readSqlIdentity,
  verifyOidc: async (token, options) => {
    await verifyVercelOidcToken(token, options);
  },
};
export const privateMaintenanceUrl = (uri: string, scope: NativePreviewNeonScope) => {
  const url = new URL(uri);
  const checks = [
    ["postgres:", "postgresql:"].includes(url.protocol),
    url.hostname === scope.hostname,
    !url.hostname.includes("-pooler."),
    ["", "5432"].includes(url.port),
    decodeURIComponent(url.username) === scope.maintenanceRole,
    url.password !== "",
    decodeURIComponent(url.pathname.slice(1)) === scope.maintenanceDatabase,
    url.hash === "",
    ["require", verifiedTls].includes(url.searchParams.get("sslmode") ?? ""),
    url.searchParams.getAll("sslmode").length === 1,
    [...url.searchParams.keys()].every((key) => ["sslmode", "channel_binding"].includes(key)),
    url.searchParams.getAll("channel_binding").length <= 1,
    !url.searchParams.has("channel_binding") ||
      url.searchParams.get("channel_binding") === "require",
  ];
  if (!checks.every(Boolean)) {
    throw unavailable();
  }
  url.searchParams.set("sslmode", verifiedTls);
  return url.toString();
};

const endpointSchema = z.object({
  endpoint: z.object({
    branch_id: id,
    host: z.string(),
    id,
    project_id: id,
    type: z.literal("read_write"),
  }),
});

/** Private operator callback only. GET-only Neon access, with project-scoped OIDC Connect credentials. */
export const createNativePreviewNeonReader = (deps: NativePreviewNeonDependencies) => ({
  async withMaintenanceCredential<T>(
    context: HostedOperatorContext,
    frozenScope: NativePreviewNeonScope,
    consume: (privateMaterial: {
      maintenanceUrl: string;
      scope: NativePreviewNeonScope;
      initSource: NativePreviewNeonInitSource;
    }) => Promise<T>,
  ): Promise<T> {
    try {
      const ownerContext =
        context.ownerContext === undefined
          ? undefined
          : {
              ...context.ownerContext,
              authority: Object.freeze({ ...context.ownerContext.authority }),
              principal: {
                ...context.ownerContext.principal,
                scopes: [...context.ownerContext.principal.scopes],
              },
            };
      if (ownerContext !== undefined) {
        Object.freeze(ownerContext.principal.scopes);
        Object.freeze(ownerContext.principal);
        Object.freeze(ownerContext);
      }
      const ownedContext = Object.freeze({
        ...context,
        authority: Object.freeze({ ...context.authority }),
        ownerContext,
        target: Object.freeze({ ...context.target }),
      });
      const parsedConfiguration = configurationSchema.parse(deps.configuration);
      const configuration = Object.freeze({
        ...parsedConfiguration,
        nativeStore: Object.freeze({ ...parsedConfiguration.nativeStore }),
        operator: Object.freeze({ ...parsedConfiguration.operator }),
        syntheticEnrollment: snapshotSyntheticNeonEnrollment(
          parsedConfiguration.syntheticEnrollment,
        ),
      });
      const scope = Object.freeze(scopeSchema.parse(frozenScope));
      const assertOwner = async () => {
        await deps.assertApprovedScope(ownedContext, scope);
        const store = await deps.readCurrentOwnerNativeStore(
          ownedContext,
          configuration.nativeStore,
        );
        const checks = [
          ownedContext.target.environment === "preview",
          configuration.operator.projectId !== ownedContext.target.projectId,
          store.ownerId === ownedContext.target.scopeId,
          store.ownerId === configuration.operator.ownerId,
          configuration.nativeStore.sourceProjectId !== ownedContext.target.projectId,
          store.vercelProjectId === configuration.nativeStore.sourceProjectId,
          store.configurationId === configuration.nativeStore.configurationId,
          store.resourceId === configuration.nativeStore.resourceId,
          store.neonProjectId === scope.projectId,
        ];
        if (!checks.every(Boolean)) {
          throw unavailable();
        }
      };
      const io = deps.io ?? defaultIo;
      await assertOwner();
      const oidc = await io.getOidc();
      const { operator } = configuration;
      await io.verifyOidc(oidc, {
        audience: operator.audience,
        environment: operator.environment,
        issuer: operator.issuer,
        ownerId: operator.ownerId,
        projectId: operator.projectId,
      });
      await assertOwner();
      const read = async (pathname: string, query: Record<string, string> = {}) => {
        await assertOwner();
        // Force Connect to revalidate revoked owner grants, rather than serving its process cache.
        const token = await io.getOwnerToken(
          configuration.connector,
          {
            installationId: configuration.connectorInstallationId,
            subject: {
              id: ownedContext.authority.ownerUserId,
              issuer: ownedContext.authority.issuer,
              type: "user",
            },
          },
          { forceRefresh: true, vercelToken: oidc },
        );
        await assertOwner();
        const url = new URL(`/api/v2${pathname}`, "https://console.neon.tech");
        for (const [key, value] of Object.entries(query)) {
          url.searchParams.set(key, value);
        }
        const response = await (deps.fetch ?? fetch)(url, {
          cache: "no-store",
          headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        try {
          await assertOwner();
          if (!response.ok) {
            throw unavailable();
          }
          const value: unknown = await response.json();
          await assertOwner();
          return value;
        } finally {
          if (!response.bodyUsed) {
            await response.body?.cancel();
          }
        }
      };
      const projectPath = `/projects/${encodeURIComponent(scope.projectId)}`;
      const verifyProvenance = async () =>
        await readNativePreviewNeonProvenance({
          enrollment: configuration.syntheticEnrollment,
          readBranch: async (branchId) => {
            const value = await read(`${projectPath}/branches/${encodeURIComponent(branchId)}`);
            return z.object({ branch: z.unknown() }).parse(value).branch;
          },
          readProject: async () => {
            const value = await read(projectPath);
            return z.object({ project: z.unknown() }).parse(value).project;
          },
          scope: { branchId: scope.branchId, projectId: scope.projectId },
        });
      const verifyEndpoint = async () => {
        const { endpoint } = endpointSchema.parse(
          await read(`${projectPath}/endpoints/${encodeURIComponent(scope.endpointId)}`),
        );
        if (
          endpoint.id !== scope.endpointId ||
          endpoint.project_id !== scope.projectId ||
          endpoint.branch_id !== scope.branchId ||
          endpoint.host !== scope.hostname
        ) {
          throw unavailable();
        }
      };
      const initSource = await verifyProvenance();
      await verifyEndpoint();
      const revalidateEnrollment = async () => {
        if (configuration.syntheticEnrollment !== undefined) {
          await verifyProvenance();
          await verifyEndpoint();
        }
      };
      const { database } = z
        .object({ database: z.object({ branch_id: id, name: sqlName }) })
        .parse(
          await read(
            `${projectPath}/branches/${encodeURIComponent(scope.branchId)}/databases/${encodeURIComponent(scope.maintenanceDatabase)}`,
          ),
        );
      if (database.name !== scope.maintenanceDatabase || database.branch_id !== scope.branchId) {
        throw unavailable();
      }
      const { role } = z
        .object({ role: z.object({ branch_id: id, name: sqlName }) })
        .parse(
          await read(
            `${projectPath}/branches/${encodeURIComponent(scope.branchId)}/roles/${encodeURIComponent(scope.maintenanceRole)}`,
          ),
        );
      if (role.name !== scope.maintenanceRole || role.branch_id !== scope.branchId) {
        throw unavailable();
      }
      // Read fresh lineage and endpoint metadata immediately before privileged URI acquisition.
      await revalidateEnrollment();
      const { uri } = z.object({ uri: z.string() }).parse(
        await read(`${projectPath}/connection_uri`, {
          branch_id: scope.branchId,
          database_name: scope.maintenanceDatabase,
          endpoint_id: scope.endpointId,
          pooled: "false",
          role_name: scope.maintenanceRole,
        }),
      );
      const maintenanceUrl = privateMaintenanceUrl(uri, scope);
      await revalidateEnrollment();
      await assertOwner();
      const identity = await io.readSqlIdentity(maintenanceUrl);
      if (
        identity.role !== scope.maintenanceRole ||
        identity.database !== scope.maintenanceDatabase
      ) {
        throw unavailable();
      }
      await revalidateEnrollment();
      await assertOwner();
      // URI/token/provider payloads are never a public result, persisted artifact or diagnostic.
      const result = await consume({
        initSource,
        maintenanceUrl,
        scope,
      });
      await assertOwner();
      return result;
    } catch {
      throw unavailable();
    }
  },
});
