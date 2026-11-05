import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";

const isApprovedUrl = (url: URL, origin: string): boolean =>
  [
    url.origin === origin,
    url.username === "",
    url.password === "",
    url.search === "",
    url.hash === "",
  ].every(Boolean);

const requestMethod = (input: RequestInfo | URL, init?: RequestInit): string =>
  init?.method ?? (input instanceof Request ? input.method : "GET");
const requestHeaders = (input: RequestInfo | URL, init?: RequestInit): Headers =>
  new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
const requestBody = async (
  input: RequestInfo | URL,
  method: string,
  init?: RequestInit,
): Promise<BodyInit | null | undefined> =>
  init?.body ??
  (method === "POST" && input instanceof Request ? await input.clone().arrayBuffer() : undefined);
/** Private normal-owner callback readback uses the actual Builder project OIDC source; no Realm cookie or static provider key. */
export const createHostedOperatorRealmHttpTransport =
  (
    configuration: HostedOperatorSourceConfiguration,
    sourceHost: "builder" | "operator",
    io: {
      getOidc?: typeof getVercelOidcToken;
      verifyOidc?: typeof verifyVercelOidcToken;
      fetch?: typeof fetch;
    } = {},
    /** Exact trusted immutable origin from current owner-scoped provider observation or a frozen approved operation; never a caller, token or browser URL. */
    endpointOrigin: string = configuration.gateway.gatewayOrigin,
  ): typeof fetch =>
  async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = requestMethod(input, init);
    const fixedRead =
      (method === "POST" && url.pathname === "/api/auth/platform/operator-identity/readback") ||
      (method === "GET" && url.pathname === "/_platform/jwks.json");
    const approvedRequest = isApprovedUrl(url, endpointOrigin) && fixedRead;
    if (!approvedRequest) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const source =
      sourceHost === "builder"
        ? configuration.workloadPolicy
        : configuration.nativeNeon.configuration.operator;
    const token = await (io.getOidc ?? getVercelOidcToken)({
      project: source.projectId,
      team: source.ownerId,
    });
    await (io.verifyOidc ?? verifyVercelOidcToken)(token, {
      audience: source.audience,
      environment: source.environment,
      issuer: source.issuer,
      ownerId: source.ownerId,
      projectId: source.projectId,
    });
    const headers = requestHeaders(input, init);
    if (headers.has("cookie")) {
      throw new HostedOperatorError("resource_mismatch");
    }
    // The fixed server readback uses its approved target origin for the Gateway's mutation policy.
    if (method === "POST") {
      headers.set("origin", endpointOrigin);
      // Carry the same verified caller through the application boundary even
      // when Vercel consumes its reserved protection header at ingress.
      headers.set("authorization", `Bearer ${token}`);
    }
    headers.set("x-vercel-trusted-oidc-idp-token", token);
    const body = await requestBody(input, method, init);
    return await (io.fetch ?? fetch)(url, {
      ...init,
      body,
      cache: "no-store",
      headers,
      method,
      redirect: "error",
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
  };

/** Host-owned public verification reads share the fixed server transport, never normal-account cookies. */
export const createHostedOperatorPublicJwksReader =
  (
    dependencies: {
      configuration: HostedOperatorSourceConfiguration;
      assertPlanningAuthorized: (context: HostedOperatorContext) => Promise<void>;
      assertCurrentOwner: (context: HostedOperatorContext) => Promise<void>;
    },
    io: Parameters<typeof createHostedOperatorRealmHttpTransport>[2] = {},
  ) =>
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- The runtime public-profile reader parses this external JWKS JSON into its closed public-key schema.
  async (context: HostedOperatorContext, url: string): Promise<unknown> => {
    const { configuration } = dependencies;
    const application = configuration.applications[context.target.appId];
    const source = configuration.nativeNeon.configuration.operator;
    const approved = [
      url === `${configuration.gateway.publicOrigin}/_platform/jwks.json`,
      application?.projectId === context.target.projectId,
      application?.branch === context.target.branch,
      context.target.environment === "preview",
      context.target.scopeId === configuration.teamId,
      configuration.operator.projectId === source.projectId,
      configuration.teamId === source.ownerId,
      configuration.operator.environment === source.environment,
    ].every(Boolean);
    if (!approved) {
      throw new HostedOperatorError("resource_mismatch");
    }
    await dependencies.assertPlanningAuthorized(context);
    await dependencies.assertCurrentOwner(context);
    const transport = createHostedOperatorRealmHttpTransport(
      configuration,
      "operator",
      io,
      configuration.gateway.publicOrigin,
    );
    const response = await transport(url, { method: "GET", redirect: "error" });
    await dependencies.assertCurrentOwner(context);
    if (!response.ok) {
      throw new HostedOperatorError("operator_unavailable");
    }
    const value: unknown = await response.json();
    return value;
  };
