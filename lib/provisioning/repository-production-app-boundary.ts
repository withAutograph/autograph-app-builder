import { protectedAppBoundarySchema } from "./hosted-operator-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";

const invalidBoundary = () => new Error("repository_production_runtime_binding_conflict");
export interface RepositoryProductionRuntimeEndpoint {
  hostname: string;
  port: number;
}

/** The existing native Gateway verification route, bound to the approved public origin. */
export const repositoryProductionGatewayVerification = (scope: RepositoryProductionScope) => ({
  publicOrigin: scope.publicOrigin,
  gatewayOrigin: scope.publicOrigin,
  jwksUrl: `${scope.publicOrigin}/_platform/jwks.json`,
});

export const repositoryProductionAppBoundaryKey = (appId: string) =>
  `${appId.replaceAll("-", "_").toUpperCase()}_APP_BOUNDARY`;

/** Bind configured endpoint and saved resource facts to the credential without exposing its password. */
export const repositoryProductionAppBoundary = (
  row: RepositoryProductionRow,
  runtimeUrl: string,
  endpoint: RepositoryProductionRuntimeEndpoint,
) => {
  const { resource, scope } = row.record;
  let runtime: URL;
  try {
    runtime = new URL(runtimeUrl);
  } catch {
    throw invalidBoundary();
  }
  if (row.record.intent.storage.kind !== "postgres" || resource === undefined) {
    throw invalidBoundary();
  }
  if (
    runtime.protocol !== "postgresql:" ||
    runtime.username !== resource.runtimeRole ||
    runtime.pathname !== `/${resource.database}`
  ) {
    throw invalidBoundary();
  }
  const verification = repositoryProductionGatewayVerification(scope);
  if (runtime.hostname !== endpoint.hostname || Number(runtime.port || 5432) !== endpoint.port) {
    throw invalidBoundary();
  }
  return protectedAppBoundarySchema.parse({
    version: 1,
    mode: "protected-gateway-v1",
    appId: scope.appId,
    verification: { publicOrigin: verification.publicOrigin, jwksUrl: verification.jwksUrl },
    runtime: {
      hostname: endpoint.hostname,
      port: endpoint.port,
      database: resource.database,
      runtimeRole: resource.runtimeRole,
      environment: "hosted",
    },
  });
};
