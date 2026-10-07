import { z } from "zod";
import type { readPreparedVercelAccess } from "../agent/prepared-provider-context";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { readVercelManagedNeonResource } from "./hosted-runtime-marketplace-resource";
import type { MarketplaceJsonValue } from "./hosted-runtime-marketplace-resource";

type CredentialReader = Parameters<typeof readPreparedVercelAccess>[0]["readCredential"];
const id = z.string().min(1);
const projectSchema = z.object({ accountId: id, id });
const deploymentSchema = z.object({
  env: z.array(z.string()).optional(),
  gitSource: z.object({ ref: id }).optional(),
  id,
  ownerId: id.optional(),
  projectId: id,
  readyState: id,
  target: z.string().nullable(),
  url: id,
});
const variableSchema = z.object({
  configurationId: z.string().optional(),
  gitBranch: z.string().nullable().optional(),
  key: z.string(),
  target: z.array(z.string()),
});
const variablesSchema = z.object({ envs: z.array(variableSchema) });
const aliasSchema = z.object({ aliases: z.array(z.object({ alias: id })) });
const json = z.json();
const jwksSchema = z.object({
  keys: z.array(
    z.object({
      alg: z.literal("EdDSA").optional(),
      crv: z.literal("Ed25519"),
      kid: id,
      kty: z.literal("OKP"),
      use: z.literal("sig").optional(),
      x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    }),
  ),
});
const keyName = /^[A-Z][A-Z0-9_]{0,199}$/u;

export interface OperatorDeploymentReference {
  deploymentId: string;
  environment: "preview" | "production";
  projectId: string;
}
export interface OperatorInventoryConfiguration {
  app: OperatorDeploymentReference & { branch: string };
  gateway: OperatorDeploymentReference & { branch: string };
  operator: OperatorDeploymentReference;
  verification: { gatewayOrigin: string; publicOrigin: string };
}

const origin = (value: string): string => {
  const parsed = new URL(value);
  const invalid = [
    parsed.protocol !== "https:",
    parsed.username !== "",
    parsed.password !== "",
    parsed.pathname !== "/",
    parsed.search !== "",
    parsed.hash !== "",
    parsed.hostname.endsWith(".vercel.run"),
  ].some(Boolean);
  if (invalid) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return parsed.origin;
};
const forbiddenAppKey = (key: string, appKey: string) => {
  const forbidden = [
    key.includes("DATABASE_URL"),
    key.startsWith("POSTGRES_"),
    [
      "PGPASSWORD",
      "PGUSER",
      "PGHOST",
      "PGHOST_UNPOOLED",
      "PGDATABASE",
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_APP_NAME",
      "VERCEL_TOKEN",
      "NEON_API_KEY",
    ].includes(key),
    key.includes("ENCRYPTION_KEY"),
    key.includes("SIGNING_SECRET"),
    key.includes("PRIVATE_KEY"),
    key.includes("CONTROL_KEY"),
    key.includes("OPERATOR_TOKEN"),
  ].some(Boolean);
  return key !== appKey && forbidden;
};

