import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  prepareOrReuseDependencies,
  type DependencyReadyState,
} from "@/lib/agent/target-dependency-preparation";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
  sha256,
  type TargetIdentityReceipt,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import { assertExactDependencyTargetBinding } from "@/lib/repository/dependency-cache";
import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  sandboxTargetCommandExecutor,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";

export default defineTool({
  description:
    "Required completion gate for every app creation or existing-app iteration. It automatically prepares or reuses verified dependencies before planning. For an existing app, first call inspect_existing_app after workspace preparation, read the bounded app-owned files, and provide every exact replacement as existingAppChanges; never call this tool without those changes for an existing app. If it reports existing_app_change_preimage_missing, inspect only the returned exactAppOwnedPaths and retry with replacements based on those contents; do not resolve or prepare the source again. Automatically run the fixed read-only target commands for identity and canonical planning. Never substitute a prose implementation outline or finish the turn before this tool succeeds. No apply, validation, target write, arbitrary shell, arguments, cwd, or caller-controlled environment are available.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    existingAppChanges: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(512),
          content: z.string().max(262_144),
        }),
      )
      .min(1)
      .max(32)
      .optional(),
  }),
  async execute({ expectedAppSpecDigest, existingAppChanges }, ctx) {
    const state = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(state, "target identity and planning");
    if (state.phase === "empty" || state.phase === "prepared")
      throw new Error(
        "Accept a build-ready AppSpec before running target planning.",
      );
    const prepared = await prepareOrReuseDependencies({
      current: state,
      expectedAppSpecDigest,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      environment: process.env,
      getSandbox: () => ctx.getSandbox(),
    });
    const current: DependencyReadyState = prepared.state;
    const sandbox = prepared.sandbox;
    const cache = prepared.cache;
    assertExactDependencyTargetBinding({
      workspace: current.workspace,
      sourceReceipt: current.sourceReceipt,
      cache,
      dependencyReceipt: current.dependencyReceipt,
    });
    const execution = targetExecutionBinding(cache);
    if (
      current.dependencyReceipt.imageDigest !== execution.imageDigest ||
      current.dependencyReceipt.dependencyCacheDigest !==
        execution.dependencyCacheDigest ||
      current.dependencyReceipt.cacheManifestDigest !== cache.manifestDigest ||
      current.dependencyReceipt.cacheContentDigest !== cache.contentDigest
    )
      throw new Error(
        "The offline dependency cache changed after its durable receipt.",
      );
    if (
      current.phase === "planned" ||
      current.phase === "apply_failed" ||
      current.phase === "applied" ||
      current.phase === "validation_pending" ||
      current.phase === "validation_failed" ||
      current.phase === "validated" ||
      current.phase === "reviewed"
    )
      return { ...current.proposal, reused: true };

    const binding = {
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      sourceReceiptDigest: current.sourceReceipt.digest,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: execution.imageDigest,
      dependencyCacheDigest: execution.dependencyCacheDigest,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
    };
    let identityReceipt: TargetIdentityReceipt | undefined =
      current.phase === "identity_resolved"
        ? current.identityReceipt
        : undefined;
    let workflowBeforeProposal = current;
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor: execution.fixture
        ? fixtureTargetCommandExecutor()
        : sandboxTargetCommandExecutor(sandbox),
      appId: current.appSpec.appId,
      appSpecContent: current.appSpec.content,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
      existingAppChanges,
      sourceReceipt: current.sourceReceipt,
      environment: process.env,
      onIdentity(identity) {
        if (identityReceipt !== undefined) {
          if (
            JSON.stringify(identityReceipt.identity) !==
            JSON.stringify(identity)
          )
            throw new Error(
              "Target identity changed after its durable receipt.",
            );
          return;
        }
        const unsigned = {
          version: 1 as const,
          ...binding,
          identity,
          resolvedByCallId: ctx.callId,
        };
        identityReceipt = {
          ...unsigned,
          digest: sha256(JSON.stringify(unsigned)),
        };
        const identityState = {
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "identity_resolved",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          ...(current.githubSource === undefined
            ? {}
            : { githubSource: current.githubSource }),
          artifacts: current.artifacts,
          appSpec: current.appSpec,
          dependencyReceipt: current.dependencyReceipt,
          identityReceipt: identityReceipt!,
        } as const;
        updateExactWorkflow({
          expected: current,
          operation: "target identity receipt recording",
          transition: () => identityState,
        });
        workflowBeforeProposal = identityState;
      },
    });
    if (identityReceipt === undefined)
      throw new Error("Target identity receipt was not recorded.");
    const recordedIdentity = identityReceipt;
    const unsigned = {
      version: 1 as const,
      ...binding,
      identityDigest: recordedIdentity.digest,
      contractDigest: result.contractDigest,
      target: result.proposal,
      plannedByCallId: ctx.callId,
    };
    const proposal = { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
    updateExactWorkflow({
      expected: workflowBeforeProposal,
      operation: "target proposal recording",
      transition: () => ({
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "planned",
        preparedByCallId: current.preparedByCallId,
        workspace: current.workspace,
        sourceReceipt: current.sourceReceipt,
        ...(current.githubSource === undefined
          ? {}
          : { githubSource: current.githubSource }),
        artifacts: current.artifacts,
        appSpec: current.appSpec,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: recordedIdentity,
        proposal,
      }),
    });
    return { ...proposal, reused: false };
  },
});
