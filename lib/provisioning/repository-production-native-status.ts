import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { RepositoryProductionRequestOwner } from "./repository-production-dispatcher";
import type { RepositoryProductionObservationSubject } from "./repository-production-management-subject";
import {
  repositoryProductionExpectedMergeShaSchema,
  repositoryProductionNativeStatusSchema,
} from "./repository-production-native-status-contract";
import type { RepositoryProductionNativeStatus } from "./repository-production-native-status-contract";

type ServiceIssue = NonNullable<RepositoryProductionNativeStatus["serviceIssue"]>;
const unavailable = "service-unavailable";
const notObserved = "not-observed";
const providerRead = "provider-read";
const gatewayRead = "gateway-read";
const domainBinding = "domain-binding";

class NativeObservationReadError extends Error {
  readonly issue: ServiceIssue;

  constructor(issue: ServiceIssue) {
    super("Builder could not observe the current native app delivery.");
    this.name = "NativeObservationReadError";
    this.issue = issue;
  }
}
const id = z.string().min(1);
const projectSchema = z.object({
  id,
  link: z.unknown().optional(),
  targets: z.object({ production: z.object({ id }).nullish() }).optional(),
});
const domainSchema = z.object({
  name: id,
  verified: z.boolean(),
  gitBranch: z.string().nullish(),
  redirect: z.string().nullish(),
});
const aliasSchema = z.object({ alias: id, projectId: id, deploymentId: id });
const deploymentSchema = z.object({
  id,
  projectId: id,
  target: z.string().nullable(),
  readyState: id,
  aliasAssigned: z.boolean().optional(),
  aliasError: z.object({}).nullish(),
  source: z.unknown().optional(),
  gitSource: z.unknown().optional(),
  meta: z.unknown().optional(),
});
const repoId = z.union([id, z.number().int().positive()]);
const projectGitHubLinkSchema = z.object({
  type: z.literal("github"),
  repoId,
  org: id,
  repo: id,
  productionBranch: id,
});
const deploymentGitHubSourceSchema = z.object({
  type: z.literal("github"),
  repoId,
  ref: id,
  sha: repositoryProductionExpectedMergeShaSchema,
});
const deploymentGitHubMetadataSchema = z.object({
  githubOrg: z.unknown().optional(),
  githubRepo: z.unknown().optional(),
  githubCommitRef: z.unknown().optional(),
  githubCommitSha: z.unknown().optional(),
});
const catalogSchema = z.object({
  applications: z.array(z.object({ id, basePath: z.string().min(1) })),
});

const currentNativeGitSha = (
  deployment: z.infer<typeof deploymentSchema>,
  project: z.infer<typeof projectSchema>,
  scope: Pick<
    RepositoryProductionObservationSubject["scope"],
    "repositoryId" | "repositoryFullName"
  >,
): string | null => {
  if (deployment.source !== "git") {
    return null;
  }
  const link = projectGitHubLinkSchema.safeParse(project.link).data;
  const metadata = deploymentGitHubMetadataSchema.safeParse(deployment.meta).data;
  const [owner, name] = scope.repositoryFullName.split("/");
  const linkPresent = project.link !== null && project.link !== undefined;
  const matchingLink =
    link !== undefined &&
    String(link.repoId) === scope.repositoryId &&
    link.org === owner &&
    link.repo === name;
  if (linkPresent && !matchingLink) {
    return null;
  }
  if (deployment.gitSource !== null && deployment.gitSource !== undefined) {
    const source = deploymentGitHubSourceSchema.safeParse(deployment.gitSource).data;
    if (
      source === undefined ||
      String(source.repoId) !== scope.repositoryId ||
      (link !== undefined && source.ref !== link.productionBranch)
    ) {
      return null;
    }
    const conflicts =
      metadata !== undefined &&
      (
        [
          [metadata.githubOrg, owner],
          [metadata.githubRepo, name],
          [metadata.githubCommitRef, source.ref],
          [metadata.githubCommitSha, source.sha],
        ] as const
      ).some(([value, expected]) => value !== undefined && value !== expected);
    return conflicts ? null : source.sha;
  }
  // Vercel can omit Git source details for reduced reads. The Git-triggered
  // deployment metadata is usable only with its verified project repository link.
  if (link === undefined || metadata === undefined) {
    return null;
  }
  if (
    metadata.githubOrg !== owner ||
    metadata.githubRepo !== name ||
    metadata.githubCommitRef !== link.productionBranch
  ) {
    return null;
  }
  return (
    repositoryProductionExpectedMergeShaSchema.safeParse(metadata.githubCommitSha).data ?? null
  );
};

