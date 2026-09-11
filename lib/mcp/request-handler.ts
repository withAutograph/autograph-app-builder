import { createMcpHandler } from "mcp-handler";

import {
  authorizeHostedPrincipal,
  HostedAuthorizationError,
} from "../eve/hosted-auth";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { createHostedEveSessionService } from "../eve/hosted-service";
import type { HostedEveTransport } from "../eve/hosted-service";
import type { HostedEveStore } from "../eve/hosted-store";
import { createEveSessionService } from "../eve/service";
import type { EveSessionService } from "../eve/service";
import {
  attachPrototypePreviewUrl,
  prototypePreviewRequestUrl,
} from "./browser-preview";
import {
  eveCancelInputSchema,
  eveGetInputSchema,
  eveGetResultSchema,
  eveRespondInputSchema,
  eveSendInputSchema,
  eveSessionResultSchema,
  eveStartInputSchema,
} from "./contracts";
import type { EveSessionListResult, EveSessionResult } from "./contracts";
import {
  forbiddenResponse,
  hostedMcpAuthConfigSchema,
  notFoundResponse,
  parseStrictBearerAuthorization,
  unauthorizedResponse,
  unavailableResponse,
} from "./request-auth";
import type {
  HostedAccessTokenVerifier,
  HostedMcpAuthConfig,
} from "./request-auth";
import {
  McpToolAuthenticationRequiredError,
  McpProviderUnavailableError,
  safeToolError,
  SESSION_RESOURCE_URI,
  toolResult,
} from "./result";
import { MCP_APP_RESOURCE_MIME_TYPE, sessionUiHtml } from "./session-ui";

const sessionResourceMeta = {
  ui: {
    csp: {
      baseUriDomains: [],
      connectDomains: [],
      frameDomains: ["about:"],
      resourceDomains: [],
    },
    prefersBorder: false,
  },
} as const;

const autographToolScopes = [
  "autograph:session",
  "autograph:start",
  "autograph:get",
  "autograph:send",
  "autograph:respond",
  "autograph:cancel",
] as const;

export interface HostedWorkspaceMembership {
  isMember(input: {
    principal: HostedPrincipal;
    workspaceId: string;
  }): Promise<boolean>;
}

type HostedHandoffAuthority = Pick<
  HostedPrincipal,
  "issuer" | "audience" | "workspaceId" | "ownerUserId"
>;

export interface HostedBuilderHandoffRuntime {
  resolve(input: {
    authority: HostedHandoffAuthority;
    handoffId: string;
  }): Promise<
    | { status: "redeemed"; sessionId: string }
    | {
        status: "unredeemed";
        prompt: string;
        deterministicClientRequestId: string;
        record: {
          requestDigest: string;
          intent: {
            repository: {
              requestedName: string;
              resolvedFullName?: string;
            };
          };
        };
      }
  >;
  bindSession(input: {
    authority: HostedHandoffAuthority;
    handoffId: string;
    requestDigest: string;
    sessionId: string;
  }): Promise<unknown>;
  recheckRepositoryAccess(input: {
    principal: HostedPrincipal;
    repository: string;
    sourceHandoffId?: string;
  }): Promise<
    | { status: "ready" }
    | {
        status: "authorization-required";
        action: "connect" | "update";
      }
    | { status: "scope-selection-required" }
    | { status: "provider-unavailable" }
  >;
}

export interface HostedMcpRuntime {
  auth: HostedMcpAuthConfig;
  verifier: HostedAccessTokenVerifier;
  membership: HostedWorkspaceMembership;
  store: HostedEveStore;
  transport: HostedEveTransport;
  handoffs?: HostedBuilderHandoffRuntime;
  beforeRead?: Parameters<
    typeof createHostedEveSessionService
  >[0]["beforeRead"];
  now?: () => number;
}

