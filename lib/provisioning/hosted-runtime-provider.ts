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
        method: body === undefined ? "GET" : "POST",
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
      if ([401, 403].includes(response.status)) {
        throw new HostedRuntimeProviderError("authorization_required");
      }
      if (response.status === 404) {
        throw new HostedRuntimeProviderError("connection_required");
      }
      throw new HostedRuntimeProviderError("provider_unavailable");
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
  const assertEnvironmentBindings = async (values: Readonly<Record<string, string>>) => {
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
      }),
    );
  };
  return {
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
    async bindEnvironment(values: Readonly<Record<string, string>>) {
      const keys = Object.keys(values);
      await request(
        `/v10/projects/${projectPath}/env`,
        { upsert: "true" },
        keys.map((key) => ({
          comment: `App Builder isolated runtime for ${input.target.appId}`,
          gitBranch: input.target.branch,
          key,
          target: ["preview"],
          type: "encrypted",
          value: values[key],
        })),
      );
      await assertEnvironmentBindings(values);
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
  };
};
