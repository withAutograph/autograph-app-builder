import { z } from "zod";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import {
  CENTRAL_DEPLOYMENT_RECEIPT_PATH,
  centralDeploymentReceiptRelaySchema,
  readCentralReceiptBody,
} from "./central-integration-receipt-relay";

/** Public bounded ingress only. Privileged custody and provider HMAC verification stay in the separate operator. */
export const createCentralIntegrationReceiptDeploymentHandler =
  (
    environment: Readonly<Record<string, string | undefined>> = process.env,
    dependencies: { fetch?: typeof fetch; token?: () => Promise<string> } = {},
  ) =>
  async (request: Request): Promise<Response> => {
    const reply = (code: string, status: number) =>
      Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
    const incoming = new URL(request.url);
    const match =
      /^\/api\/central-integrations\/deployment-events\/(?<subscriptionRef>[a-f0-9-]{36})$/u.exec(
        incoming.pathname,
      );
    if (request.method !== "POST" || match === null || incoming.search)
      return reply("not_found", 404);
    try {
      request.signal.throwIfAborted();
      const endpoint = new URL(z.string().min(1).parse(environment.HOSTED_RUNTIME_OPERATOR_URL));
      if (
        ![
          endpoint.protocol === "https:",
          endpoint.pathname === "/",
          endpoint.search === "",
          endpoint.hash === "",
          endpoint.username === "",
          endpoint.password === "",
        ].every(Boolean)
      ) {
        throw new Error("operator_required");
      }
      const signature = z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .parse(request.headers.get("x-vercel-signature"));
      const raw = await readCentralReceiptBody(request, 262_144);
      const body = centralDeploymentReceiptRelaySchema.parse({
        subscriptionRef: match.groups?.subscriptionRef,
        signature,
        bodyBase64: raw.toString("base64"),
      });
      const workload = await (dependencies.token ?? createVercelWorkloadIdentity().token)();
      request.signal.throwIfAborted();
      const response = await (dependencies.fetch ?? fetch)(
        new URL(CENTRAL_DEPLOYMENT_RECEIPT_PATH, endpoint),
        {
          method: "POST",
          redirect: "error",
          signal: request.signal,
          headers: {
            authorization: `Bearer ${workload}`,
            "x-vercel-trusted-oidc-idp-token": workload,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      request.signal.throwIfAborted();
      const rawResponse = await readCentralReceiptBody(
        { body: response.body, signal: request.signal },
        4096,
      );
      const returned = z
        .strictObject({
          code: z.enum([
            "accepted",
            "ignored",
            "conflict",
            "central_deployment_receipt_rejected",
            "central_deployment_receipt_unavailable",
            "protected_operator_required",
          ]),
        })
        .parse(JSON.parse(rawResponse.toString("utf8")));
      request.signal.throwIfAborted();
      if (![200, 403, 409, 503].includes(response.status))
        throw new Error("invalid_operator_reply");
      return reply(returned.code, response.status);
    } catch {
      return reply("central_deployment_receipt_unavailable", 503);
    }
  };
