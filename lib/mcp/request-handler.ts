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

const sessionHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eve session</title><style>body{font:14px system-ui;margin:0;padding:20px;color:#171717;background:#fafafa}main{max-width:42rem;margin:auto}code{background:#eee;padding:.15rem .35rem;border-radius:.25rem}</style></head><body><main><h1>Eve session</h1><p>The host initializes this MCP App and supplies tool results. Complete the production bridge in <code>app/ui/session</code>.</p></main></body></html>`;

export function createEveMcpHandler(service: EveSessionService) {
  return createMcpHandler((server) => {
    server.registerResource(
      "eve-session",
      SESSION_RESOURCE_URI,
      { title: "Eve session", mimeType: "text/html" },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/html", text: sessionHtml }],
      }),
    );

    server.registerTool(
      "eve_start",
      {
        title: "Start Eve work",
        description:
          "Start a new durable Eve objective and return immediately.",
        inputSchema: eveStartInputSchema,
        outputSchema: eveSessionResultSchema,
        _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
      },
      async (input) => {
        try {
          return toolResult(
            await service.start(input),
            "Eve accepted the objective.",
          );
        } catch (error) {
          return safeToolError(error);
        }
      },
    );
    server.registerTool(
      "eve_get",
      {
        title: "Get Eve session",
        description: "Read the next bounded page of public session events.",
        inputSchema: eveGetInputSchema,
        outputSchema: eveSessionResultSchema,
        _meta: { ui: { resourceUri: SESSION_RESOURCE_URI } },
      },
      async (input) => {
        try {
          return toolResult(
            await service.get(input),
            "Fetched the Eve session.",
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      },
    );
    server.registerTool(
      "eve_send",
      {
        title: "Send Eve follow-up",
        description: "Send a follow-up while an owned session is waiting.",
        inputSchema: eveSendInputSchema,
        outputSchema: eveSessionResultSchema,
      },
      async (input) => {
        try {
          return toolResult(await service.send(input), "Sent the follow-up.");
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      },
    );
    server.registerTool(
      "eve_respond",
      {
        title: "Respond to Eve request",
        description:
          "Answer one specific outstanding input or approval request.",
        inputSchema: eveRespondInputSchema,
        outputSchema: eveSessionResultSchema,
      },
      async (input) => {
        try {
          return toolResult(
            await service.respond(input),
            "Recorded the response.",
          );
        } catch (error) {
          return safeToolError(error, input.sessionId);
        }
      },
    );
    server.registerTool(
      "eve_cancel",
      {
        title: "Cancel Eve turn",
        description: "Request cooperative cancellation of the active Eve turn.",
        inputSchema: eveCancelInputSchema,
        outputSchema: eveSessionResultSchema,
      },
      async (input) => {
        try {
          return toolResult(
            await service.cancel(input),
            "Cancellation was requested.",
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
      requiredScopes: ["eve:session"],
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
      return createEveMcpHandler(selected)(request);
    }
    if (mode === "local") {
      try {
        return createEveMcpHandler(createEveSessionService(environment))(
          request,
        );
      } catch {
        return unavailableResponse();
      }
    }
    return createEveMcpHandler(createEveSessionService(environment))(request);
  };
}