export function withHostedBuilderHandoffs(input: {
  service: EveSessionService;
  principal: HostedPrincipal;
  handoffs: HostedBuilderHandoffRuntime;
}): EveSessionService {
  const authority = {
    audience: input.principal.audience,
    issuer: input.principal.issuer,
    ownerUserId: input.principal.ownerUserId,
    workspaceId: input.principal.workspaceId,
  };
  return {
    ...input.service,
    async start(request) {
      if (request.handoffId === undefined) {
        return input.service.start(request);
      }
      const resolved = await input.handoffs.resolve({
        authority,
        handoffId: request.handoffId,
      });
      if (resolved.status === "redeemed") {
        return input.service.recoverStart === undefined
          ? Promise.reject(new Error("handoff-start-recovery-unavailable"))
          : input.service.recoverStart({
              sessionId: resolved.sessionId,
              cursor: 0,
              limit: 100,
            });
      }
      const resolvedRepository =
        resolved.record.intent.repository.resolvedFullName;
      if (resolvedRepository !== undefined) {
        const access = await input.handoffs.recheckRepositoryAccess({
          principal: input.principal,
          repository: resolvedRepository,
          sourceHandoffId: request.handoffId,
        });
        if (access.status === "provider-unavailable") {
          throw new McpProviderUnavailableError();
        }
      }
      const result = await input.service.start({
        clientRequestId: resolved.deterministicClientRequestId,
        prompt: resolved.prompt,
        sourceHandoffId: request.handoffId,
      });
      await input.handoffs.bindSession({
        authority,
        handoffId: request.handoffId,
        requestDigest: resolved.record.requestDigest,
        sessionId: result.sessionId,
      });
      return result;
    },
  };
}

export function createAutographMcpHandler(
  service: EveSessionService,
  options: { requestUrl?: string; advertiseOauth?: boolean } = {}
) {
  const toolAuthMeta = (
    _operation: string,
    meta: Record<string, unknown> = {}
  ) =>
    options.advertiseOauth
      ? {
          _meta: {
            ...meta,
            securitySchemes: [
              {
                scopes: [...autographToolScopes],
                type: "oauth2" as const,
              },
            ],
          },
        }
      : Object.keys(meta).length > 0
        ? { _meta: meta }
        : {};
  const present = (result: EveSessionListResult | EveSessionResult) =>
    "kind" in result || options.requestUrl === undefined
      ? result
      : attachPrototypePreviewUrl(result, options.requestUrl);
  return createMcpHandler((server) => {
    server.registerResource(
      "autograph-session",
      SESSION_RESOURCE_URI,
      {
        _meta: sessionResourceMeta,
        description: "Live progress and requests from Autograph App Builder.",
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        title: "Autograph App Builder progress",
      },
      async (uri) => ({
        contents: [
          {
            _meta: sessionResourceMeta,
            mimeType: MCP_APP_RESOURCE_MIME_TYPE,
            text: sessionUiHtml,
            uri: uri.href,
          },
        ],
      })
    );

    server.registerTool(
      "autograph_start",
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Start reversible App Builder work and return immediately. This only manages an App Builder session; it cannot publish, deploy, provision, or modify the user's repository without a later in-product approval.",
        inputSchema: eveStartInputSchema,
        outputSchema: eveSessionResultSchema,
        title: "Start with Autograph App Builder",
        ...toolAuthMeta("start"),
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.start(input)),
            "Autograph App Builder started the app build."
          );
        } catch (error) {
          return safeToolError(error);
        }
      }
    );
    server.registerTool(
      "autograph_get",
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
        description:
          "List recent app builds, or read the next page of one app build's progress and requests.",
        inputSchema: eveGetInputSchema,
        outputSchema: eveGetResultSchema,
        title: "Check App Builder progress",
        ...toolAuthMeta("get"),
      },
      async (input) => {
        try {
          const result =
            input.sessionId === undefined
              ? await service.list({ cursor: input.cursor, limit: input.limit })
              : await service.get({
                  cursor: input.cursor,
                  limit: input.limit,
                  sessionId: input.sessionId,
                });
          return toolResult(
            present(result),
            "Autograph App Builder returned the latest progress."
          );
        } catch (error) {
          return safeToolError(error, input.sessionId ?? "");
        }
      }
    );
    server.registerTool(
      "autograph_send",
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Send additional direction to an App Builder session. This cannot publish, deploy, provision, or modify the user's repository without a later in-product approval.",
        inputSchema: eveSendInputSchema,
        outputSchema: eveSessionResultSchema,
        title: "Send App Builder feedback",
        ...toolAuthMeta("send"),
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.send(input)),
            "Autograph App Builder received the feedback."
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      }
    );
    server.registerTool(
      "autograph_respond",
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Answer the complete outstanding set of App Builder questions in one response. This cannot publish, deploy, provision, or modify the user's repository without a later in-product approval.",
        inputSchema: eveRespondInputSchema,
        outputSchema: eveSessionResultSchema,
        title: "Answer App Builder questions",
        ...toolAuthMeta("respond", {
          ui: { visibility: ["model", "app"] },
        }),
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.respond(input)),
            "Autograph App Builder recorded the answers."
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      }
    );
    server.registerTool(
      "autograph_cancel",
      {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Request cancellation of the active App Builder session. This cannot publish, deploy, provision, or modify the user's repository.",
        inputSchema: eveCancelInputSchema,
        outputSchema: eveSessionResultSchema,
        title: "Stop App Builder work",
        ...toolAuthMeta("cancel"),
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.cancel(input)),
            "Autograph App Builder received the stop request."
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      }
    );
  });
}

