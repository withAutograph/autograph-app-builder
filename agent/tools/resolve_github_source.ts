import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "@/lib/agent/repository-access-tool";
import { repositoryAccessReceiptState } from "@/lib/agent/repository-access-state";
import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";

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
    "Automatically resolve and prepare one supported existing GitHub repository. It independently confirms tenant-bound GitHub access, parks on the Store In authorization flow when access is missing, re-reads the selected installation and exact default-branch SHA/tree, and materializes the eligible source in the isolated workspace. It never creates, pushes, branches, opens a PR, or alters a release gate.",
  inputSchema,
  approval: never(),
  async execute(input, ctx) {
    const initialWorkflow = appBuilderWorkflowState.get();
    const initialSource = sourceWorkflowState.get();
    assertUpstreamMutationAllowed(initialWorkflow, "GitHub source preparation");
    const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
    const access = await resolveRepositoryAccessForTool(input, ctx, runtime);
    if (access.kind === "selection") return access.access;

    const prepared = await runtime.prepareExistingSource({
      ...input,
      access: access.access,
      currentAccessReceipt: access.receipt,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      sandbox: await ctx.getSandbox(),
      ...(initialSource.phase === "empty" ||
      initialSource.githubSource === undefined
        ? {}
        : { currentGitHubSource: initialSource.githubSource }),
    });
    assertExactImmutableGitHubSourceReceipt(prepared.githubSource);
    repositoryAccessReceiptState.update((current) => {
      if (current?.digest !== access.receipt.digest)
        throw new Error(
          "Repository access changed concurrently during source preparation.",
        );
      return prepared.accessReceipt;
    });
    sourceWorkflowState.update((current) => {
      if (JSON.stringify(current) !== JSON.stringify(initialSource))
        throw new Error(
          "The reviewed source changed concurrently during GitHub source preparation.",
        );
      if (current.phase !== "empty") {
        if (
          current.receipt.digest !== prepared.sourceReceipt.digest ||
          current.githubSource?.digest !== prepared.githubSource.digest
        )
          throw new Error(
            "This app build already owns a different GitHub source binding.",
          );
        return current;
      }
      return {
        version: APP_BUILDER_SOURCE_VERSION,
        phase: "reviewed",
        receipt: prepared.sourceReceipt,
        githubSource: prepared.githubSource,
      };
    });
    appBuilderWorkflowState.update((current) => {
      assertExactWorkflowState(
        current,
        initialWorkflow,
        "GitHub source preparation",
      );
      if (current.phase !== "empty") {
        if (
          workflowWorkspace(current)?.workspaceDigest !==
            prepared.workspace.workspaceDigest ||
          current.sourceReceipt.digest !== prepared.sourceReceipt.digest ||
          current.githubSource?.digest !== prepared.githubSource.digest
        )
          throw new Error(
            "This app build already owns a different GitHub source binding.",
          );
        return current;
      }
      return {
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "prepared",
        preparedByCallId: ctx.callId,
        workspace: prepared.workspace,
        sourceReceipt: prepared.sourceReceipt,
        githubSource: prepared.githubSource,
        artifacts: [],
      };
    });
    return {
      repository: access.access.repository,
      scope: access.access.scope,
      repositoryAccessReceiptDigest: prepared.accessReceipt.digest,
      githubSource: prepared.githubSource,
      sourceReceipt: prepared.sourceReceipt,
      workspace: prepared.workspace,
    };
  },
});