/** Concrete GET-only owner-bound Vercel inventory. This is not an operational-ready factory. */
export const readHostedOperatorProviderInventory = async (input: {
  assertCurrentOwner: () => Promise<void>;
  configuration: OperatorInventoryConfiguration;
  context: HostedOperatorContext;
  fetch?: typeof fetch;
  readVercelCredential: CredentialReader;
  signal?: AbortSignal;
}) => {
  try {
    const authority = hostedTenantAuthoritySchema.parse(input.context.authority);
    const { target } = input.context;
    const config = input.configuration;
    const invalidConfiguration = [
      new Set([config.app.projectId, config.gateway.projectId, config.operator.projectId]).size !==
        3,
      config.app.projectId !== target.projectId,
      config.app.branch !== target.branch,
      config.gateway.branch !== target.branch,
      config.app.environment !== "preview",
      config.gateway.environment !== "preview",
    ].some(Boolean);
    if (invalidConfiguration) {
      throw new HostedOperatorError("resource_mismatch");
    }
    await input.assertCurrentOwner();
    const credential = await input.readVercelCredential({
      authority,
      installationId: target.installationId,
    });
    if (credential === undefined) {
      throw new HostedOperatorError("authorization_required");
    }
    const invalidCredential = [
      !credential.binding.active,
      credential.binding.installationId !== target.installationId,
      credential.binding.scopeId !== target.scopeId,
      credential.binding.scopeType !== target.scopeType,
    ].some(Boolean);
    if (invalidCredential) {
      throw new HostedOperatorError("authorization_required");
    }
    const fetcher = input.fetch ?? fetch;
    const request = async (
      path: string,
      query: Record<string, string> = {},
    ): Promise<MarketplaceJsonValue> => {
      await input.assertCurrentOwner();
      const url = new URL(path, "https://api.vercel.com");
      if (target.scopeType === "team") {
        url.searchParams.set("teamId", target.scopeId);
      }
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
      const options: RequestInit = {
        cache: "no-store",
        headers: { Authorization: `Bearer ${credential.token}` },
        method: "GET",
        redirect: "error",
      };
      if (input.signal !== undefined) {
        options.signal = input.signal;
      }
      const response = await fetcher(url, options);
      if (!response.ok) {
        await response.body?.cancel();
        throw new HostedOperatorError(
          response.status === 401 || response.status === 403
            ? "authorization_required"
            : "operator_unavailable",
        );
      }
      return json.parse(await response.json());
    };
    const observe = async (reference: OperatorDeploymentReference, branch?: string) => {
      const project = projectSchema.parse(
        await request(`/v9/projects/${encodeURIComponent(reference.projectId)}`),
      );
      const deployment = deploymentSchema.parse(
        await request(`/v13/deployments/${encodeURIComponent(reference.deploymentId)}`, {
          withGitRepoInfo: "true",
        }),
      );
      const invalidDeployment = [
        project.id !== reference.projectId,
        project.accountId !== target.scopeId,
        deployment.projectId !== project.id,
        deployment.id !== reference.deploymentId,
        deployment.ownerId !== undefined && deployment.ownerId !== target.scopeId,
        deployment.readyState !== "READY",
        deployment.target !== (reference.environment === "production" ? "production" : null),
        branch !== undefined && deployment.gitSource?.ref !== branch,
      ].some(Boolean);
      if (invalidDeployment) {
        throw new HostedOperatorError("resource_mismatch");
      }
      const query: Record<string, string> = {};
      if (branch !== undefined) {
        query.gitBranch = branch;
      }
      const variables = variablesSchema.parse(
        await request(`/v10/projects/${encodeURIComponent(project.id)}/env`, query),
      );
      const projected = variables.envs.filter((variable) => {
        if (!variable.target.includes(reference.environment)) {
          return false;
        }
        const inherited = variable.gitBranch === null || variable.gitBranch === undefined;
        return reference.environment !== "preview" || inherited || variable.gitBranch === branch;
      });
      const projectKeys = projected
        .flatMap((variable) => (keyName.test(variable.key) ? [variable.key] : []))
        .toSorted();
      const deployedKeys =
        deployment.env !== undefined && deployment.env.every((key) => keyName.test(key))
          ? deployment.env.toSorted()
          : null;
      return {
        deployment,
        projected,
        summary: {
          branch: branch ?? null,
          deployedEnvironmentKeys: deployedKeys,
          deploymentId: deployment.id,
          environment: reference.environment,
          projectEnvironmentKeys: projectKeys,
          projectId: project.id,
        },
      };
    };
    const [app, gateway, operator] = await Promise.all([
      observe(config.app, config.app.branch),
      observe(config.gateway, config.gateway.branch),
      observe(config.operator),
    ]);
    const publicOrigin = origin(config.verification.publicOrigin);
    const gatewayOrigin = origin(config.verification.gatewayOrigin);
    const aliases = aliasSchema.parse(
      await request(`/v2/deployments/${encodeURIComponent(gateway.deployment.id)}/aliases`),
    );
    const ownedOrigins = new Set([
      origin(`https://${gateway.deployment.url}`),
      ...aliases.aliases.map((alias) => origin(`https://${alias.alias}`)),
    ]);
    if (!ownedOrigins.has(publicOrigin) || !ownedOrigins.has(gatewayOrigin)) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const jwksUrl = `${gatewayOrigin}/_platform/jwks.json`;
    let publicKeyIds: string[] | null = null;
    try {
      await input.assertCurrentOwner();
      // Never forward owner OAuth credentials to the public verification endpoint.
      const response = await fetcher(jwksUrl, {
        cache: "no-store",
        method: "GET",
        redirect: "error",
        signal: input.signal,
      });
      if (response.ok) {
        const value: unknown = await response.json();
        const privateKey = z
          .object({ keys: z.array(z.record(z.string(), z.unknown())) })
          .safeParse(value);
        const containsPrivateKey =
          privateKey.success &&
          privateKey.data.keys.some((key) =>
            ["d", "p", "q", "dp", "dq", "qi", "k"].some((field) => Object.hasOwn(key, field)),
          );
        const parsed = jwksSchema.safeParse(value);
        if (!containsPrivateKey && parsed.success && parsed.data.keys.length > 0) {
          publicKeyIds = parsed.data.keys.map((key) => key.kid);
        }
      } else {
        await response.body?.cancel();
      }
    } catch {
      /* Unavailable public keys remain unconfirmed, never ready. */
    }
    const configurations = [
      ...new Set(
        operator.projected.flatMap((variable) =>
          variable.key === "DATABASE_URL_UNPOOLED" && variable.configurationId !== undefined
            ? [variable.configurationId]
            : [],
        ),
      ),
    ];
    let nativeResource: { resourceId: string; neonProjectId: string } | null = null;
    if (configurations.length === 1 && configurations[0] !== undefined) {
      nativeResource = await readVercelManagedNeonResource({
        configurationId: configurations[0],
        fail: () => new HostedOperatorError("resource_mismatch"),
        projectId: config.operator.projectId,
        request,
        scopeId: target.scopeId,
      });
    }
    const appKey = `${target.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
    const forbiddenKeys = [
      ...new Set(
        [
          ...app.summary.projectEnvironmentKeys,
          ...(app.summary.deployedEnvironmentKeys ?? []),
        ].filter((key) => forbiddenAppKey(key, appKey)),
      ),
    ].toSorted();
    await input.assertCurrentOwner();
    return {
      app: app.summary,
      appEnvironment: {
        deployedKeyInventory:
          app.summary.deployedEnvironmentKeys === null
            ? ("unconfirmed" as const)
            : ("observed" as const),
        forbiddenKeys,
      },
      gateway: gateway.summary,
      nativeResource,
      operator: operator.summary,
      previewBranch: {
        reason: "native_branch_identity_and_synthetic_provenance_not_observed",
        status: "unconfirmed" as const,
      },
      protectedAppGrantPolicy: "unconfirmed" as const,
      scopeId: target.scopeId,
      scopeType: target.scopeType,
      verification: { gatewayOrigin, jwksUrl, publicKeyIds, publicOrigin },
    };
  } catch (error) {
    if (error instanceof HostedOperatorError) {
      throw error;
    }
    throw new HostedOperatorError("operator_unavailable");
  }
};
