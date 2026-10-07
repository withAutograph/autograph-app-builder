import { z } from "zod";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { hostedRuntimeProofSchema } from "./hosted-runtime-journal";
import { resolveHostedOperatorOwnerContext } from "./hosted-operator-owner-context";
import type { OperatorOwnerContext, OperatorRequest } from "./hosted-operator-contract";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPublicResultSchema,
  operatorRequestSchema,
  restrictedOperatorEnvironment,
  sameOperatorSelection,
} from "./hosted-operator-contract";

const bindingSchema = z.strictObject({
  environment: z.record(z.string(), z.string()),
  operationRef: z.uuid(),
  plan: hostedOperatorPlanSchema,
  proof: hostedRuntimeProofSchema,
});
/** Server-only client. An unconfigured service never falls back to an installer Sandbox. */
export const createHostedOperatorClient = (input: {
  endpoint: string;
  token: () => Promise<string>;
  ownerContext?: OperatorOwnerContext | null;
  sessionId?: string;
  fetch?: typeof fetch;
  allowLoopback?: boolean;
}) => {
  const url = new URL(input.endpoint);
  const loopback =
    input.allowLoopback === true && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const validEndpoint = [
    url.protocol === "https:" || loopback,
    url.username === "",
    url.password === "",
    url.pathname === "/",
    url.search === "",
    url.hash === "",
  ];
  if (validEndpoint.includes(false)) {
    throw new HostedOperatorError("protected_operator_required");
  }
  const send = async (request: OperatorRequest, signal?: AbortSignal) => {
    const bodyInput =
      input.ownerContext === undefined || input.ownerContext === null
        ? request
        : { ...request, ownerContext: input.ownerContext };
    const body = operatorRequestSchema.parse(bodyInput);
    const response = await (input.fetch ?? fetch)(new URL("/v1/runtime", url), {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${await input.token()}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      throw new HostedOperatorError(
        response.status === 401 || response.status === 403
          ? "authorization_required"
          : "operator_unavailable",
      );
    }
    const value: unknown = await response.json();
    return value;
  };
  return {
    async bindings(
      request: Extract<OperatorRequest, { action: "bindings" }>,
      signal?: AbortSignal,
    ) {
      const raw = await send(request, signal);
      const blocked = operatorPublicResultSchema.safeParse(raw);
      if (blocked.success) {
        throw new HostedOperatorError(blocked.data.code ?? "operator_unavailable");
      }
      const value = bindingSchema.parse(raw);
      if (
        value.operationRef !== request.operationRef ||
        !sameOperatorSelection(request.selection, value.plan.selection) ||
        value.proof.releaseId !== value.plan.release.id ||
        value.proof.artifactHash !== value.plan.release.sha256
      ) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return {
        ...value,
        environment: restrictedOperatorEnvironment(
          value.plan,
          value.environment,
          input.ownerContext?.authority,
        ),
      };
    },
    async request(request: Exclude<OperatorRequest, { action: "bindings" }>, signal?: AbortSignal) {
      return operatorPublicResultSchema.parse(await send(request, signal));
    },
    sessionId: input.sessionId,
  };
};
export const hostedOperatorClientForSession = async (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Eve supplies unknown auth; exactForwardedSessionAuthority parses it at this boundary.
  sessionAuth: unknown,
  adapterSessionId: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const endpoint = environment.HOSTED_RUNTIME_OPERATOR_URL;
  if (endpoint === undefined || endpoint === "") {
    throw new HostedOperatorError("protected_operator_required");
  }
  const { authority, principal } = exactForwardedSessionAuthority(sessionAuth);
  const ownerContext = await resolveHostedOperatorOwnerContext({
    adapterSessionId,
    authority,
    environment,
    principal,
    sessionAuth,
  });
  return createHostedOperatorClient({
    endpoint,
    ownerContext,
    sessionId: ownerContext.sessionId,
    token: createVercelWorkloadIdentity().token,
  });
};
