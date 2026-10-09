import { createMCPClient } from "@ai-sdk/mcp";
import type { MCPClient, MCPClientConfig } from "@ai-sdk/mcp";
import { connectAuthProvider } from "@vercel/connect/mcp";
import { deleteTokenCacheEntry } from "@vercel/connect";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import {
  scopeSchema,
  configurationSchema,
  privateMaintenanceUrl,
  readSqlIdentity,
} from "./hosted-operator-native-preview-neon";
import type {
  NativePreviewNeonConfiguration,
  NativePreviewNeonDependencies,
  NativePreviewNeonScope,
} from "./hosted-operator-native-preview-neon";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  readNativePreviewNeonProvenance,
  snapshotSyntheticNeonEnrollment,
} from "./hosted-operator-synthetic-neon-provenance";
import type { NativePreviewNeonInitSource } from "./hosted-operator-synthetic-neon-provenance";

const readTools = [
  "describe_project",
  "get_branch",
  "get_postgres_endpoint",
  "get_postgres_database",
  "get_postgres_role",
  "get_connection_string",
] as const;
type NativeReadTool = (typeof readTools)[number];
const unavailable = () => new Error("Protected Preview Neon MCP credential is unavailable.");
const metadata = z.object({
  content: z.array(z.object({ text: z.string(), type: z.literal("text") })),
  isError: z.boolean().optional(),
  structuredContent: z.json().optional(),
});
const decoded = (
  value: Awaited<ReturnType<Awaited<ReturnType<typeof createMCPClient>>["callTool"]>>,
) => {
  const result = metadata.parse(value);
  if (result.isError === true) {
    throw unavailable();
  }
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (result.content.length !== 1) {
    throw unavailable();
  }
  return z.json().parse(JSON.parse(result.content[0]?.text ?? ""));
};
export interface PreviewNeonMcpDependencies {
  configuration: Omit<NativePreviewNeonConfiguration, "connectorInstallationId">;
  assertApprovedScope: NativePreviewNeonDependencies["assertApprovedScope"];
  /** Separate current owner/configured-scope guard; never an approved SQL effect or credential grant. */
  assertPlanningScope?: NativePreviewNeonDependencies["assertApprovedScope"];
  readCurrentOwnerNativeStore: NativePreviewNeonDependencies["readCurrentOwnerNativeStore"];
  io?: {
    getOidc: typeof getVercelOidcToken;
    verifyOidc: (
      token: string,
      options: Parameters<typeof verifyVercelOidcToken>[1],
    ) => Promise<void>;
    readSqlIdentity: typeof readSqlIdentity;
    createClient: (config: MCPClientConfig) => Promise<Pick<MCPClient, "callTool" | "close">>;
    createAuthProvider: typeof connectAuthProvider;
  };
}
const defaultIo = {
  createAuthProvider: connectAuthProvider,
  createClient: createMCPClient,
  getOidc: getVercelOidcToken,
  readSqlIdentity,
  verifyOidc: async (token: string, options: Parameters<typeof verifyVercelOidcToken>[1]) => {
    await verifyVercelOidcToken(token, options);
  },
};
type ReaderMaterial = {
  initSource: NativePreviewNeonInitSource;
  scope: NativePreviewNeonScope;
} & ({ kind: "metadata" } | { kind: "credential"; maintenanceUrl: string });
const runReader = async <T>(
  deps: PreviewNeonMcpDependencies,
  context: HostedOperatorContext,
  frozenScope: NativePreviewNeonScope,
  kind: "metadata" | "credential",
  consume: (material: ReaderMaterial) => Promise<T>,
): Promise<T> => {
  let client: Pick<MCPClient, "callTool" | "close"> | undefined;
  try {
    const scope = Object.freeze(scopeSchema.parse(frozenScope));
    const parsedConfiguration = configurationSchema
      .omit({ connectorInstallationId: true })
      .parse(deps.configuration);
    const configuration = Object.freeze({
      ...parsedConfiguration,
      nativeStore: Object.freeze({ ...parsedConfiguration.nativeStore }),
      operator: Object.freeze({ ...parsedConfiguration.operator }),
      syntheticEnrollment: snapshotSyntheticNeonEnrollment(parsedConfiguration.syntheticEnrollment),
    });
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
    const current = Object.freeze({
      ...context,
      authority: Object.freeze({ ...context.authority }),
      ownerContext,
      target: Object.freeze({ ...context.target }),
    });
    const assertOwner = async () => {
      if (kind === "metadata") {
        if (deps.assertPlanningScope === undefined) {
          throw unavailable();
        }
        await deps.assertPlanningScope(current, scope);
      } else {
        await deps.assertApprovedScope(current, scope);
      }
      const store = await deps.readCurrentOwnerNativeStore(current, configuration.nativeStore);
      const checks = [
        current.target.environment === "preview",
        configuration.operator.projectId !== current.target.projectId,
        configuration.nativeStore.sourceProjectId !== current.target.projectId,
        store.ownerId === current.target.scopeId,
        store.ownerId === configuration.operator.ownerId,
        store.configurationId === configuration.nativeStore.configurationId,
        store.resourceId === configuration.nativeStore.resourceId,
        store.vercelProjectId === configuration.nativeStore.sourceProjectId,
        store.neonProjectId === scope.projectId,
      ];
      if (!checks.every(Boolean)) {
        throw unavailable();
      }
    };
    const io = deps.io ?? defaultIo;
    const params = {
      resources: ["https://mcp.neon.tech/mcp"],
      scopes: ["read", "write"],
      subject: {
        id: current.authority.ownerUserId,
        issuer: current.authority.issuer,
        type: "user" as const,
      },
    };
    const oidc = async () => {
      await assertOwner();
      const token = await io.getOidc();
      const op = configuration.operator;
      await io.verifyOidc(token, {
        audience: op.audience,
        environment: op.environment,
        issuer: op.issuer,
        ownerId: op.ownerId,
        projectId: op.projectId,
      });
      await assertOwner();
      return token;
    };
    await assertOwner();
    const broker = io.createAuthProvider(configuration.connector, params, { vercelToken: oidc });
    const authProvider = {
      ...broker,
      redirectToAuthorization: async () => {
        await Promise.resolve();
        throw unavailable();
      },
      tokens: async () => {
        await assertOwner();
        deleteTokenCacheEntry(configuration.connector, params);
        const tokens = await broker.tokens();
        if (tokens === undefined) {
          throw unavailable();
        }
        await assertOwner();
        return tokens;
      },
    };
    const url = new URL("https://mcp.neon.tech/mcp");
    url.searchParams.set("projectId", scope.projectId);
    for (const category of ["projects", "branches", "endpoints"]) {
      url.searchParams.append("category", category);
    }
    client = await io.createClient({
      clientName: "protected-preview-neon-reader",
      transport: { authProvider, redirect: "error", type: "http", url: url.href },
    });
    await assertOwner();
    const call = async (name: NativeReadTool, argumentsInput: Record<string, string>) => {
      await assertOwner();
      if (client === undefined) {
        throw unavailable();
      }
      const result = decoded(await client.callTool({ arguments: argumentsInput, name }));
      await assertOwner();
      return result;
    };
    const readProject = async () => await call("describe_project", { project_id: scope.projectId });
    // Keep the existing exact project check for the legacy MCP reader as well.
    if (configuration.syntheticEnrollment === undefined) {
      const project = z.object({ id: z.string() }).parse(await readProject());
      if (project.id !== scope.projectId) {
        throw unavailable();
      }
    }
    const verifyProvenance = async () =>
      await readNativePreviewNeonProvenance({
        enrollment: configuration.syntheticEnrollment,
        readBranch: async (branchId) =>
          await call("get_branch", { branch_id: branchId, project_id: scope.projectId }),
        readProject,
        scope: { branchId: scope.branchId, projectId: scope.projectId },
      });
    const verifyEndpoint = async () => {
      const endpoint = z
        .object({
          branch_id: z.string(),
          host: z.string(),
          id: z.string(),
          project_id: z.string(),
          type: z.literal("read_write"),
        })
        .parse(
          await call("get_postgres_endpoint", {
            endpoint_id: scope.endpointId,
            project_id: scope.projectId,
          }),
        );
      if (
        [
          endpoint.id !== scope.endpointId,
          endpoint.project_id !== scope.projectId,
          endpoint.branch_id !== scope.branchId,
          endpoint.host !== scope.hostname,
        ].some(Boolean)
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
    const database = z.object({ branch_id: z.string(), name: z.string() }).parse(
      await call("get_postgres_database", {
        branch_id: scope.branchId,
        database_name: scope.maintenanceDatabase,
        project_id: scope.projectId,
      }),
    );
    if (database.name !== scope.maintenanceDatabase || database.branch_id !== scope.branchId) {
      throw unavailable();
    }
    const role = z.object({ branch_id: z.string(), name: z.string() }).parse(
      await call("get_postgres_role", {
        branch_id: scope.branchId,
        project_id: scope.projectId,
        role_name: scope.maintenanceRole,
      }),
    );
    if (role.name !== scope.maintenanceRole || role.branch_id !== scope.branchId) {
      throw unavailable();
    }
    await revalidateEnrollment();
    if (kind === "metadata") {
      await assertOwner();
      const result = await consume({ initSource, kind, scope });
      await assertOwner();
      return result;
    }
    const credential = z
      .object({
        branchId: z.string(),
        computeId: z.string(),
        databaseName: z.string(),
        projectId: z.string(),
        roleName: z.string(),
        uri: z.string(),
      })
      .parse(
        await call("get_connection_string", {
          branch_id: scope.branchId,
          compute_id: scope.endpointId,
          database_name: scope.maintenanceDatabase,
          project_id: scope.projectId,
          role_name: scope.maintenanceRole,
        }),
      );
    if (
      [
        credential.projectId !== scope.projectId,
        credential.branchId !== scope.branchId,
        credential.computeId !== scope.endpointId,
        credential.databaseName !== scope.maintenanceDatabase,
        credential.roleName !== scope.maintenanceRole,
      ].some(Boolean)
    ) {
      throw unavailable();
    }
    const maintenanceUrl = privateMaintenanceUrl(credential.uri, scope);
    await revalidateEnrollment();
    await assertOwner();
    const sqlIdentity = await io.readSqlIdentity(maintenanceUrl);
    if (
      sqlIdentity.role !== scope.maintenanceRole ||
      sqlIdentity.database !== scope.maintenanceDatabase
    ) {
      throw unavailable();
    }
    await revalidateEnrollment();
    await assertOwner();
    const result = await consume({
      initSource,
      kind: "credential",
      maintenanceUrl,
      scope,
    });
    await assertOwner();
    return result;
  } catch {
    throw unavailable();
  } finally {
    try {
      await client?.close();
    } catch {
      /* No credentials escape connection cleanup errors. */
    }
  }
};
/** Credential acquisition requires the approved leased effect; metadata planning never calls URI or SQL tools. */
export const createPreviewNeonMcpReader = (deps: PreviewNeonMcpDependencies) => ({
  async inspectPlanningTarget(context: HostedOperatorContext, scope: NativePreviewNeonScope) {
    return await runReader(deps, context, scope, "metadata", async (material) => {
      if (material.kind !== "metadata") {
        throw unavailable();
      }
      return await Promise.resolve({ initSource: material.initSource, scope: material.scope });
    });
  },
  async withMaintenanceCredential<T>(
    context: HostedOperatorContext,
    scope: NativePreviewNeonScope,
    consume: (material: {
      maintenanceUrl: string;
      scope: NativePreviewNeonScope;
      initSource: NativePreviewNeonInitSource;
    }) => Promise<T>,
  ): Promise<T> {
    return await runReader(deps, context, scope, "credential", async (material) => {
      if (material.kind !== "credential") {
        throw unavailable();
      }
      return await consume({
        initSource: material.initSource,
        maintenanceUrl: material.maintenanceUrl,
        scope: material.scope,
      });
    });
  },
});