const publicEntry = (origin: string, path: string | undefined, base = origin) => {
  if (path === undefined) {
    return null;
  }
  try {
    const url = new URL(path, base);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    if (url.hostname === "vercel-infra.com" || url.hostname.endsWith(".vercel-infra.com")) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

const withinBasePath = (path: string, basePath: string) =>
  path === basePath || path.startsWith(`${basePath}/`);

const documentAvailability = (
  response: Response,
  scope: Pick<RepositoryProductionObservationSubject["scope"], "appId" | "publicOrigin">,
  entryUrl: string,
  basePath: string,
) => {
  if (response.headers.get("x-platform-route-application") !== scope.appId) {
    return null;
  }
  if (response.ok && /^text\/html(?:;|$)/iu.test(response.headers.get("content-type") ?? "")) {
    return "responding";
  }
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return null;
  }
  const location = response.headers.get("location");
  if (location === null || location.trim() === "") {
    return null;
  }
  const redirect = publicEntry(scope.publicOrigin, location, entryUrl);
  if (redirect === null) {
    return null;
  }
  const { pathname } = new URL(redirect);
  if (pathname === "/auth/sign-in") {
    return "sign-in-required";
  }
  return withinBasePath(pathname, basePath) ? "responding" : null;
};

/** Observe the provider's current deployment and public app route without changing delivery. */
export const createRepositoryProductionNativeStatus =
  (deps: {
    resolve: (
      owner: RepositoryProductionRequestOwner,
    ) => Promise<RepositoryProductionObservationSubject | undefined>;
    teamId: string;
    readCredential: () => Promise<string>;
    signal: AbortSignal;
    fetch?: typeof fetch;
    now?: () => Date;
  }) =>
  async (
    owner: RepositoryProductionRequestOwner,
    expectedMergeSha?: string,
  ): Promise<RepositoryProductionNativeStatus> => {
    deps.signal.throwIfAborted();
    const requestedMerge = repositoryProductionExpectedMergeShaSchema
      .optional()
      .parse(expectedMergeSha);
    const subject = await deps.resolve(owner);
    deps.signal.throwIfAborted();
    const result: RepositoryProductionNativeStatus = {
      version: 1,
      appId: owner.appId,
      observedAt: (deps.now?.() ?? new Date()).toISOString(),
      status: unavailable,
      deployment: { state: unavailable },
      app: { state: unavailable },
      requestedRevision: "unassessed",
      serviceIssue: "configuration",
    };
    if (subject === undefined) {
      return result;
    }
    const { scope } = subject;
    if (
      scope.appId !== owner.appId ||
      !isDeepStrictEqual(scope.authority, owner.ownerContext.authority)
    ) {
      throw new HostedOperatorError("authorization_required");
    }
    result.destination = {
      repositoryId: scope.repositoryId,
      repositoryFullName: scope.repositoryFullName,
    };
    const assertCurrent = async () => {
      deps.signal.throwIfAborted();
      await subject.assertCurrentOwner();
      deps.signal.throwIfAborted();
    };
    await assertCurrent();
    const origin = publicEntry(scope.publicOrigin, "/");
    if (origin === null) {
      return result;
    }
    const request = deps.fetch ?? fetch;
    const readJson = async <T>(response: Response, schema: z.ZodType<T>, issue: ServiceIssue) => {
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        await assertCurrent();
        throw new NativeObservationReadError(issue);
      }
      await assertCurrent();
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new NativeObservationReadError(issue);
      }
      return parsed.data;
    };
    const readProvider = async <T>(path: string, schema: z.ZodType<T>) => {
      await assertCurrent();
      let token: string;
      try {
        token = await deps.readCredential();
      } catch {
        await assertCurrent();
        throw new NativeObservationReadError("provider-access");
      }
      await assertCurrent();
      const url = new URL(path, "https://api.vercel.com");
      if (url.origin !== "https://api.vercel.com") {
        throw new NativeObservationReadError(providerRead);
      }
      url.searchParams.set("teamId", deps.teamId);
      let response: Response;
      try {
        response = await request(url, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal: deps.signal,
          headers: { authorization: `Bearer ${token}` },
        });
      } catch {
        await assertCurrent();
        throw new NativeObservationReadError(providerRead);
      }
      await assertCurrent();
      if (!response.ok) {
        await response.body?.cancel();
        throw new NativeObservationReadError(
          response.status === 401 || response.status === 403 ? "provider-access" : providerRead,
        );
      }
      return await readJson(response, schema, providerRead);
    };
    const readPublic = async (url: string | URL, document: boolean) => {
      await assertCurrent();
      let response: Response;
      try {
        response = await request(url, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: deps.signal,
          headers: document
            ? { accept: "text/html", "sec-fetch-mode": "navigate" }
            : { accept: "application/json" },
        });
      } catch {
        await assertCurrent();
        throw new NativeObservationReadError(gatewayRead);
      }
      await assertCurrent();
      return response;
    };
    const projectPath = `/v9/projects/${encodeURIComponent(scope.projectId)}`;
    const { hostname } = new URL(origin);
    const aliasPath = `/v4/aliases/${encodeURIComponent(hostname)}`;
    let activeId: string | undefined;
    let revisionSource: { deployment: z.infer<typeof deploymentSchema>; sha: string } | null = null;
    delete result.serviceIssue;
    result.status = "pending";
    result.deployment = { state: notObserved };
    try {
      const project = await readProvider(projectPath, projectSchema);
      if (project.id !== scope.projectId) {
        throw new NativeObservationReadError(domainBinding);
      }
      activeId = project.targets?.production?.id;
      if (activeId !== undefined) {
        // oxlint-disable-next-line react-doctor/async-parallel -- Finish each owner-checked read before beginning the next.
        const domain = await readProvider(
          `${projectPath}/domains/${encodeURIComponent(hostname)}`,
          domainSchema,
        );
        const alias = await readProvider(aliasPath, aliasSchema);
        const gitInfo = requestedMerge === undefined ? "" : "?withGitRepoInfo=true";
        const deployment = await readProvider(
          `/v13/deployments/${encodeURIComponent(activeId)}${gitInfo}`,
          deploymentSchema,
        );
        const branchBound = (domain.gitBranch ?? null) !== null;
        const redirects = (domain.redirect ?? null) !== null;
        const domainMatches =
          domain.name === hostname && domain.verified && !branchBound && !redirects;
        const aliasMatches = alias.alias === hostname && alias.projectId === scope.projectId;
        const deploymentMatches =
          deployment.id === activeId &&
          deployment.projectId === scope.projectId &&
          deployment.target === "production";
        if (!domainMatches || !aliasMatches || !deploymentMatches) {
          throw new NativeObservationReadError(domainBinding);
        }
        if (alias.deploymentId !== activeId) {
          const building = ["QUEUED", "INITIALIZING", "BUILDING"].includes(deployment.readyState);
          const awaitingAlias =
            deployment.readyState === "READY" && deployment.aliasAssigned === false;
          if ((!building && !awaitingAlias) || (deployment.aliasError ?? null) !== null) {
            throw new NativeObservationReadError(domainBinding);
          }
          // Vercel can select a build before it assigns the alias, including while deployment checks run.
          await assertCurrent();
          result.app = { state: notObserved };
          if (requestedMerge !== undefined) {
            result.requestedRevision = "awaiting-activation";
          }
          result.observedAt = (deps.now?.() ?? new Date()).toISOString();
          return repositoryProductionNativeStatusSchema.parse(result);
        }
        if (deployment.readyState === "READY") {
          result.deployment = { state: "active" };
          if (requestedMerge !== undefined) {
            const sha = currentNativeGitSha(deployment, project, scope);
            if (sha !== null) {
              revisionSource = { deployment, sha };
            }
          }
        } else if (["ERROR", "CANCELED", "CANCELLED", "BLOCKED"].includes(deployment.readyState)) {
          throw new NativeObservationReadError(providerRead);
        }
      }
    } catch (error) {
      if (!(error instanceof NativeObservationReadError)) {
        throw error;
      }
      result.deployment = { state: unavailable };
      result.serviceIssue = error.issue;
    }
    result.app = { state: notObserved };
    const savedUrl = publicEntry(scope.publicOrigin, subject.entryPath);
    if (savedUrl !== null) {
      result.app.url = savedUrl;
    }
    try {
      const catalogResponse = await readPublic(new URL("/_platform/catalog", origin), false);
      if (!catalogResponse.ok) {
        await catalogResponse.body?.cancel();
        throw new NativeObservationReadError(gatewayRead);
      }
      const catalog = await readJson(catalogResponse, catalogSchema, gatewayRead);
      const matches = catalog.applications.filter((app) => app.id === scope.appId);
      if (matches.length > 1) {
        throw new NativeObservationReadError(gatewayRead);
      }
      const [registered] = matches;
      if (registered !== undefined) {
        const baseUrl = publicEntry(scope.publicOrigin, registered.basePath);
        if (baseUrl === null) {
          throw new NativeObservationReadError(gatewayRead);
        }
        const basePath = new URL(baseUrl).pathname.replace(/\/$/u, "");
        const savedPath = savedUrl === null ? null : new URL(savedUrl).pathname;
        const url =
          savedUrl !== null && savedPath !== null && withinBasePath(savedPath, basePath)
            ? savedUrl
            : baseUrl;
        result.app = { state: "registered", url };
        const response = await readPublic(url, true);
        await response.body?.cancel();
        const state = documentAvailability(response, scope, url, basePath);
        if (state === null) {
          throw new NativeObservationReadError(gatewayRead);
        }
        result.app.state = state;
      }
    } catch (error) {
      if (!(error instanceof NativeObservationReadError)) {
        throw error;
      }
      result.serviceIssue ??= error.issue;
      if (result.app.state === notObserved) {
        result.app.state = unavailable;
      }
    }
    if (activeId !== undefined && result.deployment.state === "active") {
      try {
        const project = await readProvider(projectPath, projectSchema);
        const alias = await readProvider(aliasPath, aliasSchema);
        if (
          project.id !== scope.projectId ||
          alias.alias !== hostname ||
          alias.projectId !== scope.projectId
        ) {
          throw new NativeObservationReadError(domainBinding);
        }
        if (project.targets?.production?.id !== activeId || alias.deploymentId !== activeId) {
          result.deployment = { state: notObserved };
        } else if (
          revisionSource !== null &&
          currentNativeGitSha(revisionSource.deployment, project, scope) !== revisionSource.sha
        ) {
          revisionSource = null;
        }
      } catch (error) {
        if (!(error instanceof NativeObservationReadError)) {
          throw error;
        }
        result.deployment = { state: unavailable };
        result.serviceIssue = error.issue;
      }
    }
    await assertCurrent();
    const available =
      result.deployment.state === "active" &&
      ["responding", "sign-in-required"].includes(result.app.state);
    if (result.serviceIssue === undefined) {
      result.status = available ? "available" : "pending";
      if (requestedMerge !== undefined) {
        result.requestedRevision =
          available && revisionSource?.sha === requestedMerge ? "live" : "awaiting-activation";
      }
    } else {
      result.status = unavailable;
    }
    result.observedAt = (deps.now?.() ?? new Date()).toISOString();
    return repositoryProductionNativeStatusSchema.parse(result);
  };
