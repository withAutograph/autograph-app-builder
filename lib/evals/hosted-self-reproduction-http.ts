import { z } from "zod";
import type { AuthorizedEvalRun } from "../eve/github-eval-oidc";
import type { createHostedSelfReproductionController } from "./hosted-self-reproduction-controller";

export interface HostedEvalHttpRuntime {
  authorize: (token: string) => Promise<AuthorizedEvalRun>;
  controller: () => Promise<ReturnType<typeof createHostedSelfReproductionController>>;
}
const requestBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("status") }).strict(),
  z
    .object({
      action: z.literal("artifact"),
      artifactId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u),
    })
    .strict(),
]);
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
const errorResponse = (status: number, error: string) =>
  Response.json({ error }, { headers: privateHeaders, status });

/** No caller-supplied run scope, source, prompt, or command crosses this boundary. */
export const createHostedEvalHttpHandler =
  (getRuntime: () => HostedEvalHttpRuntime | undefined) => async (request: Request) => {
    let runtime: HostedEvalHttpRuntime | undefined;
    try {
      runtime = getRuntime();
    } catch {
      return errorResponse(503, "eval_unavailable");
    }
    if (!runtime) return errorResponse(503, "eval_unavailable");
    if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
    const token = /^Bearer (?<token>[^\s]+)$/iu.exec(request.headers.get("authorization") ?? "")
      ?.groups?.token;
    if (!token) return errorResponse(401, "unauthorized");
    let identity: AuthorizedEvalRun;
    try {
      identity = await runtime.authorize(token);
    } catch {
      return errorResponse(401, "unauthorized");
    }
    const parsed = requestBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return errorResponse(400, "invalid_request");
    const id = `${identity.repositoryId}:${identity.runId}:${identity.runAttempt}`;
    try {
      const controller = await runtime.controller();
      if (parsed.data.action === "start")
        return Response.json(await controller.start(token), { headers: privateHeaders });
      if (parsed.data.action === "status")
        return Response.json(await controller.status(token, id), { headers: privateHeaders });
      const artifact = await controller.artifact(token, id, parsed.data.artifactId);
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(streamController) {
          if (offset >= artifact.content.length) {
            streamController.close();
            return;
          }
          const end = Math.min(offset + 64 * 1024, artifact.content.length);
          streamController.enqueue(artifact.content.subarray(offset, end));
          offset = end;
        },
      });
      return new Response(stream, {
        headers: {
          ...privateHeaders,
          "Content-Disposition": `attachment; filename="${parsed.data.artifactId}"`,
          "Content-Security-Policy": "sandbox; default-src 'none'",
          "Content-Type": artifact.contentType,
        },
      });
    } catch {
      return errorResponse(503, "eval_unavailable");
    }
  };
