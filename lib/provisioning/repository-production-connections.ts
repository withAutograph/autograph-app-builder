import { getToken } from "@vercel/connect";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import {
  privateMaintenanceUrl,
  readSqlIdentity,
  scopeSchema,
} from "./hosted-operator-native-preview-neon";
import type { RepositoryProductionWorkerProfile } from "./repository-production-workers";
import type {
  RepositoryProductionConnectConnection,
  RepositoryProductionSecretConnection,
} from "./repository-production-configuration";

/** Workspace-owned provider connection; never selected from an app creator's request. */
export type RepositoryProductionConnectionProfile = (
  | RepositoryProductionConnectConnection
  | RepositoryProductionSecretConnection
) & {
  operator: {
    projectId: string;
    ownerId: string;
    environment: "production";
    audience: string;
    issuer: string;
  };
};
export const createRepositoryProductionConnectionReader =
  (input: {
    connection: RepositoryProductionConnectionProfile;
    resources: Pick<RepositoryProductionWorkerProfile, "neon" | "authResource">;
    assertCurrent: () => Promise<void>;
    signal: AbortSignal;
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof fetch;
    io?: {
      getOidc: typeof getVercelOidcToken;
      verifyOidc: (
        token: string,
        options: Parameters<typeof verifyVercelOidcToken>[1],
      ) => Promise<void>;
      getToken: typeof getToken;
      readIdentity: typeof readSqlIdentity;
    };
  }) =>
  async () => {
    const io = input.io ?? {
      getOidc: getVercelOidcToken,
      verifyOidc: async (token, options) => {
        await verifyVercelOidcToken(token, options);
      },
      getToken,
      readIdentity: readSqlIdentity,
    };
    await input.assertCurrent();
    const oidcToken = await io.getOidc({
      project: input.connection.operator.projectId,
      team: input.connection.operator.ownerId,
    });
    await io.verifyOidc(oidcToken, input.connection.operator);
    const scope = input.resources.neon;
    const validateUrl = (value: string, database: string, role: string) => {
      try {
        return privateMaintenanceUrl(
          value,
          scopeSchema.parse({
            projectId: scope.projectId,
            branchId: scope.branchId,
            endpointId: scope.endpointId,
            hostname: scope.endpoint,
            maintenanceDatabase: database,
            maintenanceRole: role,
          }),
        );
      } catch {
        throw new Error("repository_production_provider_scope_mismatch");
      }
    };
    const verifyIdentity = async (url: string, database: string, role: string) => {
      await input.assertCurrent();
      let identity: Awaited<ReturnType<typeof io.readIdentity>>;
      try {
        identity = await io.readIdentity(url);
      } catch {
        // Driver errors can contain connection values. Keep them inside the credential boundary.
        throw new Error("repository_production_provider_unavailable");
      }
      if (identity.database !== database || identity.role !== role) {
        throw new Error("repository_production_provider_scope_mismatch");
      }
      await input.assertCurrent();
      return url;
    };
    const connection = input.connection;
    if ("kind" in connection) {
      const environment = input.environment ?? process.env;
      const bound = (name: string, database: string, role: string) => {
        const value = environment[name];
        if (value === undefined || value === "") {
          throw new Error("repository_production_connection_binding_unavailable");
        }
        return validateUrl(value, database, role);
      };
      // Validate every explicit binding before opening any database connection. Never try Connect on failure.
      const maintenance = bound(
        connection.maintenanceUrlEnvironment,
        scope.maintenanceDatabase,
        scope.maintenanceRole,
      );
      const migrator = bound(
        connection.authMigratorEnvironment,
        input.resources.authResource.database,
        input.resources.authResource.migratorRole,
      );
      const runtime = bound(
        connection.authRuntimeEnvironment,
        input.resources.authResource.database,
        input.resources.authResource.runtimeRole,
      );
      const [maintenanceUrl, authMigrator, authRuntime] = await Promise.all([
        verifyIdentity(maintenance, scope.maintenanceDatabase, scope.maintenanceRole),
        verifyIdentity(
          migrator,
          input.resources.authResource.database,
          input.resources.authResource.migratorRole,
        ),
        verifyIdentity(
          runtime,
          input.resources.authResource.database,
          input.resources.authResource.runtimeRole,
        ),
      ]);
      await input.assertCurrent();
      return { maintenanceUrl, authMigrator, authRuntime, oidcToken };
    }
    const projectPath = `/projects/${encodeURIComponent(scope.projectId)}`;
    const read = async (path: string, query: Record<string, string> = {}) => {
      await input.assertCurrent();
      const token = await io.getToken(
        connection.connector,
        { installationId: connection.installationId, subject: connection.subject },
        { forceRefresh: true, vercelToken: oidcToken },
      );
      await input.assertCurrent();
      const url = new URL(`/api/v2${path}`, "https://console.neon.tech");
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, value);
      }
      const response = await (input.fetch ?? fetch)(url, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        headers: { accept: "application/json", authorization: `Bearer ${token}` },
        signal: input.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("repository_production_provider_unavailable");
      }
      const value: unknown = await response.json();
      await input.assertCurrent();
      return value;
    };
    const endpoint = z
      .object({
        endpoint: z.object({
          id: z.string(),
          project_id: z.string(),
          branch_id: z.string(),
          host: z.string(),
          type: z.literal("read_write"),
        }),
      })
      .parse(
        await read(`${projectPath}/endpoints/${encodeURIComponent(scope.endpointId)}`),
      ).endpoint;
    if (
      endpoint.id !== scope.endpointId ||
      endpoint.project_id !== scope.projectId ||
      endpoint.branch_id !== scope.branchId ||
      endpoint.host !== scope.endpoint
    ) {
      throw new Error("repository_production_provider_scope_mismatch");
    }
    const uri = async (database: string, role: string) => {
      const value = z.object({ uri: z.string() }).parse(
        await read(`${projectPath}/connection_uri`, {
          branch_id: scope.branchId,
          database_name: database,
          endpoint_id: scope.endpointId,
          pooled: "false",
          role_name: role,
        }),
      );
      return await verifyIdentity(validateUrl(value.uri, database, role), database, role);
    };
    // Only the protected operator receives these values; app runtimes receive their own restricted URL.
    const [maintenanceUrl, authMigrator, authRuntime] = await Promise.all([
      uri(scope.maintenanceDatabase, scope.maintenanceRole),
      uri(input.resources.authResource.database, input.resources.authResource.migratorRole),
      uri(input.resources.authResource.database, input.resources.authResource.runtimeRole),
    ]);
    await input.assertCurrent();
    return { maintenanceUrl, authMigrator, authRuntime, oidcToken };
  };
