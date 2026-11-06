import { randomBytes } from "node:crypto";

import { z } from "zod";

import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import { vercelProvisionDiagnosticSchema } from "./contracts";
import type {
  VercelProvisionDiagnostic,
  GitHubProvisionResult,
  VercelProvisionResult,
} from "./contracts";
import { suffixedProviderName } from "./names";
import { runSequentiallyUntilAsync } from "../async-sequential.ts";

const projectSchema = z.looseObject({
  framework: z.literal("services"),
  id: z.string().min(1),
  link: z
    .looseObject({
      org: z.string().min(1),
      repo: z.string().min(1),
      type: z.literal("github"),
    })
    .optional(),
  name: z.string().min(1),
  oidcTokenConfig: z
    .looseObject({ enabled: z.boolean(), issuerMode: z.string() })
    .nullable()
    .optional(),
  rootDirectory: z.string().min(1),
  ssoProtection: z.looseObject({ deploymentType: z.string() }).nullable().optional(),
});

const PUBLIC_APP_DEPLOYMENT_TYPE = "prod_deployment_urls_and_all_previews";
const PROJECT_ALREADY_EXISTS = "project_already_exists";
const NAME_ALREADY_EXISTS = "name_already_exists";
const CREDENTIAL_REJECTED = "credential-rejected";
const PROVIDER_RATE_LIMITED = "provider-rate-limited";
const PROVIDER_PERMISSION_DENIED = "provider-permission-denied";
const PUBLIC_APP_POLICY = {
  oidcTokenConfig: { enabled: true, issuerMode: "team" },
  ssoProtection: { deploymentType: PUBLIC_APP_DEPLOYMENT_TYPE },
};

function suffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(6)].map((value) => alphabet[value % alphabet.length]).join("");
}

function isProviderErrorStatus(status: number) {
  return status >= 400 && status <= 599;
}

function requestFailed(status: number, method: "GET" | "POST" | undefined) {
  if (!isProviderErrorStatus(status) || status === 409) {
    return false;
  }
  return method === "POST" || status !== 404;
}

function isPublicAppAccess(access: "public-app" | undefined) {
  return access === "public-app";
}

function hasPublicAppPolicy(project: z.infer<typeof projectSchema>) {
  const { ssoProtection: protection, oidcTokenConfig: tokenConfig } = project;
  if (
    protection === null ||
    protection === undefined ||
    tokenConfig === null ||
    tokenConfig === undefined
  ) {
    return false;
  }
  return (
    protection.deploymentType === PUBLIC_APP_DEPLOYMENT_TYPE &&
    tokenConfig.enabled &&
    tokenConfig.issuerMode === "team"
  );
}

function hasMatchingRepository(project: z.infer<typeof projectSchema>, repository: string) {
  const { link } = project;
  return link !== undefined && `${link.org}/${link.repo}` === repository;
}

function projectMatches(input: {
  project: z.infer<typeof projectSchema>;
  candidate: string;
  deploymentAccess?: "public-app";
  linkedRepository: string | undefined;
}) {
  const { project, candidate, deploymentAccess, linkedRepository } = input;
  if (project.name !== candidate || project.rootDirectory !== ".") {
    return false;
  }
  if (isPublicAppAccess(deploymentAccess) && !hasPublicAppPolicy(project)) {
    return false;
  }
  if (linkedRepository === undefined) {
    return project.link === undefined;
  }
  return hasMatchingRepository(project, linkedRepository);
}

interface ProjectCreateBody {
  framework: "services";
  name: string;
  rootDirectory: ".";
  oidcTokenConfig?: { enabled: true; issuerMode: "team" };
  ssoProtection?: { deploymentType: typeof PUBLIC_APP_DEPLOYMENT_TYPE };
  gitRepository?: { repo: string; type: "github" };
}

function projectCreationBody(
  candidate: string,
  input: {
    deploymentAccess?: "public-app";
    linkedRepository: string | undefined;
  },
) {
  const body: ProjectCreateBody = {
    framework: "services",
    name: candidate,
    rootDirectory: ".",
  };
  const { deploymentAccess, linkedRepository: repository } = input;
  if (isPublicAppAccess(deploymentAccess)) {
    body.oidcTokenConfig = PUBLIC_APP_POLICY.oidcTokenConfig;
    body.ssoProtection = PUBLIC_APP_POLICY.ssoProtection;
  }
  if (repository !== undefined && repository !== "") {
    body.gitRepository = { repo: repository, type: "github" };
  }
  return body;
}

function withDiagnostic<T extends { status: "failed" }>(
  result: T,
  diagnostic: VercelProvisionDiagnostic | undefined,
): T & { providerDiagnostic?: VercelProvisionDiagnostic } {
  if (diagnostic !== undefined) {
    result.providerDiagnostic = diagnostic;
  }
  return result;
}

function recordRetryAfter(
  response: Response,
  record: ((milliseconds: number) => void) | undefined,
) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) {
    return;
  }
  const seconds = Number(retryAfter);
  const milliseconds = Number.isFinite(seconds)
    ? Math.ceil(seconds * 1000)
    : Date.parse(retryAfter) - Date.now();
  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    record?.(milliseconds);
  }
}

