import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { OAuthApp } from "@octokit/oauth-app";
import { z } from "zod";

const GITHUB_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "autograph-app-builder";
const SILENT_LOG_METHODS = new Set(["debug", "info", "warn", "error", "log"]);
const OAUTH_REQUEST_INVALID = "github-oauth-request-invalid";
const silentConsole = new Proxy(console, {
  get: (target, property) => {
    if (SILENT_LOG_METHODS.has(String(property)) && property in console) {
      return () => {
        // The mocked request has no teardown.
      };
    }
    const value: unknown = Object.getOwnPropertyDescriptor(target, property)?.value;
    return value;
  },
});

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const requestUrl = (resource: RequestInfo | URL): URL => {
  if (resource instanceof URL) {
    return resource;
  }
  const request = resource instanceof Request ? resource : new Request(resource);
  return new URL(request.url);
};

const oauthJsonValueSchema = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(oauthJsonValueSchema),
    z.record(z.string(), oauthJsonValueSchema),
  ]),
);
const oauthJsonBodySchema = z.record(z.string(), oauthJsonValueSchema);
type OAuthJsonBody = z.infer<typeof oauthJsonBodySchema>;

const parseOAuthJsonBody = (body: string): OAuthJsonBody | undefined => {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = oauthJsonBodySchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return undefined;
};

const parseOAuthBodyInput = (value: BodyInit | null | undefined): string | undefined =>
  Object.prototype.toString.call(value) === "[object String]"
    ? String.prototype.valueOf.call(value)
    : undefined;

const parseOAuthBody = (
  body: string,
): { kind: "json"; value: OAuthJsonBody } | { kind: "form"; value: URLSearchParams } => {
  const parsed = parseOAuthJsonBody(body);
  if (parsed) return { kind: "json", value: parsed };
  return { kind: "form", value: new URLSearchParams(body) };
};

export const createGuardedGitHubFetch =
  (request: Fetch = fetch): Fetch =>
  async (resource, init) => {
    const url = requestUrl(resource);
    if (
      (url.origin !== GITHUB_ORIGIN && url.origin !== GITHUB_API_ORIGIN) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error("github-origin-invalid");
    }

    const resourceSignal = resource instanceof Request ? resource.signal : undefined;
    const callerSignal = init?.signal ?? resourceSignal;
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    const response = await request(resource, {
      ...init,
      redirect: "error",
      signal,
    });
    return response;
  };

const octokitClass = (request: Fetch) =>
  Octokit.defaults({
    baseUrl: GITHUB_API_ORIGIN,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
    },
    log: silentConsole,
    request: { fetch: createGuardedGitHubFetch(request) },
    userAgent: USER_AGENT,
  });

export const createGitHubOAuthApp = (input: {
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  codeVerifier?: string;
  fetch?: Fetch;
}) => {
  const request = input.fetch ?? fetch;
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  const oauthFetch: Fetch = async (resource, init) => {
    const url = requestUrl(resource);
    if (
      input.codeVerifier !== undefined &&
      url.origin === GITHUB_ORIGIN &&
      url.pathname === "/login/oauth/access_token"
    ) {
      const bodyInput = parseOAuthBodyInput(init?.body);
      if (bodyInput === undefined) {
        throw new TypeError(OAUTH_REQUEST_INVALID);
      }
      const bodyText = bodyInput;
      let body: string;
      const parsed = parseOAuthBody(bodyText);
      if (parsed.kind === "json") {
        if ("code_verifier" in parsed.value) {
          throw new TypeError(OAUTH_REQUEST_INVALID);
        }
        body = JSON.stringify({ ...parsed.value, code_verifier: input.codeVerifier });
      } else {
        if (parsed.value.has("code_verifier")) {
          throw new TypeError(OAUTH_REQUEST_INVALID);
        }
        parsed.value.set("code_verifier", input.codeVerifier);
        body = parsed.value.toString();
      }
      return await request(resource, { ...init, body });
    }
    return await request(resource, init);
  };
  return new OAuthApp({
    Octokit: octokitClass(oauthFetch),
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    clientType: "github-app",
    log: silentConsole,
    redirectUrl: input.redirectUrl,
  });
};

export const createGitHubApp = (input: { appId: string; privateKey: string; fetch?: Fetch }) =>
  new App({
    Octokit: octokitClass(input.fetch ?? fetch),
    appId: input.appId,
    log: {
      debug() {
        // Keep the test logger silent.
      },
      error() {
        // Keep the test logger silent.
      },
      info() {
        // Keep the test logger silent.
      },
      warn() {
        // Keep the test logger silent.
      },
    },
    privateKey: input.privateKey,
  });

export const createGitHubTokenOctokit = (input: { token: string; fetch?: Fetch }) => {
  const GitHubOctokit = octokitClass(input.fetch ?? fetch);
  return new GitHubOctokit({ auth: input.token });
};
