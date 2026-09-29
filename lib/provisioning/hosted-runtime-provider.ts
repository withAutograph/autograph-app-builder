import { z } from "zod";

import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import type { HostedRuntimeTarget } from "./hosted-runtime-journal";

export type HostedRuntimeBlockerCode =
  | "authorization_required"
  | "connection_required"
  | "provider_unavailable"
  | "resource_mismatch";
export class HostedRuntimeProviderError extends Error {
  readonly code: HostedRuntimeBlockerCode;
  constructor(code: HostedRuntimeBlockerCode) {
    super(code);
    this.name = "HostedRuntimeProviderError";
    this.code = code;
  }
}

const environmentSchema = z.looseObject({
  comment: z.string().nullable().optional(),
  configurationId: z.string().optional(),
  gitBranch: z.string().nullable().optional(),
  id: z.string().min(1),
  key: z.string().min(1),
  target: z.union([z.string(), z.array(z.string())]).optional(),
  value: z.string().optional(),
});
const providerJsonSchema = z.json();
interface RuntimeVariableInput {
  comment: string;
  gitBranch: string;
  key: string;
  target: ["preview"];
  type: "encrypted";
  value: string;
}
const environmentsSchema = z.union([
  z.array(environmentSchema),
  z.object({ envs: z.array(environmentSchema) }).transform(({ envs }) => envs),
]);

const exactPreviewVariable = (environment: z.infer<typeof environmentSchema>, branch: string) =>
  environment.gitBranch === branch &&
  (Array.isArray(environment.target)
    ? environment.target.length === 1 && environment.target[0] === "preview"
    : environment.target === "preview");
const hasPreviewTarget = (environment: z.infer<typeof environmentSchema>) =>
  Array.isArray(environment.target)
    ? environment.target.includes("preview")
    : environment.target === "preview";
const normalizeEndpoint = (hostname: string) => hostname.replace(/-pooler(?=\.)/u, "");

/** Returns the original verified TLS admin endpoint only to server-side orchestration. */
export const parseNativeNeonRuntimeEndpoint = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HostedRuntimeProviderError("connection_required");
  }
  const hasCredentials = url.username !== "" && url.password !== "";
  const verifiedNativeEndpoint =
    url.hostname.endsWith(".neon.tech") && !url.hostname.split(".")[0]?.endsWith("-pooler");
  const verifiedTls = ["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
  if (
    !hasCredentials ||
    !verifiedNativeEndpoint ||
    !verifiedTls ||
    !["postgres:", "postgresql:"].includes(url.protocol)
  ) {
    throw new HostedRuntimeProviderError("connection_required");
  }
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
};

