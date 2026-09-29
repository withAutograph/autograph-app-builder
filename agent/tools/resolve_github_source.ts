import { defineTool } from "eve/tools";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";

import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { resolveRepositoryAccessForTool } from "@/lib/agent/repository-access-tool";
import { repositoryAccessReceiptState } from "@/lib/agent/repository-access-state";
import { selectedGitHubSourceForSandboxRestore } from "@/lib/agent/restore-selected-github-sandbox-source";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "@/lib/agent/source-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import { inspectGitHubSourceSandboxWorkspace } from "@/lib/repository/sandbox-github-source";

import { appBaselineInputSchema, appBaselineSelectionSchema } from "@/lib/repository/app-baseline";
import type { AppBaselineInput, AppBaselineReceipt } from "@/lib/repository/app-baseline";
import { appBaselineState, assertInitialAppBaseline } from "@/lib/agent/app-baseline-state";
import type { SelectedAppBaseline } from "@/lib/agent/app-baseline-state";

const selectInitialBaseline = async (input: {
  callId: string;
  repository: { name: string; owner: string; repositoryId: string };
  requested: AppBaselineInput | undefined;
  saved: SelectedAppBaseline | undefined;
  session: { auth: unknown; id: string };
}) => {
  if (input.saved !== undefined || input.requested === undefined) {
    return input.saved;
  }
  const publicationRuntime = await githubPublicationRuntimeForSession(input.session.auth);
  const historical = await publicationRuntime.inspectHistoricalAppSource({
    ...input.repository,
    source: input.requested.source,
  });
  const selection = appBaselineSelectionSchema.parse({
    appId: input.requested.appId,
    historical,
    selectedByCallId: input.callId,
    sessionId: input.session.id,
    source: input.requested.source,
  });
  appBaselineState.update((current) => {
    if (current !== undefined) {
      throw new Error(
        "An app baseline was selected concurrently. Retry its saved source selection.",
      );
    }
    return { selection };
  });
  return appBaselineState.get();
};

const recordPreparedBaseline = (
  selected: SelectedAppBaseline | undefined,
  receipt: AppBaselineReceipt | undefined,
  sessionId: string,
): void => {
  if (selected === undefined) {
    return;
  }
  if (receipt === undefined) {
    throw new Error(
      "The selected app baseline was not prepared; no app source was accepted. Retry this source selection.",
    );
  }
  appBaselineState.update((current) => {
    if (
      current?.selection.sessionId !== sessionId ||
      JSON.stringify(current.selection) !== JSON.stringify(selected.selection)
    ) {
      throw new Error("The app baseline changed concurrently during source preparation.");
    }
    return { receipt, selection: current.selection };
  });
};

const inspectSelectedRevision = async (input: {
  sessionAuth: unknown;
  repository: { name: string; owner: string; repositoryId: string };
  branch: string | undefined;
  pullRequestNumber: number | undefined;
}) => {
  if (input.pullRequestNumber === undefined && input.branch === undefined) {
    return null;
  }
  const publicationRuntime = await githubPublicationRuntimeForSession(input.sessionAuth);
  if (input.branch !== undefined) {
    return await publicationRuntime.inspectSourceBranch({
      branch: input.branch,
      ...input.repository,
    });
  }
  if (input.pullRequestNumber === undefined) {
    return null;
  }
  const pullRequest = await publicationRuntime.inspectOpenPullRequestSource({
    name: input.repository.name,
    owner: input.repository.owner,
    pullRequestNumber: input.pullRequestNumber,
    repositoryId: input.repository.repositoryId,
  });
  return {
    branch: pullRequest.headBranch,
    headSha: pullRequest.headSha,
    headTree: pullRequest.headTree,
  };
};

export const assertSelectedSourceBranch = (input: {
  requestedBranch: string | undefined;
  resolvedRef: string | undefined;
}) => {
  if (
    input.resolvedRef !== undefined &&
    input.requestedBranch !== undefined &&
    input.resolvedRef !== `refs/heads/${input.requestedBranch}`
  ) {
    throw new Error(
      "This Builder session already uses a different GitHub branch. Start a new Builder session and select the intended branch or open PR before preparing its source; the occupied checkout will not be replaced.",
    );
  }
};

