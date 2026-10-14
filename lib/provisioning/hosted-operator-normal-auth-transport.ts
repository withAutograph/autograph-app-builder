import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

interface NormalAuthRoute {
  method: "GET" | "POST";
  query: ReadonlySet<string>;
}
const routes = new Map<string, NormalAuthRoute>([
  ["/api/auth/sign-up/email", { method: "POST", query: new Set() }],
  ["/api/auth/sign-in/email", { method: "POST", query: new Set() }],
  [
    "/api/auth/get-session",
    { method: "GET", query: new Set(["disableRefresh", "disableCookieCache"]) },
  ],
  ["/api/auth/organization/invite-member", { method: "POST", query: new Set() }],
  ["/api/auth/organization/accept-invitation", { method: "POST", query: new Set() }],
  ["/api/auth/organization/set-active", { method: "POST", query: new Set() }],
  [
    "/api/auth/organization/list-invitations",
    { method: "GET", query: new Set(["organizationId"]) },
  ],
  [
    "/api/auth/organization/list-members",
    {
      method: "GET",
      query: new Set(["organizationId", "filterField", "filterValue", "filterOperator"]),
    },
  ],
]);
const browserHeaders = new Set(["accept", "content-type", "cookie", "origin"]);
const mismatch = () => new HostedOperatorError("resource_mismatch");

const approvedRequest = (
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  origin: string,
) => {
  const original = input instanceof Request ? input : undefined;
  const address = input instanceof Request ? input.url : input;
  const url = new URL(String(address));
  const method = init?.method ?? original?.method ?? "GET";
  const route = routes.get(url.pathname);
  const queryNames = [...url.searchParams.keys()];
  const approved = [
    url.origin === origin,
    url.username === "",
    url.password === "",
    url.hash === "",
    route !== undefined,
    method === route?.method,
    queryNames.every((name) => route?.query.has(name) === true),
    queryNames.every((name) => url.searchParams.getAll(name).length === 1),
    url.pathname !== "/api/auth/get-session" ||
      (url.searchParams.get("disableRefresh") === "true" &&
        url.searchParams.get("disableCookieCache") === "true"),
  ].every(Boolean);
  if (!approved) {
    throw mismatch();
  }
  const headers = new Headers(init?.headers ?? original?.headers);
  if (
    headers.get("origin") !== origin ||
    [...headers.keys()].some((name) => !browserHeaders.has(name))
  ) {
    throw mismatch();
  }
  return { original, url, method, headers };
};
const requestBody = async (
  original: Request | undefined,
  init: RequestInit | undefined,
  method: string,
) =>
  init?.body ??
  (method === "POST" && original !== undefined ? await original.clone().arrayBuffer() : undefined);
const redirectedResponse = (response: Response, origin: string) =>
  [
    response.redirected,
    response.status >= 300 && response.status < 400,
    response.url !== "" && new URL(response.url).origin !== origin,
  ].some(Boolean);

export type NormalAuthTransportConfiguration = Pick<
  HostedOperatorSourceConfiguration,
  "applications" | "operator" | "teamId"
> & {
  gateway: Pick<HostedOperatorSourceConfiguration["gateway"], "publicOrigin">;
  nativeNeon: {
    configuration: Pick<
      HostedOperatorSourceConfiguration["nativeNeon"]["configuration"],
      "operator"
    >;
  };
};
export interface NormalAuthTransportDependencies {
  configuration: NormalAuthTransportConfiguration;
  context: HostedOperatorContext;
  origin: string;
  /** Full owner/provider target check once before opening this exact-origin capability. */
  assertPlanningAuthorized: (context: HostedOperatorContext) => Promise<void>;
  /** Bind owner.assertArtifactAuthorized: fresh session/membership checks without provider lookup. */
  assertCurrentOwner: (context: HostedOperatorContext) => Promise<void>;
}

/**
 * Private normal Auth requests use actual browser cookies and the existing native protection token.
 * The normal Auth client still checks the durable effect approval before every mutation.
 */
export const createHostedOperatorNormalAuthTransport = async (
  dependencies: NormalAuthTransportDependencies,
  io: {
    getOidc?: typeof getVercelOidcToken;
    verifyOidc?: (
      token: string,
      options: Parameters<typeof verifyVercelOidcToken>[1],
    ) => Promise<void>;
    fetch?: typeof fetch;
  } = {},
): Promise<typeof fetch> => {
  const configuration = structuredClone(dependencies.configuration);
  const context: HostedOperatorContext = structuredClone({
    authority: dependencies.context.authority,
    ownerContext: dependencies.context.ownerContext,
    target: dependencies.context.target,
  });
  const origin = new URL(dependencies.origin);
  const application = configuration.applications[context.target.appId];
  const scope = [
    origin.protocol === "https:",
    origin.origin === dependencies.origin,
    origin.username === "",
    origin.password === "",
    origin.origin === configuration.gateway.publicOrigin,
    application?.projectId === context.target.projectId,
    application?.branch === context.target.branch,
    context.target.environment === "preview",
    context.target.scopeId === configuration.teamId,
    configuration.operator.projectId === configuration.nativeNeon.configuration.operator.projectId,
    configuration.teamId === configuration.nativeNeon.configuration.operator.ownerId,
    configuration.operator.environment ===
      configuration.nativeNeon.configuration.operator.environment,
  ].every(Boolean);
  if (!scope) {
    throw mismatch();
  }
  await dependencies.assertPlanningAuthorized(context);
  await dependencies.assertCurrentOwner(context);
  const source = configuration.nativeNeon.configuration.operator;
  const verifyOidc =
    io.verifyOidc ??
    (async (token: string, options: Parameters<typeof verifyVercelOidcToken>[1]) => {
      await verifyVercelOidcToken(token, options);
    });

  return async (input, init) => {
    const { original, url, method, headers } = approvedRequest(input, init, origin.origin);
    await dependencies.assertCurrentOwner(context);
    const token = await (io.getOidc ?? getVercelOidcToken)({
      project: configuration.operator.projectId,
      team: configuration.teamId,
    });
    await verifyOidc(token, {
      audience: source.audience,
      environment: source.environment,
      issuer: source.issuer,
      ownerId: source.ownerId,
      projectId: source.projectId,
    });
    await dependencies.assertCurrentOwner(context);
    headers.set("x-vercel-trusted-oidc-idp-token", token);
    const body = await requestBody(original, init, method);
    const requestSignal = init?.signal ?? original?.signal;
    const response = await (io.fetch ?? fetch)(url, {
      body,
      cache: "no-store",
      headers,
      method,
      redirect: "error",
      signal: requestSignal
        ? AbortSignal.any([requestSignal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    if (redirectedResponse(response, origin.origin)) {
      throw mismatch();
    }
    await dependencies.assertCurrentOwner(context);
    return response;
  };
};
