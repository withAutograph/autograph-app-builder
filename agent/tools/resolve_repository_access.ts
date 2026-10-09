import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "@/lib/agent/repository-access-tool";

export const inputSchema = z.strictObject({
  repository: z
    .string()
    .min(3)
    .max(201)
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  selectedInstallationId: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .nullable()
    .transform((value) => value ?? undefined),
});

export default defineTool({
  approval: never(),
  description:
    "Confirm the signed-in user's current GitHub source-read access to one named repository. This uses an operation-scoped read token; ready access and that token's permissions do not measure the installation's broader publication capabilities. Do not infer missing installation write permissions from this source-read token. When publication is requested and the workflow is reviewed, seal_github_draft_pr_proposal performs a fresh publication-permission check before separate publication approval. Pass selectedInstallationId=null to use the single verified installation; provide an ID only after scope-selection-required. When source access is missing, this parks the same turn on the official GitHub connection flow and resumes only after a fresh provider read-back. A chat message or button click cannot grant access.",
  async execute(input, ctx) {
    const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
    const result = await resolveRepositoryAccessForTool(input, ctx, runtime);
    if (result.kind === "selection") {
      return result.access;
    }
    return {
      ...result.access,
      repositoryAccessReceiptDigest: result.receipt.digest,
    };
  },
  inputSchema,
});