const assertAvailableSourceSelection = (input: {
  repository: string;
  selectedGitHubSource: ReturnType<typeof selectedGitHubSourceForSandboxRestore>;
  source: ReturnType<typeof sourceWorkflowState.get>;
  workflow: ReturnType<typeof appBuilderWorkflowState.get>;
}): void => {
  const sourceUsesStarter =
    input.source.phase !== "empty" &&
    input.source.githubSource === undefined &&
    input.source.receipt.sourceKind !== "existing-repository";
  const workflowUsesStarter =
    input.workflow.phase !== "empty" && input.workflow.githubSource === undefined;
  if (sourceUsesStarter || workflowUsesStarter) {
    throw new Error(
      "This app build already uses the starter source. Start a new app build to select an existing GitHub repository.",
    );
  }
  if (
    input.selectedGitHubSource !== undefined &&
    `${input.selectedGitHubSource.repository.owner}/${input.selectedGitHubSource.repository.name}` !==
      input.repository
  ) {
    throw new Error("This app build already uses a different GitHub repository.");
  }
};

export const inputSchema = z
  .strictObject({
    appBaseline: appBaselineInputSchema.optional(),
    branch: z
      .string()
      .min(1)
      .max(200)
      .regex(
        /^(?!-)(?!\/)(?!.*\/$)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*[\\\s])[A-Za-z0-9._/-]+$/u,
      )
      .refine(
        (value) => !value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock")),
      )
      .optional(),
    draftPullRequestNumber: z.number().int().positive().optional(),
    pullRequestNumber: z.number().int().positive().optional(),
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
  })
  .superRefine(({ branch, draftPullRequestNumber, pullRequestNumber }, context) => {
    if (
      [branch, draftPullRequestNumber, pullRequestNumber].filter((value) => value !== undefined)
        .length > 1
    ) {
      context.addIssue({
        code: "custom",
        message: "Select one branch or open pull request number.",
      });
    }
  });

