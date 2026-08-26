import { z } from "zod";

import {
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
  type HostedEngineSnapshot,
  type HostedEveTransport,
} from "./hosted-service";
import { hostedPrincipalSchema, type HostedPrincipal } from "./hosted-auth";
import { sessionStatusSchema } from "../mcp/contracts";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const snapshotSchema = z
  .object({
    status: sessionStatusSchema,
    events: z.array(z.unknown()).max(100_000),
  })
  .strict();

const startResponseSchema = z
  .object({
    adapterSessionId: z.string().min(1).max(500),
    snapshot: snapshotSchema,
  })
  .strict();

const rejectionSchema = z
  .object({
    error: z.literal("rejected_before_dispatch"),
    code: z.string().min(1).max(100),
  })
  .strict();

const membershipResponseSchema = z.object({ member: z.boolean() }).strict();

export interface HostedWorkloadIdentity {
  token(input: {
    audience: string;
    principal: HostedPrincipal;
  }): Promise<string>;
}

const hostedHttpConfigSchema = z
  .object({
    baseUrl: z.string().url().startsWith("https://"),
    workloadAudience: z.string().min(1).max(300),
    timeoutMs: z.number().int().min(1).max(30_000).default(DEFAULT_TIMEOUT_MS),
  })
  .strict()
  .transform((config, context) => {
    const baseUrl = new URL(config.baseUrl);
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash ||
      (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Hosted Eve base URL must be an origin without credentials.",
      });
      return z.NEVER;
    }
    return { ...config, baseUrl: baseUrl.origin };
  });

type HostedHttpConfig = z.infer<typeof hostedHttpConfigSchema>;

function endpoint(config: HostedHttpConfig, path: string) {
  return new URL(path, `${config.baseUrl}/`).href;
}

function exactToken(value: string) {
  const token = value.trim();
  if (token.length === 0 || token.length > 8_192 || /[\r\n]/u.test(token)) {
    throw new Error("Hosted workload identity token is unavailable.");
  }
  return token;
}

async function workloadToken(
  config: HostedHttpConfig,
  identity: HostedWorkloadIdentity,
  principalInput: HostedPrincipal,
) {
  const principal = hostedPrincipalSchema.parse(principalInput);
  return exactToken(
    await identity.token({ audience: config.workloadAudience, principal }),
  );
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Hosted Eve redirects are not allowed.");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (contentType !== "application/json") {
    throw new Error("Hosted Eve returned a non-JSON response.");
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error("Hosted Eve response is too large.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("Hosted Eve response is too large.");
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function request(input: {
  config: HostedHttpConfig;
  identity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  path: string;
  principal: HostedPrincipal;
  body: unknown;
  token?: string;
}) {
  const token =
    input.token ??
    (await workloadToken(input.config, input.identity, input.principal));
  return input.fetchImplementation(endpoint(input.config, input.path), {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(input.config.timeoutMs),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      principal: hostedPrincipalSchema.parse(input.principal),
      ...z.record(z.string(), z.unknown()).parse(input.body),
    }),
  });
}

async function mutation<T>(input: {
  config: HostedHttpConfig;
  identity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  path: string;
  principal: HostedPrincipal;
  body: unknown;
  result: z.ZodType<T>;
}): Promise<T> {
  let token: string;
  try {
    token = await workloadToken(input.config, input.identity, input.principal);
  } catch {
    throw new SubmissionRejectedBeforeDispatchError(
      "workload_identity_unavailable",
    );
  }
  let response: Response;
  try {
    response = await request({ ...input, token });
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    // Once fetch is invoked, the transport cannot know whether Eve received
    // the request even when the local call rejects.
    throw new SubmissionOutcomeUnknownError();
  }
  try {
    const body = await parseJsonResponse(response);
    if (response.status === 422) {
      const rejection = rejectionSchema.parse(body);
      throw new SubmissionRejectedBeforeDispatchError(rejection.code);
    }
    if (response.status !== 200) throw new Error("Unexpected response status.");
    return input.result.parse(body);
  } catch (error) {
    if (error instanceof SubmissionRejectedBeforeDispatchError) throw error;
    throw new SubmissionOutcomeUnknownError();
  }
}

async function observation<T>(input: {
  config: HostedHttpConfig;
  identity: HostedWorkloadIdentity;
  fetchImplementation: typeof fetch;
  path: string;
  principal: HostedPrincipal;
  body: unknown;
  result: z.ZodType<T>;
}): Promise<T> {
  const response = await request(input);
  if (response.status !== 200) throw new Error("Hosted Eve request failed.");
  return input.result.parse(await parseJsonResponse(response));
}

export function createHostedHttpTransport(input: {
  config: unknown;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
}): HostedEveTransport {
  const config = hostedHttpConfigSchema.parse(input.config);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const common = {
    config,
    identity: input.workloadIdentity,
    fetchImplementation,
  };
  return {
    start: (requestInput) =>
      mutation({
        ...common,
        path: "/v1/eve/start",
        principal: requestInput.principal,
        body: {
          operationId: requestInput.operationId,
          prompt: requestInput.prompt,
        },
        result: startResponseSchema,
      }),
    get: (requestInput) =>
      observation({
        ...common,
        path: "/v1/eve/get",
        principal: requestInput.principal,
        body: { adapterSessionId: requestInput.adapterSessionId },
        result: snapshotSchema,
      }),
    send: (requestInput) =>
      mutation({
        ...common,
        path: "/v1/eve/send",
        principal: requestInput.principal,
        body: {
          operationId: requestInput.operationId,
          adapterSessionId: requestInput.adapterSessionId,
          message: requestInput.message,
        },
        result: snapshotSchema,
      }),
    respond: (requestInput) =>
      mutation({
        ...common,
        path: "/v1/eve/respond",
        principal: requestInput.principal,
        body: {
          operationId: requestInput.operationId,
          adapterSessionId: requestInput.adapterSessionId,
          requestId: requestInput.requestId,
          response: requestInput.response,
        },
        result: snapshotSchema,
      }),
    cancel: (requestInput) =>
      observation({
        ...common,
        path: "/v1/eve/cancel",
        principal: requestInput.principal,
        body: {
          adapterSessionId: requestInput.adapterSessionId,
          ...(requestInput.turnId === undefined
            ? {}
            : { turnId: requestInput.turnId }),
        },
        result: snapshotSchema,
      }),
  };
}

export function createHostedHttpMembership(input: {
  config: unknown;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
}): HostedWorkspaceMembership {
  const config = hostedHttpConfigSchema.parse(input.config);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  return {
    async isMember({ principal, workspaceId }) {
      if (principal.workspaceId !== workspaceId) return false;
      const result = await observation({
        config,
        identity: input.workloadIdentity,
        fetchImplementation,
        path: "/v1/eve/membership",
        principal,
        body: { workspaceId },
        result: membershipResponseSchema,
      });
      return result.member;
    },
  };
}

export type { HostedEngineSnapshot };
