import { validationLogsWithReadInputs } from "@/lib/agent/validation-log-read-input";
import { publishCompiledOperatorArtifactsForSession } from "@/lib/agent/compiled-operator-artifacts";
import { getBuilderSandboxId } from "../../lib/sandbox/builder-sandbox";
import { describeSelectedApp } from "@/lib/repository/app-description";
import { runAppBrowserTests } from "./run-app-browser-tests";
import { unavailableSourceAssessment } from "@/lib/agent/product-source-review";
import { productRequestState } from "@/lib/agent/product-source-review-state";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { prepareValidationLocalData } from "./prepare-app-local-preview";
import { prepareCompiledSchemaPredecessorsForValidationForSession } from "@/lib/agent/compiled-schema-validation-input";

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
import { validationLogStoreForSession } from "@/lib/agent/validation-log-store-for-session";
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

const describeValidationApp = async (
  fixture: boolean,
  input: Parameters<typeof describeSelectedApp>[0],
) => (fixture ? undefined : await describeSelectedApp(input));

const GENERATED_BACKEND = "generated-postgres";
const captureValidatedRelease = async (
  description: Awaited<ReturnType<typeof describeSelectedApp>> | undefined,
  input: Parameters<typeof publishCompiledOperatorArtifactsForSession>[0],
) => {
  if (description?.backend.kind !== GENERATED_BACKEND) {
    return null;
  }
  try {
    await publishCompiledOperatorArtifactsForSession(input);
    return null;
  } catch {
    input.signal?.throwIfAborted();
    return {
      problem:
        "The repository checks passed, but the selected compiled release could not be captured under current owner/session authority. Restore private artifact storage or session authority and retry validation; no extra schema compilation is required.",
      reason: "compiled-artifact-publication",
      status: "needs_repair" as const,
      technicalStatus: "passed" as const,
    };
  }
};

