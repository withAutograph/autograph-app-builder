import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { describeSelectedApp } from "@/lib/repository/app-description";
import { runAppBrowserTests } from "./run-app-browser-tests";
import { reviewAppliedProductSource } from "@/lib/agent/review-applied-product-source";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { prepareValidationLocalData } from "./prepare-app-local-preview";

import {
  applyImplementationFiles,
  assertExistingAppImplementationFiles,
  implementationFilesSchema,
} from "@/lib/agent/apply-implementation-files";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  fixtureValidationCommandExecutor,
  sandboxValidationCommandExecutor,
} from "@/lib/repository/target-validation";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { createPostgresValidationLogStore } from "@/lib/repository/postgres-validation-log-store";
import { openHostedPostgresDatabase } from "@/lib/mcp/hosted-route";
import { productionReadinessHandoff } from "@/lib/agent/production-readiness-handoff";
import {
  invalidateProductBehaviorEvidence,
  currentProductBehaviorEvidence,
} from "@/lib/agent/product-behavior-state";

const validationPhase = (callId: string, phase: string, detail?: string | boolean): void => {
  console.info(
    JSON.stringify({
      callId,
      event: "app_builder.validation_phase",
      phase,
      ...(detail === undefined ? {} : { detail }),
    }),
  );
};

const reusableDescription = async (
  eligible: boolean,
  input: () => Promise<Parameters<typeof describeSelectedApp>[0]>,
) =>
  eligible && !hasTestCapability("simulated-target")
    ? await describeSelectedApp(await input())
    : undefined;

const describeValidationApp = async (
  fixture: boolean,
  input: Parameters<typeof describeSelectedApp>[0],
) => (fixture ? undefined : await describeSelectedApp(input));

const validatePersistentBackend = async (
  description: Awaited<ReturnType<typeof describeSelectedApp>> | undefined,
  input: Parameters<typeof runAppBrowserTests>[0],
) => {
  if (description?.backend.kind !== "generated-postgres") {
    return { status: "unassessed" as const };
  }
  if (description.validation.browser === null) {
    return {
      problem: "The persistent app must declare an authenticated test-e2e task before completion.",
      status: "blocked" as const,
    };
  }
  return await runAppBrowserTests(input);
};

const backendValidationStatus = (status: string) =>
  status === "failed" || status === "blocked" ? ("needs_repair" as const) : ("validated" as const);

