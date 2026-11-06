import { getToken } from "@vercel/connect";
import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import { privateMaintenanceUrl, readSqlIdentity } from "./hosted-operator-native-preview-neon";
import type { RepositoryProductionWorkerProfile } from "./repository-production-workers";

/** Workspace-owned provider connection; never selected from an app creator's request. */
export interface RepositoryProductionConnectionProfile {
  connector: string;
  installationId: string;
  subject: { id: string; issuer: string; type: "user" };
  operator: {
    projectId: string;
    ownerId: string;
    environment: "production";
    audience: string;
    issuer: string;
  };
}
export const createRepositoryProductionConnectionReader =
  (input: {
    connection: RepositoryProductionConnectionProfile;
    resources: Pick<RepositoryProductionWorkerProfile, "neon" | "authResource">;
    assertCurrent: () => Promise<void>;
    signal: AbortSignal;
    fetch?: typeof fetch;
    io?: {
      getOidc: typeof getVercelOidcToken;
      verifyOidc: typeof verifyVercelOidcToken;
      getToken: typeof getToken;
      readIdentity: typeof readSqlIdentity;
    };
  }) =>
  async () => {
    const io = input.io ?? {
      getOidc: getVercelOidcToken,
      verifyOidc: verifyVercelOidcToken,
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
    const projectPath = `/projects/${encodeURIComponent(scope.projectId)}`;
    const read = async (path: string, query: Record<string, string> = {}) => {
      await input.assertCurrent();
      const token = await io.getToken(
        input.connection.connector,
        { installationId: input.connection.installationId, subject: input.connection.subject },
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
      const url = privateMaintenanceUrl(value.uri, {
        projectId: scope.projectId,
        branchId: scope.branchId,
        endpointId: scope.endpointId,
        hostname: scope.endpoint,
        maintenanceDatabase: database,
        maintenanceRole: role,
      });
      const identity = await io.readIdentity(url);
      if (identity.database !== database || identity.role !== role) {
        throw new Error("repository_production_provider_scope_mismatch");
      }
      await input.assertCurrent();
      return url;
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