function adapterMode(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
): "local" | "hosted" | "unconfigured" | "invalid" {
  const local = environment.APP_BUILDER_LOCAL_ADAPTER;
  const hosted = environment.EVE_HOSTED_ADAPTER;
  if (![undefined, "0", "1"].includes(local)) {
    return "invalid";
  }
  if (![undefined, "0", "1"].includes(hosted)) {
    return "invalid";
  }
  if (local === "1" && hosted === "1") {
    return "invalid";
  }
  if (hosted === "1") {
    return "hosted";
  }
  if (local === "1") {
    return "local";
  }
  return "unconfigured";
}

const publicDiscoveryMethods = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
]);

async function isPublicDiscoveryRequest(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return (
      messages.length > 0 &&
      messages.every(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          typeof message.method === "string" &&
          publicDiscoveryMethods.has(message.method)
      )
    );
  } catch {
    return false;
  }
}

const discoveryOnlyService = new Proxy({} as EveSessionService, {
  get() {
    return async () => {
      throw new Error("Authentication is required before calling a tool.");
    };
  },
});

function authenticationRequiredService(challenge: string) {
  return new Proxy({} as EveSessionService, {
    get() {
      return async () => {
        throw new McpToolAuthenticationRequiredError(challenge);
      };
    },
  });
}

async function isToolCallRequest(request: Request): Promise<boolean> {
  try {
    const body: unknown = await request.clone().json();
    return (
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      body.method === "tools/call"
    );
  } catch {
    return false;
  }
}

const hostedToolNames = new Set([
  "autograph_start",
  "autograph_get",
  "autograph_send",
  "autograph_respond",
  "autograph_cancel",
]);

async function requiredScopesForRequest(request: Request): Promise<string[]> {
  try {
    const body: unknown = await request.clone().json();
    if (
      typeof body === "object" &&
      body !== null &&
      "method" in body &&
      body.method === "tools/call" &&
      "params" in body &&
      typeof body.params === "object" &&
      body.params !== null &&
      "name" in body.params &&
      typeof body.params.name === "string"
    ) {
      if (hostedToolNames.has(body.params.name)) {
        return [...autographToolScopes];
      }
    }
  } catch {
    // Malformed requests remain subject to the session scope and MCP parsing.
  }
  return ["autograph:session"];
}

