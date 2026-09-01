import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "@/lib/agent/repository-access-tool";

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
    const result = await resolveRepositoryAccessForTool(input, ctx, runtime);
    if (result.kind === "selection") return result.access;
    return {
      ...result.access,
      repositoryAccessReceiptDigest: result.receipt.digest,
    };
  },
});