export default defineTool({
  description:
    "Run the repository's normal validation commands against the current applied app. Command exit status is the technical validation result; successful checks also return an independent source assessment against the original product request. For persistent apps, also run the declared authenticated browser task against the prepared runtime and report its result separately. None of these results alone proves hosted durability. This does not publish or otherwise change an external repository.",
  // oxlint-disable-next-line eslint/complexity -- The existing workflow phase and receipt branches remain explicit.
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "applied" &&
      current.phase !== "validation_pending" &&
      current.phase !== "validation_failed" &&
      current.phase !== "validated" &&
      current.phase !== "reviewed"
    ) {
      throw new Error("Apply the requested changes before running the repository checks.");
    }
    assertExistingAppImplementationFiles(input.implementationFiles, current.proposal.target);
    const reusableTechnicalValidation =
      (current.phase === "validated" || current.phase === "reviewed") &&
      input.implementationFiles.length === 0;
    const priorDescription = await reusableDescription(reusableTechnicalValidation, async () => ({
      appId: current.appSpec.appId,
      root: current.applyReceipt.applyRoot,
      sandbox: await ctx.getSandbox(),
      signal: ctx.abortSignal,
    }));
    // Persistent runtime observations must be refreshed even when source checks
    // are unchanged: sessions, assignments, and installations can be revoked.
    if (
      (current.phase === "validated" || current.phase === "reviewed") &&
      input.implementationFiles.length === 0 &&
      priorDescription?.backend.kind !== "generated-postgres"
    ) {
      const evidence = currentProductBehaviorEvidence(
        current.appSpec.digest,
        current.applyReceipt.digest,
      );
      const sourceAssessment = await reviewAppliedProductSource({
        abortSignal: ctx.abortSignal,
        appSpec: current.appSpec,
        applyReceipt: current.applyReceipt,
        artifacts: current.artifacts,
        callId: ctx.callId,
        getSandbox: async () => await ctx.getSandbox(),
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      });
      ctx.abortSignal?.throwIfAborted();
      const productionHandoff = await productionReadinessHandoff({
        appId: current.appSpec.appId,
        productBehaviorEvidence: evidence,
        repositoryRoot: current.applyReceipt.applyRoot,
        signal: ctx.abortSignal,
        source: await ctx.getSandbox(),
      });
      return {
        attemptDigest: current.validationReceipt.attemptDigest,
        commandCount: current.validationReceipt.commands.length,
        logs: current.validationReceipt.commands.map((command) => ({
          name: command.name,
          ...(command.logs === undefined ? {} : { logs: command.logs }),
        })),
        productAcceptance: productAcceptanceObligations(
          current.appSpec,
          evidence,
          sourceAssessment,
        ),
        productBehaviorEvidence: evidence,
        productionHandoff,
        reused: true,
        sourceAssessment,
        status: "validated" as const,
        technicalStatus: "passed" as const,
      };
    }
    validationPhase(ctx.callId, "resolving_sandbox");
    const sandbox = await ctx.getSandbox();
    validationPhase(ctx.callId, "sandbox_ready");
    const relativeApplyRoot = current.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
    const fixture = hasTestCapability("simulated-target");
    const attempt = createTargetValidationAttempt(current.applyReceipt, ctx.callId);
    const priorPublishedGitHubDraftProposalDigest =
      current.publishedGitHubDraftProposalDigest ??
      (current.phase === "reviewed" ? current.githubDraftProposal?.proposal.digest : undefined);
    const base = {
      appSpec: current.appSpec,
      applyReceipt: current.applyReceipt,
      artifacts: current.artifacts,
      ...(priorPublishedGitHubDraftProposalDigest === undefined
        ? {}
        : { publishedGitHubDraftProposalDigest: priorPublishedGitHubDraftProposalDigest }),
      dependencyReceipt: current.dependencyReceipt,
      ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
      identityReceipt: current.identityReceipt,
      preparedByCallId: current.preparedByCallId,
      proposal: current.proposal,
      sourceReceipt: current.sourceReceipt,
      version: APP_BUILDER_WORKFLOW_VERSION,
      workspace: current.workspace,
    } as const;
    appBuilderWorkflowState.update(() => ({
      ...base,
      phase: "validation_pending",
      validationAttempt: attempt,
    }));
    if (input.implementationFiles.length > 0) {
      invalidateProductBehaviorEvidence("source-repair");
      validationPhase(ctx.callId, "writing_implementation_files");
      await applyImplementationFiles(sandbox, relativeApplyRoot, input.implementationFiles);
      validationPhase(ctx.callId, "implementation_files_written");
    }
    // Some repository test tasks start local services. Prepare the declared
    // local data task first so its server inherits the setup log file rather
    // than Turbo's captured test pipe, which would keep Turbo waiting after
    // the tests themselves have finished.
    let runtime: Awaited<ReturnType<typeof prepareValidationLocalData>> = null;
    if (!fixture) {
      validationPhase(ctx.callId, "preparing_declared_local_data");
      try {
        runtime = await prepareValidationLocalData({
          appId: current.appSpec.appId,
          execution: {
            appId: current.appSpec.appId,
            root: current.applyReceipt.applyRoot,
            sandboxId: getBuilderSandboxId(sandbox),
            sessionAuth: ctx.session.auth,
            sessionId: ctx.session.id,
            signal: ctx.abortSignal,
            state: current,
          },
          root: current.applyReceipt.applyRoot,
          sandbox,
          signal: ctx.abortSignal,
        });
      } catch (error) {
        ctx.abortSignal?.throwIfAborted();
        appBuilderWorkflowState.update(() => ({ ...base, phase: "applied" }));
        return {
          problem:
            error instanceof Error ? error.message : "Authenticated runtime preparation failed.",
          reason: "authenticated-runtime-preparation",
          status: "needs_repair" as const,
        };
      }
      validationPhase(ctx.callId, "declared_local_data_ready");
    }
    validationPhase(ctx.callId, "running_repository_commands");
    const databaseUrl = process.env.DATABASE_URL;
    if (!fixture && (databaseUrl === undefined || databaseUrl.length === 0)) {
      throw new Error(
        "Durable validation log storage is unavailable. Configure the hosted database, then retry validation.",
      );
    }
    const result = await executeProposalBoundValidation({
      abortSignal: ctx.abortSignal,
      appId: current.appSpec.appId,
      apply: current.applyReceipt,
      attempt,
      dependencyLayout: current.dependencyReceipt.dependencyLayout,
      executor: fixture
        ? fixtureValidationCommandExecutor()
        : sandboxValidationCommandExecutor({ runtime }),
      sandbox,
      ...(databaseUrl === undefined
        ? {}
        : {
            logStore: createPostgresValidationLogStore({
              db: openHostedPostgresDatabase(databaseUrl),
              sessionAuth: ctx.session.auth,
              sessionId: ctx.session.id,
            }),
            sessionId: ctx.session.id,
          }),
    });
    validationPhase(ctx.callId, "repository_commands_finished", result.ok);
    if (!result.ok) {
      appBuilderWorkflowState.update(() => ({
        ...base,
        phase: "validation_failed",
        validationFailure: result.receipt,
      }));
      return {
        attemptDigest: result.receipt.attemptDigest,
        commandFailure: result.receipt.commandFailure,
        diagnostics: result.receipt.diagnostics ?? [],
        logs: result.receipt.commands.at(-1)?.logs,
        output: result.receipt.output,
        reason: result.receipt.reason,
        reused: false,
        status: "needs_repair" as const,
      };
    }
    appBuilderWorkflowState.update(() => ({
      ...base,
      phase: "validated",
      validationReceipt: result.receipt,
    }));
    const evidence = currentProductBehaviorEvidence(
      current.appSpec.digest,
      current.applyReceipt.digest,
    );
    const description = await describeValidationApp(fixture, {
      appId: current.appSpec.appId,
      root: current.applyReceipt.applyRoot,
      sandbox,
      signal: ctx.abortSignal,
    });
    const backendValidation = await validatePersistentBackend(description, {
      appId: current.appSpec.appId,
      root: current.applyReceipt.applyRoot,
      runtime,
      sandbox,
      signal: ctx.abortSignal,
    });
    validationPhase(ctx.callId, "reviewing_applied_source");
    const sourceAssessment = await reviewAppliedProductSource({
      abortSignal: ctx.abortSignal,
      appSpec: current.appSpec,
      applyReceipt: current.applyReceipt,
      artifacts: current.artifacts,
      callId: ctx.callId,
      getSandbox: async () => await ctx.getSandbox(),
      sessionAuth: ctx.session.auth,
      sessionId: ctx.session.id,
    });
    validationPhase(ctx.callId, "applied_source_review_finished", sourceAssessment.status);
    const productionHandoff = await productionReadinessHandoff({
      appId: current.appSpec.appId,
      installationProof: runtime?.installationProof,
      productBehaviorEvidence: evidence,
      repositoryRoot: current.applyReceipt.applyRoot,
      signal: ctx.abortSignal,
      source: sandbox,
    });
    return {
      attemptDigest: result.receipt.attemptDigest,
      backendValidation,
      commandCount: result.receipt.commands.length,
      logs: result.receipt.commands.map((command) => ({
        name: command.name,
        ...(command.logs === undefined ? {} : { logs: command.logs }),
      })),
      productAcceptance: productAcceptanceObligations(current.appSpec, evidence, sourceAssessment),
      productBehaviorEvidence: evidence,
      productionHandoff,
      reused: false,
      sourceAssessment,
      status: backendValidationStatus(backendValidation.status),
      technicalStatus: "passed" as const,
    };
  },
  inputSchema: z.object({
    implementationFiles: implementationFilesSchema.default([]),
  }),
});
