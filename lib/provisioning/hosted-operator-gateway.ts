import { isIP } from "node:net";
import { z } from "zod";
import type { BuilderHandoffIntent } from "../handoff/contracts";
import { readPreparedVercelAccess } from "../agent/prepared-provider-context";
import type { OperatorOwnerContext, OperatorSelection } from "./hosted-operator-contract";

// oxlint-disable eslint/no-await-in-loop -- Each next-page cursor is returned by the previous provider read.
type CredentialReader = Parameters<typeof readPreparedVercelAccess>[0]["readCredential"];
type Authority = OperatorOwnerContext["authority"];

export type HostedOperatorGatewayResolution =
  | { status: "ready"; origin: string; deploymentId: string }
  | { status: "unresolved"; predicate: "verified_preview_branch_alias"; reason: string };

export interface HostedOperatorGatewayDependencies {
  authority: Authority;
  intent: BuilderHandoffIntent;
  selection: OperatorSelection;
  readVercelCredential: CredentialReader;
  fetch?: typeof fetch;
  apiOrigin?: string;
}

const unresolved = (reason: string): HostedOperatorGatewayResolution => ({
  predicate: "verified_preview_branch_alias",
  reason,
  status: "unresolved",
});

const projectDomainSchema = z.object({
  customEnvironmentId: z.string().nullable(),
  gitBranch: z.string().nullable(),
  name: z.string(),
  projectId: z.string(),
  redirect: z.string().nullable(),
  verified: z.boolean(),
});
export type HostedOperatorProjectDomain = z.infer<typeof projectDomainSchema>;

const domainPageSchema = z.object({
  domains: z.array(projectDomainSchema),
  pagination: z.object({ next: z.union([z.number(), z.string()]).nullable() }).optional(),
});
const deploymentPageSchema = z.object({
  deployments: z.array(
    z.object({
      createdAt: z.union([z.number(), z.string()]),
      id: z.string().optional(),
      projectId: z.string(),
      readyState: z.string(),
      target: z.string().nullable(),
      uid: z.string().optional(),
    }),
  ),
  pagination: z.object({ next: z.union([z.number(), z.string()]).nullable() }),
});
const deploymentDetailSchema = z.object({
  gitSource: z.object({ ref: z.string() }),
  id: z.string(),
  projectId: z.string(),
  readyState: z.string(),
  target: z.string().nullable(),
});
const deploymentAliasesSchema = z.object({ aliases: z.array(z.object({ alias: z.string() })) });

type ListedDeployment = z.infer<typeof deploymentPageSchema>["deployments"][number];

const apiOriginFor = (candidate: string | undefined): string | undefined => {
  try {
    const url = new URL(candidate ?? "https://api.vercel.com");
    const invalid = [
      url.protocol !== "https:",
      url.username !== "",
      url.password !== "",
      url.pathname !== "/",
      url.search !== "",
      url.hash !== "",
    ];
    return invalid.some(Boolean) ? undefined : url.origin;
  } catch {
    return undefined;
  }
};

const publicOrigin = (domain: HostedOperatorProjectDomain): string | undefined => {
  let url: URL;
  try {
    url = new URL(`https://${domain.name}`);
  } catch {
    return undefined;
  }
  const invalid = [
    url.protocol !== "https:",
    url.username !== "",
    url.password !== "",
    url.port !== "",
    url.pathname !== "/",
    url.search !== "",
    url.hash !== "",
    url.hostname !== domain.name.toLowerCase(),
    url.hostname.endsWith(".vercel.run"),
    url.hostname === "vercel.run",
    !url.hostname.includes("."),
    isIP(url.hostname) !== 0,
    url.hostname.endsWith(".localhost"),
    url.hostname.endsWith(".local"),
  ];
  return invalid.some(Boolean) ? undefined : url.origin;
};

