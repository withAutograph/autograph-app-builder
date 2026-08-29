import { createMcpHandler } from "mcp-handler";

import {
  authorizeHostedPrincipal,
  HostedAuthorizationError,
  type HostedPrincipal,
} from "../eve/hosted-auth";
import {
  createHostedEveSessionService,
  type HostedEveTransport,
} from "../eve/hosted-service";
import {
  createEveSessionService,
  type EveSessionService,
} from "../eve/service";
import type { HostedEveStore } from "../eve/hosted-store";
import type { HostedPreviewAdmissionControlBinding } from "../hosted/admission-control";
import { attachPrototypePreviewUrl } from "./browser-preview";
import {
  eveCancelInputSchema,
  eveGetInputSchema,
  eveRespondInputSchema,
  eveSendInputSchema,
  eveSessionResultSchema,
  eveStartInputSchema,
} from "./contracts";
import {
  forbiddenResponse,
  hostedMcpAuthConfigSchema,
  notFoundResponse,
  parseStrictBearerAuthorization,
  unauthorizedResponse,
  unavailableResponse,
  type HostedAccessTokenVerifier,
  type HostedMcpAuthConfig,
} from "./request-auth";
import { safeToolError, SESSION_RESOURCE_URI, toolResult } from "./result";
import { MCP_APP_RESOURCE_MIME_TYPE, sessionUiHtml } from "./session-ui";

const sessionResourceMeta = {
  ui: {
    prefersBorder: false,
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: ["about:"],
      baseUriDomains: [],
    },
  },
} as const;

export interface HostedWorkspaceMembership {
  isMember(input: {
    principal: HostedPrincipal;
    workspaceId: string;
  }): Promise<boolean>;
}

export interface HostedMcpRuntime {
  auth: HostedMcpAuthConfig;
  verifier: HostedAccessTokenVerifier;
  membership: HostedWorkspaceMembership;
  store: HostedEveStore;
  transport: HostedEveTransport;
  admissionControl?: HostedPreviewAdmissionControlBinding;
  now?: () => number;
}

export function createAutographMcpHandler(
  service: EveSessionService,
  options: { requestUrl?: string } = {},
) {
  const present = (result: Awaited<ReturnType<EveSessionService["get"]>>) =>
    options.requestUrl === undefined
      ? result
      : attachPrototypePreviewUrl(result, options.requestUrl);
  return createMcpHandler((server) => {
    server.registerResource(
      "autograph-session",
      SESSION_RESOURCE_URI,
      {
        title: "Autograph App Builder progress",
        description: "Live progress and requests from Autograph App Builder.",
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        _meta: sessionResourceMeta,
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: MCP_APP_RESOURCE_MIME_TYPE,
            text: sessionUiHtml,
            _meta: sessionResourceMeta,
          },
        ],
      }),
    );

    server.registerTool(
      "autograph_start",
      {
        title: "Start with Autograph App Builder",
        description:
          "Start a durable app build and return immediately; check progress separately.",
        inputSchema: eveStartInputSchema,
        outputSchema: eveSessionResultSchema,
        _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.start(input)),
            "Autograph App Builder started the app build.",
          );
        } catch (error) {
          return safeToolError(error);
        }
      },
    );
    server.registerTool(
      "autograph_get",
      {
        title: "Check App Builder progress",
        description:
          "Read the next page of progress and requests for the current app build.",
        inputSchema: eveGetInputSchema,
        outputSchema: eveSessionResultSchema,
        _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.get(input)),
            "Autograph App Builder returned the latest progress.",
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      },
    );
    server.registerTool(
      "autograph_send",
      {
        title: "Send App Builder feedback",
        description:
          "Send additional direction while the current app build is waiting.",
        inputSchema: eveSendInputSchema,
        outputSchema: eveSessionResultSchema,
        _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.send(input)),
            "Autograph App Builder received the feedback.",
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      },
    );
    server.registerTool(
      "autograph_respond",
      {
        title: "Answer App Builder questions",
        description:
          "Answer the complete outstanding set of App Builder questions in one response.",
        inputSchema: eveRespondInputSchema,
        outputSchema: eveSessionResultSchema,
        _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.respond(input)),
            "Autograph App Builder recorded the answers.",
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      },
    );
    server.registerTool(
      "autograph_cancel",
      {
        title: "Stop App Builder work",
        description: "Request cancellation of the active app build.",
        inputSchema: eveCancelInputSchema,
        outputSchema: eveSessionResultSchema,
        _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
      },
      async (input) => {
        try {
          return toolResult(
            present(await service.cancel(input)),
            "Autograph App Builder received the stop request.",
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      },
    );
  });
}

function adapterMode(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): "local" | "hosted" | "unconfigured" | "invalid" {
  const local = environment.APP_BUILDER_LOCAL_ADAPTER;
  const hosted = environment.EVE_HOSTED_ADAPTER;
  if (![undefined, "0", "1"].includes(local)) return "invalid";
  if (![undefined, "0", "1"].includes(hosted)) return "invalid";
  if (local === "1" && hosted === "1") return "invalid";
  if (hosted === "1") return "hosted";
  if (local === "1") return "local";
  return "unconfigured";
}

async function hostedServiceForRequest(
  request: Request,
  runtime: HostedMcpRuntime,
): Promise<EveSessionService | Response> {
  const parsedAuth = hostedMcpAuthConfigSchema.safeParse(runtime.auth);
  if (!parsedAuth.success) return unavailableResponse();
  const auth = parsedAuth.data;
  if (runtime.admissionControl === undefined) return unavailableResponse();
  let token: string;
  try {
    token = parseStrictBearerAuthorization(
      request.headers.get("authorization"),
    );
  } catch {
    return unauthorizedResponse(auth);
  }

  let verifiedClaims;
  try {
    verifiedClaims = await runtime.verifier.verify({
      token,
      nowEpochSeconds: Math.floor((runtime.now?.() ?? Date.now()) / 1_000),
    });
  } catch {
    return unauthorizedResponse(auth);
  }

  let principal: HostedPrincipal;
  try {
    principal = authorizeHostedPrincipal({
      verifiedClaims,
      expectedIssuer: auth.issuer,
      expectedAudience: auth.audience,
      requiredScopes: ["autograph:session"],
    });
  } catch (error) {
    if (
      error instanceof HostedAuthorizationError &&
      error.code === "insufficient_scope"
    ) {
      return forbiddenResponse(auth);
    }
    return unauthorizedResponse(auth);
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

  return createHostedEveSessionService({
    principal,
    store: runtime.store,
    transport: runtime.transport,
    admissionControl: runtime.admissionControl,
    now: runtime.now,
  });
}

export function createMcpRequestHandler(
  input: {
    environment?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    hostedRuntime?: HostedMcpRuntime;
  } = {},
) {
  const environment = input.environment ?? process.env;
  return async (request: Request): Promise<Response> => {
    const mode = adapterMode(environment);
    if (mode === "invalid") return unavailableResponse();
    if (mode === "hosted") {
      if (input.hostedRuntime === undefined) return unavailableResponse();
      const selected = await hostedServiceForRequest(
        request,
        input.hostedRuntime,
      );
      if (selected instanceof Response) return selected;
      return createAutographMcpHandler(selected, { requestUrl: request.url })(
        request,
      );
    }
    if (mode === "local") {
      try {
        return createAutographMcpHandler(createEveSessionService(environment), {
          requestUrl: request.url,
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
