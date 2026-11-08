import { protectedAppBoundarySchema } from "./hosted-operator-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";

/** The existing native Gateway verification route, bound to the approved public origin. */
export const repositoryProductionGatewayVerification = (scope: RepositoryProductionScope) => ({
  publicOrigin: scope.publicOrigin,
  gatewayOrigin: scope.publicOrigin,
  jwksUrl: `${scope.publicOrigin}/_platform/jwks.json`,
});

export const repositoryProductionAppBoundaryKey = (appId: string) =>
  `${appId.replaceAll("-", "_").toUpperCase()}_APP_BOUNDARY`;

/** Project public verifier/runtime facts from the same owned runtime credential, never its password. */
export const repositoryProductionAppBoundary = (
  row: RepositoryProductionRow,
  runtimeUrl: string,
) => {
  const { resource, scope } = row.record;
  let runtime: URL;
  try {
    runtime = new URL(runtimeUrl);
  } catch {
    throw new Error("repository_production_runtime_binding_conflict");
  }
  if (
    row.record.intent.storage.kind !== "postgres" ||
    resource === undefined ||
    runtime.protocol !== "postgresql:" ||
    runtime.username !== resource.runtimeRole ||
    runtime.pathname !== `/${resource.database}`
  ) {
    throw new Error("repository_production_runtime_binding_conflict");
  }
  const verification = repositoryProductionGatewayVerification(scope);
  return protectedAppBoundarySchema.parse({
    version: 1,
    mode: "protected-gateway-v1",
    appId: scope.appId,
    verification: { publicOrigin: verification.publicOrigin, jwksUrl: verification.jwksUrl },
    runtime: {
      hostname: runtime.hostname,
      port: Number(runtime.port || 5432),
      database: resource.database,
      runtimeRole: resource.runtimeRole,
      environment: "hosted",
    },
  });
};