const validatePersistentBackend = async (
  description: Awaited<ReturnType<typeof describeSelectedApp>> | undefined,
  input: Parameters<typeof runAppBrowserTests>[0],
) => {
  if (description?.backend.kind !== GENERATED_BACKEND) {
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

export interface AppValidationRuntime {
  prepareSchemaInput?: typeof prepareCompiledSchemaPredecessorsForValidationForSession;
  captureRelease: typeof captureValidatedRelease;
  describeApp: typeof describeValidationApp;
  executeValidation: typeof executeProposalBoundValidation;
  validateBackend: typeof validatePersistentBackend;
}
const prepareSchemaValidationInput = async (input: {
  fixture: boolean;
  parameters: Parameters<typeof prepareCompiledSchemaPredecessorsForValidationForSession>[0];
  port?: typeof prepareCompiledSchemaPredecessorsForValidationForSession;
}) => {
  const prepare =
    input.port ??
    (input.fixture ? undefined : prepareCompiledSchemaPredecessorsForValidationForSession);
  if (prepare === undefined) {
    return { environment: {}, ok: true as const };
  }
  try {
    const prepared = await prepare(input.parameters);
    return { environment: prepared.environment, ok: true as const };
  } catch {
    input.parameters.signal?.throwIfAborted();
    return {
      ok: false as const,
      result: {
        problem:
          "The saved compilation's predecessor artifacts could not be restored under this session's owner. Restore the retained compiled artifacts and retry validation.",
        reason: "schema-validation-input",
        status: "needs_repair" as const,
      },
    };
  }
};

const appValidationRuntime: AppValidationRuntime = {
  captureRelease: captureValidatedRelease,
  describeApp: describeValidationApp,
  executeValidation: executeProposalBoundValidation,
  validateBackend: validatePersistentBackend,
};
/** Internal execution ports keep the public tool fixed and focused fixtures faithful. */
export const createAppValidationTool = (
  executionPorts: AppValidationRuntime = appValidationRuntime,
) =>
  defineTool({
    description:
      "Run the repository's normal validation commands against the current applied app. Command exit status is the technical validation result. For persistent apps, also run the declared authenticated browser task against the prepared runtime and report its result separately. Independent paid source assessment is deferred to final accept_change_set after implementation and technical checks are ready; deferred evidence is unassessed and does not require another validation run. None of these results alone proves hosted durability. This does not publish or otherwise change an external repository.",
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
      const schemaInput = await prepareSchemaValidationInput({
        fixture,
        parameters: {
          adapterSessionId: ctx.session.id,
          appId: current.appSpec.appId,
          callId: ctx.callId,
          root: current.applyReceipt.applyRoot,
          sandbox,
          sessionAuth: ctx.session.auth,
          signal: ctx.abortSignal,
        },
        port: executionPorts.prepareSchemaInput,
      });
      if (!schemaInput.ok) {
        appBuilderWorkflowState.update(() => ({ ...base, phase: "applied" }));
        return schemaInput.result;
      }
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
      const logStore = fixture
        ? undefined
        : await validationLogStoreForSession({
            sessionAuth: ctx.session.auth,
            sessionId: ctx.session.id,
          });
      const result = await executionPorts.executeValidation({
        abortSignal: ctx.abortSignal,
        appId: current.appSpec.appId,
        apply: current.applyReceipt,
        attempt,
        dependencyLayout: current.dependencyReceipt.dependencyLayout,
        environment: schemaInput.environment,
        executor: fixture
          ? fixtureValidationCommandExecutor()
          : sandboxValidationCommandExecutor({ runtime }),
        logStore,
        sandbox,
        sessionId: ctx.session.id,
      });
      validationPhase(ctx.callId, "repository_commands_finished", result.ok);
      if (!result.ok) {
        appBuilderWorkflowState.update(() => ({
          ...base,
          phase: "validation_failed",
          validationFailure: result.receipt,
        }));
        const lastCommand = result.receipt.commands.at(-1);
        return {
          attemptDigest: result.receipt.attemptDigest,
          commandFailure: result.receipt.commandFailure,
          diagnostics: result.receipt.diagnostics ?? [],
          logs:
            lastCommand === undefined
              ? undefined
              : validationLogsWithReadInputs(result.receipt.attemptDigest, lastCommand),
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
      validationPhase(ctx.callId, "describing_validation_app");
      const description = await executionPorts.describeApp(fixture, {
        appId: current.appSpec.appId,
        root: current.applyReceipt.applyRoot,
        sandbox,
        signal: ctx.abortSignal,
      });
      validationPhase(ctx.callId, "validation_app_described", description !== undefined);
      validationPhase(ctx.callId, "capturing_validated_release");
      const captureFailure = await executionPorts.captureRelease(description, {
        adapterSessionId: ctx.session.id,
        appId: current.appSpec.appId,
        appSpecDigest: current.appSpec.digest,
        callId: ctx.callId,
        root: current.applyReceipt.applyRoot,
        sandbox,
        sessionAuth: ctx.session.auth,
        signal: ctx.abortSignal,
      });
      validationPhase(
        ctx.callId,
        "validated_release_capture_finished",
        captureFailure === null ? "no_repair_required" : "needs_repair",
      );
      if (captureFailure !== null) {
        return {
          ...captureFailure,
          attemptDigest: result.receipt.attemptDigest,
          logs: result.receipt.commands.map((command) => ({
            logs: validationLogsWithReadInputs(result.receipt.attemptDigest, command),
            name: command.name,
          })),
        };
      }
      validationPhase(ctx.callId, "validating_persistent_backend");
      const backendValidation = await executionPorts.validateBackend(description, {
        appId: current.appSpec.appId,
        root: current.applyReceipt.applyRoot,
        runtime,
        sandbox,
        signal: ctx.abortSignal,
      });
      validationPhase(
        ctx.callId,
        "persistent_backend_validation_finished",
        backendValidation.status,
      );
      ctx.abortSignal?.throwIfAborted();
      const request = productRequestState.get();
      const sourceAssessment = unavailableSourceAssessment(
        {
          appSpec: current.appSpec.content ?? "",
          appSpecDigest: current.appSpec.digest,
          clarifications: request.clarifications,
          files: [],
          omissions: [
            "Current source was not observed or independently assessed during technical validation; final acceptance observes and reviews the current implementation.",
          ],
          originalRequest: request.original,
          sourceDigest: current.applyReceipt.postTreeDigest,
        },
        "Independent source assessment is deferred to final change-set acceptance. Complete implementation and technical checks, then call accept_change_set for the final review.",
      );
      validationPhase(ctx.callId, "source_review_deferred", sourceAssessment.status);
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
          ...(command.logs === undefined
            ? {}
            : {
                logs: validationLogsWithReadInputs(result.receipt.attemptDigest, command),
              }),
        })),
        productAcceptance: productAcceptanceObligations(
          current.appSpec,
          evidence,
          sourceAssessment,
        ),
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

export default createAppValidationTool();