const getJsonResponse = async (
  fetcher: typeof fetch,
  url: URL,
  token: string,
): Promise<Response | undefined> => {
  try {
    const response = await fetcher(url, {
      cache: "no-store",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 200) {
      return response;
    }
    await response.body?.cancel();
    return undefined;
  } catch {
    return undefined;
  }
};

const vercelUrl = (origin: string, pathname: string, scopeId: string, isTeam: boolean) => {
  const url = new URL(pathname, origin);
  if (isTeam) {
    url.searchParams.set("teamId", scopeId);
  }
  return url;
};

const readProjectDomains = async (
  fetcher: typeof fetch,
  url: URL,
  token: string,
): Promise<HostedOperatorProjectDomain[] | undefined> => {
  const domains: HostedOperatorProjectDomain[] = [];
  const seenCursors = new Set<string>();
  let currentUrl: URL | null = url;
  while (currentUrl !== null) {
    const response = await getJsonResponse(fetcher, currentUrl, token);
    if (!response) {
      return undefined;
    }
    const parsed = domainPageSchema.safeParse(await response.json());
    if (!parsed.success) {
      return undefined;
    }
    domains.push(...parsed.data.domains);
    const next = parsed.data.pagination?.next;
    if (next === null || next === undefined) {
      currentUrl = null;
      continue;
    }
    const cursor = String(next);
    if (seenCursors.has(cursor)) {
      return undefined;
    }
    seenCursors.add(cursor);
    currentUrl = new URL(url);
    currentUrl.searchParams.set("until", cursor);
  }
  return domains;
};

const readReadyDeployments = async (
  fetcher: typeof fetch,
  url: URL,
  token: string,
): Promise<ListedDeployment[] | undefined> => {
  const deployments: ListedDeployment[] = [];
  const seenCursors = new Set<string>();
  let currentUrl: URL | null = url;
  while (currentUrl !== null) {
    const response = await getJsonResponse(fetcher, currentUrl, token);
    if (!response) {
      return undefined;
    }
    const parsed = deploymentPageSchema.safeParse(await response.json());
    if (!parsed.success) {
      return undefined;
    }
    deployments.push(...parsed.data.deployments);
    const { next } = parsed.data.pagination;
    if (next === null) {
      currentUrl = null;
      continue;
    }
    const cursor = String(next);
    if (seenCursors.has(cursor)) {
      return undefined;
    }
    seenCursors.add(cursor);
    currentUrl = new URL(url);
    currentUrl.searchParams.set("until", cursor);
  }
  return deployments;
};

const readCredentialAndAccess = async (input: HostedOperatorGatewayDependencies) => {
  let credential: Awaited<ReturnType<CredentialReader>> | undefined;
  const accessInput: Parameters<typeof readPreparedVercelAccess>[0] = {
    authority: input.authority,
    intent: input.intent,
    readCredential: async (request) => {
      credential = await input.readVercelCredential(request);
      return credential;
    },
  };
  if (input.fetch !== undefined) {
    accessInput.fetch = input.fetch;
  }
  if (input.apiOrigin !== undefined) {
    accessInput.apiOrigin = input.apiOrigin;
  }
  return { access: await readPreparedVercelAccess(accessInput), credential };
};

const isExactBranchDomain = (domain: HostedOperatorProjectDomain, selection: OperatorSelection) => {
  const noEnvironmentOverride =
    domain.customEnvironmentId === null || domain.customEnvironmentId === undefined;
  const noRedirect = domain.redirect === null || domain.redirect === undefined;
  const identitiesMatch =
    domain.projectId === selection.projectId && domain.gitBranch === selection.branch;
  return identitiesMatch && domain.verified && noEnvironmentOverride && noRedirect;
};

const findBranchDomain = (domains: HostedOperatorProjectDomain[], selection: OperatorSelection) => {
  const matches = domains.filter((domain) => isExactBranchDomain(domain, selection));
  if (matches.length === 1) {
    const [domain] = matches;
    return { domain, reason: null } as const;
  }
  return {
    domain: null,
    reason: matches.length === 0 ? "branch_domain_unavailable" : "branch_domain_ambiguous",
  } as const;
};

const latestDeploymentId = (deployments: ListedDeployment[], projectId: string) => {
  deployments.sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
  const [latest, second] = deployments;
  const createdAt = Number(latest?.createdAt);
  const secondCreatedAt = Number(second?.createdAt);
  const deploymentId = latest?.id ?? latest?.uid;
  if (latest === undefined || deploymentId === undefined || deploymentId.length === 0) {
    return null;
  }
  const invalid = [
    !Number.isFinite(createdAt),
    second !== undefined && secondCreatedAt === createdAt,
    latest?.projectId !== projectId,
    latest?.readyState !== "READY",
    latest?.target !== null,
  ];
  return invalid.some(Boolean) ? null : deploymentId;
};

const deploymentMatches = (
  deployment: z.infer<typeof deploymentDetailSchema>,
  deploymentId: string,
  selection: OperatorSelection,
) => {
  const identityMatches = [
    deployment.id === deploymentId,
    deployment.projectId === selection.projectId,
    deployment.gitSource.ref === selection.branch,
  ];
  const previewReady = deployment.readyState === "READY" && deployment.target === null;
  return identityMatches.every(Boolean) && previewReady;
};

const readDeploymentDetail = async (
  fetcher: typeof fetch,
  url: URL,
  token: string,
  deploymentId: string,
  selection: OperatorSelection,
) => {
  const response = await getJsonResponse(fetcher, url, token);
  if (!response) {
    return false;
  }
  const parsed = deploymentDetailSchema.safeParse(await response.json());
  return parsed.success && deploymentMatches(parsed.data, deploymentId, selection);
};

const hasCurrentAlias = async (input: {
  apiOrigin: string;
  deploymentId: string;
  domainName: string;
  fetch: typeof fetch;
  scopeId: string;
  team: boolean;
  token: string;
}) => {
  const aliasesUrl = vercelUrl(
    input.apiOrigin,
    `/v2/deployments/${encodeURIComponent(input.deploymentId)}/aliases`,
    input.scopeId,
    input.team,
  );
  const response = await getJsonResponse(input.fetch, aliasesUrl, input.token);
  if (!response) {
    return false;
  }
  const parsed = deploymentAliasesSchema.safeParse(await response.json());
  return (
    parsed.success &&
    parsed.data.aliases.some(
      (alias) => alias.alias.toLowerCase() === input.domainName.toLowerCase(),
    )
  );
};

const resolveFromProvider = async (input: {
  apiOrigin: string;
  fetcher: typeof fetch;
  projectId: string;
  branch: string;
  scopeId: string;
  team: boolean;
  token: string;
  selection: OperatorSelection;
}) => {
  const domainsUrl = vercelUrl(
    input.apiOrigin,
    `/v9/projects/${encodeURIComponent(input.projectId)}/domains`,
    input.scopeId,
    input.team,
  );
  domainsUrl.searchParams.set("limit", "100");
  const domains = await readProjectDomains(input.fetcher, domainsUrl, input.token);
  if (!domains) {
    return unresolved("branch_domain_unavailable");
  }
  const selected = findBranchDomain(domains, input.selection);
  if (selected.domain === null) {
    return unresolved(selected.reason ?? "branch_domain_unavailable");
  }
  const origin = publicOrigin(selected.domain);
  if (origin === undefined) {
    return unresolved("branch_domain_unavailable");
  }

  const deploymentsUrl = vercelUrl(input.apiOrigin, "/v7/deployments", input.scopeId, input.team);
  deploymentsUrl.searchParams.set("projectId", input.projectId);
  deploymentsUrl.searchParams.set("target", "preview");
  deploymentsUrl.searchParams.set("branch", input.branch);
  deploymentsUrl.searchParams.set("state", "READY");
  deploymentsUrl.searchParams.set("limit", "100");
  const deployments = await readReadyDeployments(input.fetcher, deploymentsUrl, input.token);
  if (!deployments) {
    return unresolved("ready_preview_deployment_unavailable");
  }
  const deploymentId = latestDeploymentId(deployments, input.projectId);
  if (deploymentId === null) {
    return unresolved("ready_preview_deployment_unavailable");
  }

  const detailUrl = vercelUrl(
    input.apiOrigin,
    `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    input.scopeId,
    input.team,
  );
  detailUrl.searchParams.set("withGitRepoInfo", "true");
  const detailMatches = await readDeploymentDetail(
    input.fetcher,
    detailUrl,
    input.token,
    deploymentId,
    input.selection,
  );
  if (!detailMatches) {
    return unresolved("deployment_identity_unavailable");
  }

  const aliasReady = await hasCurrentAlias({
    apiOrigin: input.apiOrigin,
    deploymentId,
    domainName: selected.domain.name,
    fetch: input.fetcher,
    scopeId: input.scopeId,
    team: input.team,
    token: input.token,
  });
  if (!aliasReady) {
    return unresolved("deployment_alias_unavailable");
  }
  return { deploymentId, origin, status: "ready" } as const;
};

const getProviderContext = async (input: HostedOperatorGatewayDependencies) => {
  const apiOrigin = apiOriginFor(input.apiOrigin);
  if (apiOrigin === undefined) {
    return null;
  }
  const { access, credential } = await readCredentialAndAccess(input);
  if (
    access.status !== "ready" ||
    access.project?.id !== input.selection.projectId ||
    credential === undefined
  ) {
    return null;
  }
  return {
    apiOrigin,
    fetcher: input.fetch ?? fetch,
    projectId: access.project.id,
    scopeId: access.scope.id,
    team: access.scope.type === "team",
    token: credential.token,
  };
};

/**
 * Resolve only a provider-owned Preview branch domain that is currently assigned
 * to the newest ready deployment for that exact project and branch. The caller's
 * request/plan origin is deliberately not an input to this function.
 */
export const readHostedOperatorPublicGateway = async (
  input: HostedOperatorGatewayDependencies,
): Promise<HostedOperatorGatewayResolution> => {
  const validSelection =
    input.selection.environment === "preview" &&
    input.intent.appId === input.selection.appId &&
    input.intent.provisioning?.vercel?.status === "succeeded" &&
    input.intent.provisioning.vercel.projectId === input.selection.projectId;
  if (!validSelection) {
    return unresolved("provider_access_unavailable");
  }
  const provider = await getProviderContext(input);
  if (provider === null) {
    return unresolved("provider_access_unavailable");
  }
  return await resolveFromProvider({
    ...provider,
    branch: input.selection.branch,
    selection: input.selection,
  });
};