export default defineTool({
  approval: never(),
  description:
    "Resolve and prepare an existing connected GitHub repository. In a new Builder session, select a branch or any open PR using pullRequestNumber; draftPullRequestNumber remains a legacy input. Builder uses its current branch as the private source and never replaces an occupied source. Pass selectedInstallationId=null for the single verified installation. For an initial appBaseline, prepare that same-repository historical app version before exposing app source while retaining the selected platform branch. This operation never pushes, branches, opens a PR, or grants publication approval.",
  async execute(input, ctx) {
    const pullRequestNumber = input.pullRequestNumber ?? input.draftPullRequestNumber;
    const initialWorkflow = appBuilderWorkflowState.get();
    const initialSource = sourceWorkflowState.get();
    const savedBaseline = appBaselineState.get();
    assertInitialAppBaseline({
      occupied: initialWorkflow.phase !== "empty" || initialSource.phase !== "empty",
      repository: input.repository,
      requested: input.appBaseline,
      saved: savedBaseline,
    });
    const selectedGitHubSource = selectedGitHubSourceForSandboxRestore({
      sourceState: initialSource.phase === "empty" ? undefined : initialSource.githubSource,
      workflowState: initialWorkflow.phase === "empty" ? undefined : initialWorkflow.githubSource,
    });
    assertUpstreamMutationAllowed(initialWorkflow, "GitHub source preparation");
    assertAvailableSourceSelection({
      repository: input.repository,
      selectedGitHubSource,
      source: initialSource,
      workflow: initialWorkflow,
    });
    const runtime = await repositoryAccessRuntimeForSession(ctx.session.auth);
    const access = await resolveRepositoryAccessForTool(input, ctx, runtime);
    if (access.kind === "selection") {
      return access.access;
    }

    const selectedBaseline = await selectInitialBaseline({
      callId: ctx.callId,
      repository: access.access.repository,
      requested: input.appBaseline,
      saved: savedBaseline,
      session: ctx.session,
    });

    const revision = await inspectSelectedRevision({
      branch: input.branch,
      pullRequestNumber,
      repository: access.access.repository,
      sessionAuth: ctx.session.auth,
    });
    assertSelectedSourceBranch({
      requestedBranch: revision?.branch,
      resolvedRef: selectedGitHubSource?.resolvedRef,
    });

    if (initialWorkflow.phase !== "empty" && selectedGitHubSource !== undefined) {
      // A retry keeps the selected repository binding and observes the live
      // checkout. GitHub's default branch may have advanced since selection.
      if (
        initialWorkflow.githubSource?.digest !== selectedGitHubSource.digest ||
        selectedGitHubSource.repository.repositoryId !== access.access.repository.repositoryId
      ) {
        throw new Error("This app build already owns a different GitHub repository.");
      }
      const workspace = await inspectGitHubSourceSandboxWorkspace({
        githubSource: selectedGitHubSource,
        sandbox: await getSourceBoundSandbox(ctx),
      });
      return {
        githubSource: selectedGitHubSource,
        repository: access.access.repository,
        repositoryAccessReceiptDigest: access.receipt.digest,
        scope: access.access.scope,
        selectedSource: {
          branch: selectedGitHubSource.resolvedRef.slice("refs/heads/".length),
          pullRequestNumber,
        },
        ...(selectedBaseline?.receipt === undefined
          ? {}
          : { appBaseline: selectedBaseline.receipt }),
        sourceReceipt: initialWorkflow.sourceReceipt,
        workspace,
      };
    }

    const prepared = await runtime.prepareExistingSource({
      access: access.access,
      callId: ctx.callId,
      currentAccessReceipt: access.receipt,
      ...(selectedBaseline === undefined ? {} : { appBaseline: selectedBaseline.selection }),
      ...(revision === null
        ? {}
        : {
            revision,
          }),
      // Source credentials are resolved first. The backend consumes the
      // server-owned context while `getSandbox()` creates the provider
      // session, so Vercel performs the Git clone itself.
      ...(initialSource.phase === "empty" || initialSource.githubSource === undefined
        ? {}
        : { currentGitHubSource: initialSource.githubSource }),
      repository: input.repository,
      sandbox: () => ctx.getSandbox(),
      selectedInstallationId: input.selectedInstallationId,
      sessionId: ctx.session.id,
    });
    assertExactImmutableGitHubSourceReceipt(prepared.githubSource);
    recordPreparedBaseline(selectedBaseline, prepared.appBaseline, ctx.session.id);
    repositoryAccessReceiptState.update((current) => {
      if (current?.digest !== access.receipt.digest) {
        throw new Error("Repository access changed concurrently during source preparation.");
      }
      return prepared.accessReceipt;
    });
    sourceWorkflowState.update((current) => {
      if (JSON.stringify(current) !== JSON.stringify(initialSource)) {
        throw new Error(
          "The reviewed source changed concurrently during GitHub source preparation.",
        );
      }
      if (current.phase !== "empty") {
        if (
          current.receipt.digest !== prepared.sourceReceipt.digest ||
          current.githubSource?.digest !== prepared.githubSource.digest
        ) {
          throw new Error("This app build already owns a different GitHub source binding.");
        }
        return current;
      }
      return {
        githubSource: prepared.githubSource,
        phase: "reviewed",
        receipt: prepared.sourceReceipt,
        version: APP_BUILDER_SOURCE_VERSION,
      };
    });
    appBuilderWorkflowState.update((current) => {
      assertExactWorkflowState(current, initialWorkflow, "GitHub source preparation");
      if (current.phase !== "empty") {
        if (
          workflowWorkspace(current)?.workspaceDigest !== prepared.workspace.workspaceDigest ||
          current.sourceReceipt.digest !== prepared.sourceReceipt.digest ||
          current.githubSource?.digest !== prepared.githubSource.digest
        ) {
          throw new Error("This app build already owns a different GitHub source binding.");
        }
        return current;
      }
      return {
        artifacts: [],
        githubSource: prepared.githubSource,
        phase: "prepared",
        preparedByCallId: ctx.callId,
        sourceReceipt: prepared.sourceReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: prepared.workspace,
      };
    });
    return {
      githubSource: prepared.githubSource,
      repository: access.access.repository,
      repositoryAccessReceiptDigest: prepared.accessReceipt.digest,
      scope: access.access.scope,
      ...(prepared.appBaseline === undefined ? {} : { appBaseline: prepared.appBaseline }),
      selectedSource: {
        branch: prepared.githubSource.resolvedRef.slice("refs/heads/".length),
        pullRequestNumber,
      },
      sourceReceipt: prepared.sourceReceipt,
      workspace: prepared.workspace,
    };
  },
  inputSchema,
});