function parseRequestRef(response: Response) {
  return vercelProvisionDiagnosticSchema.shape.requestRef.safeParse(
    response.headers.get("x-vercel-id"),
  );
}

function validateResponseStatus(status: number, expected: ReadonlySet<number>) {
  if (status === 401) {
    throw new Error(CREDENTIAL_REJECTED);
  }
  if (expected.has(status)) {
    return;
  }
  if (status === 429) {
    throw new Error(PROVIDER_RATE_LIMITED);
  }
  if (status === 403) {
    throw new Error(PROVIDER_PERMISSION_DENIED);
  }
  throw new Error(`vercel-status-${status}`);
}

function createProjectFailure(status: number, diagnostic: VercelProvisionDiagnostic | undefined) {
  let code: "provider_validation_failed" | "provider_permission_denied" | "provider_rate_limited" =
    "provider_validation_failed";
  if (status === 403) {
    code = "provider_permission_denied";
  }
  if (status === 429) {
    code = "provider_rate_limited";
  }
  return withDiagnostic({ code, retryable: status === 429, status: "failed" }, diagnostic);
}

async function createVercelProject(
  candidate: string,
  body: ProjectCreateBody,
  create: (args: {
    body: ProjectCreateBody;
    expected: ReadonlySet<number>;
    method: "POST";
    path: string;
  }) => Promise<{ body: unknown; status: number }>,
  inspect: (name: string) => Promise<{ body: unknown; status: number }>,
) {
  const created = await create({
    body,
    expected: new Set([200, 201, 400, 403, 409, 429]),
    method: "POST",
    path: "/v11/projects",
  });
  if (created.status !== 409) {
    return { created, recovered: null };
  }
  const recovered = await inspect(candidate);
  return { created, recovered };
}

function failureForError(
  failure: string,
  diagnostic: VercelProvisionDiagnostic | undefined,
): VercelProvisionResult {
  if (failure === PROVIDER_RATE_LIMITED) {
    return withDiagnostic(
      { code: "provider_rate_limited", retryable: true, status: "failed" },
      diagnostic,
    );
  }
  if (failure === PROVIDER_PERMISSION_DENIED) {
    return withDiagnostic(
      { code: "provider_permission_denied", retryable: false, status: "failed" },
      diagnostic,
    );
  }
  const code = failure === CREDENTIAL_REJECTED ? "credential_unavailable" : "provider_unavailable";
  return withDiagnostic(
    {
      code,
      retryable: true,
      status: "failed",
    },
    diagnostic,
  );
}

async function reconcilePriorCandidates(
  candidates: readonly string[],
  absentCandidates: readonly string[],
  inspect: (name: string) => Promise<{ status: number }>,
) {
  const absent = new Set(absentCandidates);
  let uncertainWrite = false;
  for (const candidate of candidates) {
    if (!absent.has(candidate)) {
      continue;
    }
    uncertainWrite = true;
    const observed = await inspect(candidate);
    if (observed.status === 200) {
      return true;
    }
  }
  return uncertainWrite;
}

