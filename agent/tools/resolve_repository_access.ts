import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";

const inputSchema = z.strictObject({
  repository: z
    .string()
    .min(3)
    .max(201)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  selectedInstallationId: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .optional(),
});

export default defineTool({
  description:
    "Confirm the signed-in user's current GitHub access to one named repository. When access is missing, this parks the same turn on the official GitHub connection flow and resumes only after a fresh provider read-back. A chat message or button click cannot grant access.",
  inputSchema,
  approval: never(),
  async execute(input, ctx) {
    const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
    const access = await runtime.classify(input);
    if (access.status === "scope-selection-required") return access;
    const provider = runtime.authorization({
      ...input,
      sessionId: ctx.session.id,
      requestId: ctx.callId,
    });
    const authOptions = {
      authKey: `github-repository:${ctx.session.id}:${input.repository.toLowerCase().replace("/", ":")}`,
      displayName:
        access.status === "authorization-required" && access.action === "update"
          ? "Update GitHub access"
          : "Connect GitHub",
    } as const;
    await ctx.getToken(provider, authOptions);
    const confirmed = await runtime.classify(input);
    if (confirmed.status === "authorization-required") {
      ctx.requireAuth(provider, authOptions);
    }
    if (confirmed.status !== "ready") {
      throw new Error(
        confirmed.status === "scope-selection-required"
          ? "Choose which connected GitHub account Autograph should use."
          : "GitHub could not confirm repository access.",
      );
    }
    return confirmed;
  },
});
