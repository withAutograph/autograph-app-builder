import { z } from "zod";

const redirectResponseSchema = z
  .object({
    url: z.string().optional(),
    redirect_uri: z.string().optional(),
  })
  .passthrough();

const publicClientSchema = z
  .object({
    client_id: z.string().min(1).max(2_048),
    client_name: z.string().min(1).max(256).optional(),
    client_uri: z.string().url().startsWith("https://").optional(),
  })
  .passthrough();

export type PreviewConsentContext = {
  clientId: string;
  clientName: string;
  clientUri?: string;
  requestedScopes: string[];
};

function isAllowedBrowserRedirect(value: string): boolean {
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")
    );
  } catch {
    return false;
  }
}

export async function postPreviewOAuthInteraction(input: {
  endpoint: string;
  body: Record<string, unknown>;
  fetcher?: typeof fetch;
}): Promise<string | undefined> {
  const response = await (input.fetcher ?? fetch)(input.endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input.body),
    redirect: "manual",
  });

  if (!response.ok && response.type !== "opaqueredirect") {
    throw new Error("The Preview authorization request was rejected.");
  }
  if (response.type === "opaqueredirect") return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    if (response.redirected && isAllowedBrowserRedirect(response.url)) {
      return response.url;
    }
    return undefined;
  }

  const result = redirectResponseSchema.parse(await response.json());
  const redirect = result.redirect_uri ?? result.url;
  if (redirect === undefined) return undefined;
  if (!isAllowedBrowserRedirect(redirect)) {
    throw new Error("The authorization server returned an unsafe redirect.");
  }
  return new URL(redirect, window.location.origin).toString();
}

export function currentOAuthQuery(search: string): string {
  return search.startsWith("?") ? search.slice(1) : search;
}

export async function loadPreviewConsentContext(input: {
  search: string;
  fetcher?: typeof fetch;
}): Promise<PreviewConsentContext> {
  const oauthQuery = currentOAuthQuery(input.search);
  const params = new URLSearchParams(oauthQuery);
  const clientIds = params.getAll("client_id");
  const scopes = params.getAll("scope");
  const signatures = params.getAll("sig");
  if (
    clientIds.length !== 1 ||
    clientIds[0] === "" ||
    scopes.length !== 1 ||
    scopes[0] === "" ||
    signatures.length !== 1 ||
    signatures[0] === ""
  ) {
    throw new Error("The signed authorization request is malformed.");
  }
  const requestedScopes = scopes[0]!.split(" ").filter(Boolean);
  if (
    requestedScopes.length === 0 ||
    new Set(requestedScopes).size !== requestedScopes.length
  ) {
    throw new Error("The signed authorization scopes are malformed.");
  }
  const response = await (input.fetcher ?? fetch)(
    "/api/auth/oauth2/public-client-prelogin",
    {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: clientIds[0],
        oauth_query: oauthQuery,
      }),
      redirect: "error",
    },
  );
  if (
    !response.ok ||
    !(response.headers.get("content-type") ?? "").includes("application/json")
  ) {
    throw new Error("The verified OAuth client is unavailable.");
  }
  const client = publicClientSchema.parse(await response.json());
  if (client.client_id !== clientIds[0]) {
    throw new Error("The verified OAuth client identity changed.");
  }
  return {
    clientId: client.client_id,
    clientName: client.client_name ?? client.client_id,
    ...(client.client_uri === undefined
      ? {}
      : { clientUri: client.client_uri }),
    requestedScopes,
  };
}