export async function provisionVercelProject(input: {
  installation: VercelInstallationBinding;
  token: string;
  appId: string;
  /** Absent on frozen legacy requests; those retain their inherited provider policy. */
  deploymentAccess?: "public-app";
  github: GitHubProvisionResult;
  githubSelected: boolean;
  persistedCandidates: readonly string[];
  persistedAbsentCandidates: readonly string[];
  /** Recheck every prior candidate before a retry can issue another write. */
  reconcilePriorWrite?: boolean;
  persistCandidate: (candidate: string) => Promise<void>;
  persistAbsent: (candidate: string) => Promise<void>;
  renewLease?: () => Promise<void>;
  recordRetryAfter?: (milliseconds: number) => void;
  fetch?: typeof fetch;
  generateSuffix?: () => string;
}): Promise<VercelProvisionResult> {
  if (input.githubSelected && input.github.status !== "succeeded") {
    return { code: "github_required", retryable: false, status: "skipped" };
  }
  const request = input.fetch ?? fetch;
  let providerDiagnostic: VercelProvisionDiagnostic | undefined;
  const query =
    input.installation.scopeType === "team"
      ? `?teamId=${encodeURIComponent(input.installation.scopeId)}`
      : "";

  async function vercel(args: {
    method?: "GET" | "POST";
    path: string;
    body?: unknown;
    expected: ReadonlySet<number>;
  }) {
    if (args.method === "POST") {
      await input.renewLease?.();
    }
    const init: RequestInit = {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${input.token}`,
        "Content-Type": "application/json",
        "User-Agent": "autograph-app-builder-provisioning",
      },
      method: args.method ?? "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    };
    const requestBody = args.body;
    if (requestBody !== undefined) {
      init.body = JSON.stringify(requestBody);
    }
    let response: Response;
    try {
      response = await request(`https://api.vercel.com${args.path}${query}`, init);
    } catch {
      throw new Error("provider-unavailable");
    }
    const failed = requestFailed(response.status, args.method);
    if (failed) {
      const requestRef = parseRequestRef(response);
      providerDiagnostic = { statusCode: response.status };
      if (requestRef.success) {
        providerDiagnostic.requestRef = requestRef.data;
      }
    }
    let body: unknown;
    try {
      body = response.body === null ? undefined : await response.json();
    } catch {
      if (!failed) {
        throw new Error("invalid-response");
      }
    }
    if (failed && providerDiagnostic !== undefined) {
      const error = z
        .object({ error: z.object({ code: vercelProvisionDiagnosticSchema.shape.code }) })
        .safeParse(body);
      if (error.success && error.data.error.code !== undefined) {
        providerDiagnostic.code = error.data.error.code;
      }
    }
    recordRetryAfter(response, input.recordRetryAfter);
    validateResponseStatus(response.status, args.expected);
    return { body, status: response.status };
  }

  async function inspect(name: string) {
    return await vercel({
      expected: new Set([200, 404]),
      path: `/v9/projects/${encodeURIComponent(name)}`,
    });
  }

  const baseName = `apps-${input.appId}`;
  const linkedRepository = input.github.status === "succeeded" ? input.github.fullName : undefined;
  if (input.reconcilePriorWrite === true) {
    try {
      const uncertainWrite = await reconcilePriorCandidates(
        input.persistedCandidates,
        input.persistedAbsentCandidates,
        inspect,
      );
      if (uncertainWrite) {
        // A 404 is not authoritative evidence that a previous POST did not commit.
        return { code: "reconciliation_uncertain", retryable: false, status: "failed" };
      }
    } catch {
      return { code: "provider_unavailable", retryable: true, status: "failed" };
    }
  }

  const candidates = async function* candidates(): AsyncGenerator<string> {
    const seen = new Set<string>();
    for (const candidate of input.persistedCandidates) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        yield candidate;
      }
    }
    for (;;) {
      const candidate =
        seen.size === 0
          ? baseName
          : suffixedProviderName({
              base: baseName,
              maximumLength: 100,
              suffix: (input.generateSuffix ?? suffix)(),
            });
      if (seen.has(candidate)) {
        continue;
      }
      await input.persistCandidate(candidate);
      seen.add(candidate);
      yield candidate;
    }
  };

  try {
    const absentCandidates = new Set(input.persistedAbsentCandidates);
    const result = await runSequentiallyUntilAsync<string, VercelProvisionResult>(
      candidates(),
      async (candidate) => {
        const before = await inspect(candidate);
        const wasAbsent = absentCandidates.has(candidate);
        if (before.status === 200 && !wasAbsent) {
          return null;
        }
        if (before.status === 404 && !wasAbsent) {
          await input.persistAbsent(candidate);
          absentCandidates.add(candidate);
        }
        if (before.status === 404) {
          const { created, recovered } = await createVercelProject(
            candidate,
            projectCreationBody(candidate, {
              deploymentAccess: input.deploymentAccess,
              linkedRepository,
            }),
            vercel,
            inspect,
          );
          if (created.status === 400 || created.status === 403 || created.status === 429) {
            return createProjectFailure(created.status, providerDiagnostic);
          }
          if (created.status === 409 && recovered?.status !== 200) {
            const collision = z
              .object({
                error: z.object({
                  code: z.enum([PROJECT_ALREADY_EXISTS, NAME_ALREADY_EXISTS]),
                }),
              })
              .safeParse(created.body).success;
            return collision
              ? null
              : { code: "provider_rejected", retryable: false, status: "failed" };
          }
        }
        const observed = await inspect(candidate);
        if (observed.status !== 200) {
          return { code: "postcondition_failed", retryable: false, status: "failed" };
        }
        const project = projectSchema.parse(observed.body);
        if (
          !projectMatches({
            candidate,
            deploymentAccess: input.deploymentAccess,
            linkedRepository,
            project,
          })
        ) {
          return { code: "postcondition_failed", retryable: false, status: "failed" };
        }
        const provisioned: Extract<VercelProvisionResult, { status: "succeeded" }> = {
          dashboardUrl: `https://vercel.com/${input.installation.slug}/${project.name}`,
          framework: "services",
          installationId: input.installation.installationId,
          name: project.name,
          projectId: project.id,
          rootDirectory: project.rootDirectory,
          scope: {
            id: input.installation.scopeId,
            slug: input.installation.slug,
            type: input.installation.scopeType,
          },
          status: "succeeded",
        };
        if (linkedRepository !== undefined && linkedRepository !== "") {
          provisioned.linkedGitHubRepository = linkedRepository;
        }
        return provisioned;
      },
    );
    return result ?? { code: "provider_unavailable", retryable: true, status: "failed" };
  } catch (error) {
    const failure = error instanceof Error ? error.message : "other";
    if (
      failure === "provider-rate-limited" ||
      failure === "provider-permission-denied" ||
      failure === "credential-rejected"
    ) {
      return failureForError(failure, providerDiagnostic);
    }
    return failureForError("other", providerDiagnostic);
  }
}
