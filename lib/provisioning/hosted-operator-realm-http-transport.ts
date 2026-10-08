import { getVercelOidcToken, verifyVercelOidcToken } from "@vercel/oidc";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import { HostedOperatorError } from "./hosted-operator-contract";

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
    /** Exact operator-published immutable endpoint from its owned journal; not a caller/token URL or fresh provider observation. */
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
    const token = await (io.getOidc ?? getVercelOidcToken)();
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