export const createHostedRuntimeVercelProvider = (input: {
  target: HostedRuntimeTarget;
  credential: { binding: VercelInstallationBinding; token: string };
  fetch?: typeof fetch;
  signal?: AbortSignal;
}) => {
  const { binding } = input.credential;
  if (
    !binding.active ||
    binding.installationId !== input.target.installationId ||
    binding.scopeId !== input.target.scopeId ||
    binding.scopeType !== input.target.scopeType
  ) {
    throw new HostedRuntimeProviderError("authorization_required");
  }
  const projectPath = encodeURIComponent(input.target.projectId);
  const request = async (
    path: string,
    query: Record<string, string> = {},
    body?: RuntimeVariableInput[],
    method: "GET" | "POST" | "DELETE" = body === undefined ? "GET" : "POST",
  ) => {
    const url = new URL(path, "https://api.vercel.com");
    if (binding.scopeType === "team") {
      url.searchParams.set("teamId", binding.scopeId);
    }
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    let response: Response;
    try {
      const options: RequestInit = {
        cache: "no-store",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.credential.token}`,
          "Content-Type": "application/json",
        },
        method,
        redirect: "error",
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      };
      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }
      response = await (input.fetch ?? fetch)(url, options);
    } catch {
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (method === "DELETE" && response.status === 404) {
        return null;
      }
      if ([401, 403].includes(response.status)) {
        throw new HostedRuntimeProviderError("authorization_required");
      }
      if (response.status === 404) {
        throw new HostedRuntimeProviderError("connection_required");
      }
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
    if (method === "DELETE") {
      await response.body?.cancel();
      return null;
    }
    try {
      return providerJsonSchema.parse(await response.json());
    } catch {
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
  };
  const environments = async () => {
    try {
      return environmentsSchema.parse(
        await request(`/v10/projects/${projectPath}/env`, { gitBranch: input.target.branch }),
      );
    } catch (error) {
      if (error instanceof HostedRuntimeProviderError) {
        throw error;
      }
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
  };
  const decrypted = async (id: string, allowGlobalGuard = false) => {
    const result = environmentSchema.safeParse(
      await request(`/v1/projects/${projectPath}/env/${encodeURIComponent(id)}`),
    );
    if (!result.success || result.data.value === undefined || result.data.value === "") {
      throw new HostedRuntimeProviderError("provider_unavailable");
    }
    const guardScope =
      allowGlobalGuard &&
      hasPreviewTarget(result.data) &&
      (result.data.gitBranch === undefined || result.data.gitBranch === null);
    if (
      result.data.id !== id ||
      (!exactPreviewVariable(result.data, input.target.branch) && !guardScope)
    ) {
      throw new HostedRuntimeProviderError("resource_mismatch");
    }
    return result.data;
  };
  const runtimeComment = (runtimeId: string) => {
    if (runtimeId === "") {
      throw new HostedRuntimeProviderError("resource_mismatch");
    }
    return `App Builder runtime ${runtimeId}`;
  };
  const selectedBindings = (
    observed: z.infer<typeof environmentsSchema>,
    keys: readonly string[],
    runtimeId?: string,
    preserveForeign = false,
  ) => {
    const comment = runtimeId === undefined ? undefined : runtimeComment(runtimeId);
    const selected = new Map<string, z.infer<typeof environmentSchema>>();
    for (const key of keys) {
      const matches = observed.filter(
        (environment) =>
          environment.key === key &&
          environment.gitBranch === input.target.branch &&
          hasPreviewTarget(environment),
      );
      const [match] = matches;
      if (matches.length > 1) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      if (match === undefined) {
        continue;
      }
      const integrationOwned = match.configurationId !== undefined && match.configurationId !== "";
      const wrongOwner = comment !== undefined && match.comment !== comment;
      if (!exactPreviewVariable(match, input.target.branch) || integrationOwned) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      if (wrongOwner && !preserveForeign) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      if (!wrongOwner) {
        selected.set(key, match);
      }
    }
    if (new Set([...selected.values()].map(({ id }) => id)).size !== selected.size) {
      throw new HostedRuntimeProviderError("resource_mismatch");
    }
    return selected;
  };
  const assertEnvironmentAvailability = async (keys: string[], runtimeId: string) => {
    selectedBindings(await environments(), keys, runtimeId);
  };
  const assertEnvironmentBindings = async (
    values: Readonly<Record<string, string>>,
    options?: { runtimeId: string },
  ) => {
    const observed = await environments();
    await Promise.all(
      Object.keys(values).map(async (key) => {
        const matches = observed.filter(
          (environment) =>
            environment.key === key && exactPreviewVariable(environment, input.target.branch),
        );
        const [match] = matches;
        if (matches.length !== 1 || match === undefined) {
          throw new HostedRuntimeProviderError("resource_mismatch");
        }
        const secret = await decrypted(match.id);
        if (secret.key !== key || secret.value !== values[key]) {
          throw new HostedRuntimeProviderError("resource_mismatch");
        }
        if (
          options !== undefined &&
          (selectedBindings([match], [key], options.runtimeId).size !== 1 ||
            selectedBindings([secret], [key], options.runtimeId).size !== 1)
        ) {
          throw new HostedRuntimeProviderError("resource_mismatch");
        }
      }),
    );
  };
  return {
    assertEnvironmentAvailability,
    assertEnvironmentBindings,
    async assertProject() {
      const project = z
        .object({
          accountId: z.string(),
          framework: z.literal("services"),
          id: z.string(),
          rootDirectory: z.string().nullable(),
        })
        .safeParse(await request(`/v9/projects/${projectPath}`));
      if (
        !project.success ||
        project.data.id !== input.target.projectId ||
        project.data.accountId !== binding.scopeId ||
        ![null, "", "."].includes(project.data.rootDirectory)
      ) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
    },
    async bindEnvironment(
      values: Readonly<Record<string, string>>,
      options?: { runtimeId: string },
    ) {
      const keys = Object.keys(values);
      if (keys.length === 0) {
        return [];
      }
      const selected = selectedBindings(await environments(), keys, options?.runtimeId);
      const write = async (selectedKeys: string[], upsert: boolean) => {
        if (selectedKeys.length === 0) {
          return;
        }
        await request(
          `/v10/projects/${projectPath}/env`,
          { upsert: String(upsert) },
          selectedKeys.map((key) => ({
            comment:
              options === undefined
                ? `App Builder isolated runtime for ${input.target.appId}`
                : runtimeComment(options.runtimeId),
            gitBranch: input.target.branch,
            key,
            target: ["preview"],
            type: "encrypted",
            value: values[key],
          })),
        );
      };
      if (options === undefined) {
        await write(keys, true);
      } else {
        // A concurrent creator cannot acquire ownership by overwriting an existing key.
        await write(
          keys.filter((key) => !selected.has(key)),
          false,
        );
        await write(
          keys.filter((key) => selected.has(key)),
          true,
        );
      }
      await assertEnvironmentBindings(values, options);
      return keys;
    },
    async readClusterCredential() {
      const observed = await environments();
      const candidates = observed.filter(
        (environment) =>
          environment.key === "DATABASE_URL_UNPOOLED" &&
          exactPreviewVariable(environment, input.target.branch) &&
          environment.configurationId !== undefined &&
          environment.configurationId !== "",
      );
      if (candidates.length !== 1) {
        throw new HostedRuntimeProviderError("connection_required");
      }
      const [reference] = candidates;
      if (reference === undefined) {
        throw new HostedRuntimeProviderError("connection_required");
      }
      const secret = await decrypted(reference.id);
      if (secret.configurationId !== reference.configurationId || secret.key !== reference.key) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      const guards = observed.filter(
        (environment) =>
          environment.key === "AUTH_PRODUCTION_DATABASE_IDENTITY" && hasPreviewTarget(environment),
      );
      const branchGuards = guards.filter(
        (environment) => environment.gitBranch === input.target.branch,
      );
      const [guard] =
        branchGuards.length === 0
          ? guards.filter(
              (environment) =>
                environment.gitBranch === undefined || environment.gitBranch === null,
            )
          : branchGuards;
      const guardCount =
        branchGuards.length === 0
          ? guards.filter(
              (environment) =>
                environment.gitBranch === undefined || environment.gitBranch === null,
            ).length
          : branchGuards.length;
      if (guard === undefined || guardCount !== 1) {
        throw new HostedRuntimeProviderError("connection_required");
      }
      const productionGuard = await decrypted(guard.id, true);
      if (
        productionGuard.key !== "AUTH_PRODUCTION_DATABASE_IDENTITY" ||
        !/^[a-z0-9.-]+\.neon\.tech\/[a-zA-Z0-9_.-]+$/u.test(productionGuard.value ?? "")
      ) {
        throw new HostedRuntimeProviderError("connection_required");
      }
      const clusterUrl = parseNativeNeonRuntimeEndpoint(secret.value ?? "");
      const productionHost = (productionGuard.value ?? "").split("/")[0] ?? "";
      if (normalizeEndpoint(new URL(clusterUrl).hostname) === normalizeEndpoint(productionHost)) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      return {
        clusterUrl,
        productionDatabaseIdentity: productionGuard.value ?? "",
        reference: {
          configurationId: z.string().min(1).parse(reference.configurationId),
          environmentId: reference.id,
        },
      };
    },
    async removeEnvironmentBindings(
      values: Readonly<Record<string, string>>,
      options: { runtimeId: string; preserveForeign?: boolean },
    ) {
      const keys = Object.keys(values);
      if (keys.length === 0) {
        return [];
      }
      const selected = selectedBindings(
        await environments(),
        keys,
        options.runtimeId,
        options.preserveForeign,
      );
      // Validate the complete removal before the first effect. A retry may observe keys
      // already removed by an earlier attempt, while every remaining key must still belong.
      await Promise.all(
        [...selected].map(async ([key, match]) => {
          const secret = await decrypted(match.id);
          if (
            secret.key !== key ||
            secret.value !== values[key] ||
            selectedBindings([secret], [key], options.runtimeId).size !== 1
          ) {
            throw new HostedRuntimeProviderError("resource_mismatch");
          }
        }),
      );
      const removals = await Promise.allSettled(
        [...selected.values()].map(
          async ({ id }) =>
            await request(
              `/v9/projects/${projectPath}/env/${encodeURIComponent(id)}`,
              {},
              undefined,
              "DELETE",
            ),
        ),
      );
      const failed = removals.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
      const remaining = await environments();
      if (
        selectedBindings(remaining, keys, options.runtimeId, options.preserveForeign).size !== 0
      ) {
        throw new HostedRuntimeProviderError("resource_mismatch");
      }
      return options.preserveForeign === true ? [...selected.keys()] : keys;
    },
  };
};

/** Re-read native isolation immediately before each approved provider/database effect. */
export const assertHostedRuntimeCluster = async (
  provider: Pick<ReturnType<typeof createHostedRuntimeVercelProvider>, "readClusterCredential">,
  expectedClusterUrl: string,
) => {
  const cluster = await provider.readClusterCredential();
  if (cluster.clusterUrl !== expectedClusterUrl) {
    throw new HostedRuntimeProviderError("resource_mismatch");
  }
  return cluster;
};