async function hostedServiceForRequest(
  request: Request,
  runtime: HostedMcpRuntime
): Promise<EveSessionService | Response> {
  const parsedAuth = hostedMcpAuthConfigSchema.safeParse(runtime.auth);
  if (!parsedAuth.success) {
    return unavailableResponse();
  }
  const auth = parsedAuth.data;
  const requiredScopes = await requiredScopesForRequest(request);
  let token: string;
  try {
    token = parseStrictBearerAuthorization(
      request.headers.get("authorization")
    );
  } catch {
    return unauthorizedResponse(auth, requiredScopes);
  }

  let verifiedClaims;
  try {
    verifiedClaims = await runtime.verifier.verify({
      nowEpochSeconds: Math.floor((runtime.now?.() ?? Date.now()) / 1_000),
      token,
    });
  } catch {
    return unauthorizedResponse(auth, requiredScopes);
  }

  let principal: HostedPrincipal;
  try {
    principal = authorizeHostedPrincipal({
      expectedAudience: auth.audience,
      expectedIssuer: auth.issuer,
      requiredScopes,
      verifiedClaims,
    });
  } catch (error) {
    if (
      error instanceof HostedAuthorizationError &&
      error.code === "insufficient_scope"
    ) {
      return forbiddenResponse(auth, requiredScopes);
    }
    return unauthorizedResponse(auth, requiredScopes);
  }

  try {
    // The signed claim is the sole selector. The runtime membership adapter
    // must still perform a live exact subject/workspace read on every request.
    if (
      !(await runtime.membership.isMember({
        principal,
        workspaceId: principal.workspaceId,
      }))
    ) {
      return notFoundResponse();
    }
  } catch {
    return notFoundResponse();
  }

  const service = createHostedEveSessionService({
    principal,
    store: runtime.store,
    transport: runtime.transport,
    ...(runtime.beforeRead === undefined
      ? {}
      : { beforeRead: runtime.beforeRead }),
    now: runtime.now,
  });
  return runtime.handoffs === undefined
    ? service
    : withHostedBuilderHandoffs({
        handoffs: runtime.handoffs,
        principal,
        service,
      });
}

export function createMcpRequestHandler(
  input: {
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    hostedRuntime?: HostedMcpRuntime;
  } = {}
) {
  const environment = input.environment ?? process.env;
  return async (request: Request): Promise<Response> => {
    const mode = adapterMode(environment);
    if (mode === "invalid") {
      return unavailableResponse();
    }
    if (mode === "hosted") {
      if (input.hostedRuntime === undefined) {
        return unavailableResponse();
      }
      if (await isPublicDiscoveryRequest(request)) {
        return createAutographMcpHandler(discoveryOnlyService, {
          advertiseOauth: true,
          requestUrl: request.url,
        })(request);
      }
      const selected = await hostedServiceForRequest(
        request,
        input.hostedRuntime
      );
      if (selected instanceof Response) {
        const challenge = selected.headers.get("www-authenticate");
        if (
          challenge !== null &&
          (selected.status === 401 || selected.status === 403) &&
          (await isToolCallRequest(request))
        ) {
          return createAutographMcpHandler(
            authenticationRequiredService(challenge),
            { advertiseOauth: true, requestUrl: request.url }
          )(request);
        }
        return selected;
      }
      return createAutographMcpHandler(selected, {
        advertiseOauth: true,
        requestUrl: request.url,
      })(request);
    }
    if (mode === "local") {
      try {
        return createAutographMcpHandler(createEveSessionService(environment), {
          requestUrl: prototypePreviewRequestUrl({
            environment,
            requestUrl: request.url,
          }),
        })(request);
      } catch {
        return unavailableResponse();
      }
    }
    return createAutographMcpHandler(createEveSessionService(environment), {
      requestUrl: request.url,
    })(request);
  };
}
