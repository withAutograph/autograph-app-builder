import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { OAuthApp } from "@octokit/oauth-app";

const GITHUB_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT = "autograph-app-builder";
const silentConsole = new Proxy(console, {
  get(target, property, receiver) {
    if (
      property === "debug" ||
      property === "info" ||
      property === "warn" ||
      property === "error" ||
      property === "log"
    )
      return () => {};
    return Reflect.get(target, property, receiver) as unknown;
  },
});

type Fetch = typeof fetch;

function requestUrl(resource: RequestInfo | URL): URL {
  if (typeof resource === "string") return new URL(resource);
  if (resource instanceof URL) return resource;
  return new URL(resource.url);
}

async function boundedResponse(response: Response): Promise<Response> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("github-response-too-large");
  }
  if (response.body === null) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("github-response-too-large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createGuardedGitHubFetch(request: Fetch = fetch): Fetch {
  return async (resource, init) => {
    const url = requestUrl(resource);
    if (
      (url.origin !== GITHUB_ORIGIN && url.origin !== GITHUB_API_ORIGIN) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("github-origin-invalid");
    }

    const resourceSignal =
      resource instanceof Request ? resource.signal : undefined;
    const callerSignal = init?.signal ?? resourceSignal;
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    const response = await request(resource, {
      ...init,
      redirect: "error",
      signal,
    });
    return boundedResponse(response);
  };
}

function octokitClass(request: Fetch) {
  return Octokit.defaults({
    baseUrl: GITHUB_API_ORIGIN,
    userAgent: USER_AGENT,
    request: { fetch: createGuardedGitHubFetch(request) },
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    log: silentConsole,
  });
}

export function createGitHubOAuthApp(input: {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  codeVerifier?: string;
  fetch?: Fetch;
}) {
  const request = input.fetch ?? fetch;
  const oauthFetch: Fetch = async (resource, init) => {
    const url = requestUrl(resource);
    if (
      input.codeVerifier !== undefined &&
      url.origin === GITHUB_ORIGIN &&
      url.pathname === "/login/oauth/access_token"
    ) {
      if (typeof init?.body !== "string")
        throw new Error("github-oauth-request-invalid");
      let body: string;
      try {
        const parsed = JSON.parse(init.body) as unknown;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed) ||
          "code_verifier" in parsed
        )
          throw new Error("invalid-body");
        body = JSON.stringify({ ...parsed, code_verifier: input.codeVerifier });
      } catch (error) {
        if (error instanceof SyntaxError) {
          const parsed = new URLSearchParams(init.body);
          if (parsed.has("code_verifier"))
            throw new Error("github-oauth-request-invalid");
          parsed.set("code_verifier", input.codeVerifier);
          body = parsed.toString();
        } else {
          throw new Error("github-oauth-request-invalid");
        }
      }
      return request(resource, { ...init, body });
    }
    return request(resource, init);
  };
  return new OAuthApp({
    clientType: "github-app",
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUrl: input.redirectUrl,
    Octokit: octokitClass(oauthFetch),
    log: silentConsole,
  });
}

export function createGitHubApp(input: {
  appId: string;
  privateKey: string;
  fetch?: Fetch;
}) {
  return new App({
    appId: input.appId,
    privateKey: input.privateKey,
    Octokit: octokitClass(input.fetch ?? fetch),
    log: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
  });
}

export function createGitHubTokenOctokit(input: {
  token: string;
  fetch?: Fetch;
}) {
  const GitHubOctokit = octokitClass(input.fetch ?? fetch);
  return new GitHubOctokit({ auth: input.token });
}
