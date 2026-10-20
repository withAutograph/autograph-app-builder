import { z } from "zod";
import { isNativePreviewDeployment } from "./hosted-operator-deployment-delivery";
import type { readPreparedVercelAccess } from "../agent/prepared-provider-context";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { HostedOperatorError } from "./hosted-operator-contract";
import {
  reportOperatorInventoryReadFailure,
  reportOperatorPlanningMismatch,
  reportOperatorExecutionFailure,
} from "./hosted-operator-consent-diagnostic";
import type {
  HostedOperatorConsentDiagnosticSink,
  OperatorInventoryReadFailure,
} from "./hosted-operator-consent-diagnostic";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { readVercelManagedNeonResource } from "./hosted-runtime-marketplace-resource";
import type { MarketplaceJsonValue } from "./hosted-runtime-marketplace-resource";

type CredentialReader = Parameters<typeof readPreparedVercelAccess>[0]["readCredential"];
class MissingPlanningAliasError extends Error {
  override name = "MissingPlanningAliasError";
}

const id = z.string().min(1);
const projectSchema = z.object({ accountId: id, id });
const deploymentSchema = z.object({
  customEnvironment: z.unknown().optional(),
  env: z.array(z.string()).optional(),
  gitSource: z.object({ ref: id }).optional(),
  id,
  oidcTokenClaims: z.unknown().optional(),
  ownerId: id.optional(),
  projectId: id,
  readyState: id,
  target: z.string().nullable(),
  url: id,
});
const variableSchema = z.object({
  configurationId: z
    .string()
    .nullish()
    .transform((value) => value ?? undefined),
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
type InventoryReadTarget = OperatorInventoryReadFailure["target"];
type InventoryReadOperation = OperatorInventoryReadFailure["operation"];
const readWithDiagnostic = async <T>(
  sessionId: string,
  descriptor: Pick<OperatorInventoryReadFailure, "target" | "operation" | "phase" | "httpStatus">,
  sink: HostedOperatorConsentDiagnosticSink | undefined,
  read: () => Promise<T>,
): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    reportOperatorInventoryReadFailure(sessionId, descriptor, error, sink);
    throw error;
  }
};

export interface OperatorDeploymentReference {
  deploymentId?: string;
  environment: "preview" | "production";
  projectId: string;
}
export interface OperatorInventoryConfiguration {
  app: OperatorDeploymentReference & { branch: string };
  gateway: OperatorDeploymentReference & { branch: string };
  operator: OperatorDeploymentReference & { deploymentId: string };
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
const qualifiedGatewayOrigin = (
  configuredOrigin: string,
  deployment: z.infer<typeof deploymentSchema> | undefined,
  bootstrapPlanning: boolean,
  resolveGatewayByPublicOrigin: true | undefined,
): string => {
  // Only new planning follows the already qualified public alias to immutable source.
  // Frozen execution continues to use its exact configured transport endpoint.
  const currentGatewayTransport =
    bootstrapPlanning && resolveGatewayByPublicOrigin === true ? deployment : undefined;
  return origin(
    currentGatewayTransport === undefined
      ? configuredOrigin
      : `https://${currentGatewayTransport.url}`,
  );
};

const invalidDeploymentObservation = (input: {
  deployment: z.infer<typeof deploymentSchema>;
  reference: OperatorDeploymentReference;
  projectId: string;
  scopeId: string;
  branch?: string;
  resolveAlias: boolean;
}) => {
  const { deployment, reference, projectId, scopeId, branch, resolveAlias } = input;
  return {
    deployment_project: deployment.projectId !== projectId,
    deployment_identity: !resolveAlias && deployment.id !== reference.deploymentId,
    deployment_owner: deployment.ownerId !== undefined && deployment.ownerId !== scopeId,
    deployment_ready: deployment.readyState !== "READY",
    deployment_environment:
      reference.environment === "production"
        ? deployment.target !== "production"
        : !isNativePreviewDeployment(deployment),
    deployment_branch: branch !== undefined && deployment.gitSource?.ref !== branch,
  };
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

interface ObservedOperatorProject {
  branch: string | null;
  deployedEnvironmentKeys: string[] | null;
  deploymentId?: string;
  environment: "preview" | "production";
  projectEnvironmentKeys: string[];
  projectId: string;
}

interface PublicKeyReadbackInput {
  assertCurrentOwner: () => Promise<void>;
  fetcher: typeof fetch;
  jwksUrl: string;
  signal?: AbortSignal;
}
const readPublicKeyIds = async (input: PublicKeyReadbackInput): Promise<string[] | null> => {
  try {
    await input.assertCurrentOwner();
    // Never forward owner OAuth credentials to the public verification endpoint.
    const response = await input.fetcher(input.jwksUrl, {
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
        return parsed.data.keys.map((key) => key.kid);
      }
    } else {
      await response.body?.cancel();
    }
  } catch {
    /* Unavailable public keys remain unconfirmed, never ready. */
  }
  return null;
};

/** Concrete GET-only owner-bound Vercel inventory. This is not an operational-ready factory. */
export const readHostedOperatorProviderInventory = async (input: {
  assertCurrentOwner: () => Promise<void>;
  configuration: OperatorInventoryConfiguration;
  /** Trusted composition only: project inventory before first approved delivery. */
  phase?: "bootstrap-planning";
  /** New plan creation only; approved operations retain their exact deployment reference. */
  resolveGatewayByPublicOrigin?: true;
  /** The app ref from the already approved delivery plan; resource identity stays unchanged. */
  approvedAppBranch?: string;
  context: HostedOperatorContext;
  fetch?: typeof fetch;
  readVercelCredential: CredentialReader;
  diagnosticSink?: HostedOperatorConsentDiagnosticSink;
  signal?: AbortSignal;
  // oxlint-disable-next-line complexity, sonarjs(cognitive-complexity) -- Bounded inventory coordinator retains existing read ordering.
}) => {
  try {
    const authority = hostedTenantAuthoritySchema.parse(input.context.authority);
    const { target } = input.context;
    const config = input.configuration;
    const bootstrapPlanning = input.phase === "bootstrap-planning";
    const invalidConfiguration = {
      project_separation:
        new Set([config.app.projectId, config.gateway.projectId, config.operator.projectId])
          .size !== 3,
      app_project: config.app.projectId !== target.projectId,
      app_branch: config.app.branch !== (input.approvedAppBranch ?? target.branch),
      app_environment: config.app.environment !== "preview",
      gateway_environment: config.gateway.environment !== "preview",
    };
    if (Object.values(invalidConfiguration).some(Boolean)) {
      reportOperatorPlanningMismatch(
        target.sessionId,
        "inventory_configuration",
        invalidConfiguration,
      );
      throw new HostedOperatorError("resource_mismatch");
    }
    await readWithDiagnostic(
      target.sessionId,
      {
        target: "inventory",
        operation: "owner",
        phase: "owner",
      },
      input.diagnosticSink,
      () => input.assertCurrentOwner(),
    );
    const credential = await readWithDiagnostic(
      target.sessionId,
      {
        target: "inventory",
        operation: "credential",
        phase: "credential",
      },
      input.diagnosticSink,
      () =>
        input.readVercelCredential({
          authority,
          installationId: target.installationId,
        }),
    );
    if (credential === undefined) {
      const error = new HostedOperatorError("authorization_required");
      reportOperatorInventoryReadFailure(
        target.sessionId,
        {
          target: "inventory",
          operation: "credential",
          phase: "credential",
        },
        error,
        input.diagnosticSink,
      );
      throw error;
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
    const parseRead = <T>(
      targetName: Exclude<InventoryReadTarget, "inventory">,
      operation: InventoryReadOperation,
      parse: () => T,
    ): T => {
      try {
        return parse();
      } catch (error) {
        reportOperatorInventoryReadFailure(
          target.sessionId,
          {
            target: targetName,
            operation,
            phase: "schema",
          },
          error,
          input.diagnosticSink,
        );
        throw error;
      }
    };
    const request = async (
      path: string,
      query: Record<string, string> = {},
      allowMissing = false,
      operation: InventoryReadOperation = "project",
      readTarget: InventoryReadTarget = "inventory",
    ): Promise<MarketplaceJsonValue> => {
      await readWithDiagnostic(
        target.sessionId,
        {
          target: readTarget,
          operation: "owner",
          phase: "owner",
        },
        input.diagnosticSink,
        () => input.assertCurrentOwner(),
      );
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
      const response = await readWithDiagnostic(
        target.sessionId,
        {
          target: readTarget,
          operation,
          phase: "fetch",
        },
        input.diagnosticSink,
        () => fetcher(url, options),
      );
      if (!response.ok) {
        if (allowMissing && response.status === 404) {
          await response.body?.cancel();
          throw new MissingPlanningAliasError();
        }
        const error = new HostedOperatorError(
          response.status === 401 || response.status === 403
            ? "authorization_required"
            : "operator_unavailable",
        );
        reportOperatorInventoryReadFailure(
          target.sessionId,
          {
            target: readTarget,
            operation,
            phase: "http_response",
            httpStatus: response.status,
          },
          error,
          input.diagnosticSink,
        );
        await response.body?.cancel();
        throw error;
      }
      const body = await readWithDiagnostic(
        target.sessionId,
        {
          target: readTarget,
          operation,
          phase: "json_decode",
          httpStatus: response.status,
        },
        input.diagnosticSink,
        async () => z.unknown().parse(await response.json()),
      );
      try {
        return json.parse(body);
      } catch (error) {
        reportOperatorInventoryReadFailure(
          target.sessionId,
          {
            target: readTarget,
            operation,
            phase: "schema",
            httpStatus: response.status,
          },
          error,
          input.diagnosticSink,
        );
        throw error;
      }
    };
    const observe = async (
      targetName: "app" | "gateway" | "operator",
      reference: OperatorDeploymentReference,
      branch?: string,
      allowUndelivered = false,
      planningAlias?: string,
    ) => {
      const projectPayload = await request(
        `/v9/projects/${encodeURIComponent(reference.projectId)}`,
        {},
        false,
        "project",
        targetName,
      );
      const project = parseRead(targetName, "project", () => projectSchema.parse(projectPayload));
      const invalidProject = {
        project_identity: project.id !== reference.projectId,
        project_owner: project.accountId !== target.scopeId,
      };
      if (Object.values(invalidProject).some(Boolean)) {
        reportOperatorPlanningMismatch(target.sessionId, "inventory_project", invalidProject);
        throw new HostedOperatorError("resource_mismatch");
      }
      let deployment: z.infer<typeof deploymentSchema> | undefined;
      const deploymentReference = planningAlias ?? reference.deploymentId;
      if (deploymentReference !== undefined) {
        try {
          const deploymentPayload = await request(
            `/v13/deployments/${encodeURIComponent(deploymentReference)}`,
            { withGitRepoInfo: "true" },
            planningAlias !== undefined && allowUndelivered && bootstrapPlanning,
            planningAlias === undefined ? "deployment" : "public_alias",
            targetName,
          );
          deployment = parseRead(
            targetName,
            planningAlias === undefined ? "deployment" : "public_alias",
            () => deploymentSchema.parse(deploymentPayload),
          );
        } catch (error) {
          if (!(error instanceof MissingPlanningAliasError)) {
            throw error;
          }
        }
      }
      if (deployment !== undefined) {
        const invalidDeployment = invalidDeploymentObservation({
          deployment,
          reference,
          projectId: project.id,
          scopeId: target.scopeId,
          branch,
          resolveAlias: planningAlias !== undefined,
        });
        if (Object.values(invalidDeployment).some(Boolean)) {
          reportOperatorPlanningMismatch(
            target.sessionId,
            "inventory_deployment",
            invalidDeployment,
          );
          throw new HostedOperatorError("resource_mismatch");
        }
      } else if (!allowUndelivered || !bootstrapPlanning) {
        reportOperatorPlanningMismatch(target.sessionId, "inventory_deployment", {
          deployment_missing: true,
        });
        throw new HostedOperatorError("resource_mismatch");
      }
      const variablesPayload = await request(
        `/v10/projects/${encodeURIComponent(project.id)}/env`,
        {},
        false,
        "environment",
        targetName,
      );
      const variables = parseRead(targetName, "environment", () =>
        variablesSchema.parse(variablesPayload),
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
        deployment?.env !== undefined && deployment.env.every((key) => keyName.test(key))
          ? deployment.env.toSorted()
          : null;
      const summary: ObservedOperatorProject = {
        branch: branch ?? null,
        deployedEnvironmentKeys: deployedKeys,
        environment: reference.environment,
        projectEnvironmentKeys: projectKeys,
        projectId: project.id,
      };
      if (deployment !== undefined) {
        summary.deploymentId = deployment.id;
      }
      return { deployment, projected, summary };
    };
    const [app, gateway, operator] = await Promise.all([
      observe("app", config.app, config.app.branch, true),
      observe(
        "gateway",
        config.gateway,
        config.gateway.branch,
        true,
        bootstrapPlanning && input.resolveGatewayByPublicOrigin === true
          ? new URL(origin(config.verification.publicOrigin)).hostname
          : undefined,
      ),
      observe("operator", config.operator),
    ]);
    const publicOrigin = origin(config.verification.publicOrigin);
    const gatewayOrigin = qualifiedGatewayOrigin(
      config.verification.gatewayOrigin,
      gateway.deployment,
      bootstrapPlanning,
      input.resolveGatewayByPublicOrigin,
    );
    if (gateway.deployment !== undefined) {
      const aliasesPayload = await request(
        `/v2/deployments/${encodeURIComponent(gateway.deployment.id)}/aliases`,
        {},
        false,
        "aliases",
        "gateway",
      );
      const aliases = parseRead("gateway", "aliases", () => aliasSchema.parse(aliasesPayload));
      const ownedOrigins = new Set([
        origin(`https://${gateway.deployment.url}`),
        ...aliases.aliases.map((alias) => origin(`https://${alias.alias}`)),
      ]);
      const ownsGatewayOrigin = ownedOrigins.has(gatewayOrigin);
      let ownsPublicOrigin = ownedOrigins.has(publicOrigin);
      if (ownsGatewayOrigin && !ownsPublicOrigin) {
        // A browser alias can advance while the approved immutable transport remains valid.
        // Resolve only the trusted configured hostname through the owner-scoped provider API.
        const publicDeploymentPayload = await request(
          `/v13/deployments/${encodeURIComponent(new URL(publicOrigin).hostname)}`,
          {
            withGitRepoInfo: "true",
          },
          false,
          "public_alias",
          "gateway",
        );
        const publicDeployment = parseRead("gateway", "public_alias", () =>
          deploymentSchema.parse(publicDeploymentPayload),
        );
        const invalidPublicDeployment = invalidDeploymentObservation({
          deployment: publicDeployment,
          reference: config.gateway,
          projectId: gateway.summary.projectId,
          scopeId: target.scopeId,
          branch: config.gateway.branch,
          resolveAlias: true,
        });
        ownsPublicOrigin = !Object.values(invalidPublicDeployment).some(Boolean);
      }
      const invalidOrigins = {
        public_origin: !ownsPublicOrigin,
        gateway_origin: !ownsGatewayOrigin,
      };
      if (Object.values(invalidOrigins).some(Boolean)) {
        reportOperatorPlanningMismatch(target.sessionId, "gateway_origin", invalidOrigins);
        throw new HostedOperatorError("resource_mismatch");
      }
    }
    const jwksUrl = `${gatewayOrigin}/_platform/jwks.json`;
    const publicKeyIds =
      gateway.deployment === undefined
        ? null
        : await readPublicKeyIds({
            assertCurrentOwner: input.assertCurrentOwner,
            fetcher,
            jwksUrl,
            signal: input.signal,
          });
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
        fail: () => {
          reportOperatorPlanningMismatch(target.sessionId, "inventory_project", {
            native_store_binding: true,
          });
          return new HostedOperatorError("resource_mismatch");
        },
        projectId: config.operator.projectId,
        request: (path) =>
          request(
            path,
            {},
            false,
            path === "/v1/storage/stores" ? "store_list" : "store_detail",
            "operator",
          ),
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
    if (input.phase !== "bootstrap-planning") {
      reportOperatorExecutionFailure(
        input.context.target.sessionId,
        "final_inventory_readback",
        error,
      );
    }
    if (error instanceof HostedOperatorError) {
      throw error;
    }
    throw new HostedOperatorError("operator_unavailable");
  }
};
