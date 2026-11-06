/* oxlint-disable github/filenames-match-regex -- Preserve the registered public tool name. */
import { assertApprovedPrivateApplySession } from "@/lib/agent/private-apply-authority";
import {
  ReviewedCheckRecipeRequiredError,
  prepareValidationPrivateComputeRepair,
} from "@/lib/agent/validation-private-compute-repair";
import {
  deletesPrivateComputeCheck,
  verifyPrivateComputeCheckIntegrity,
  privateComputeCheckIntegrityProblem,
} from "@/lib/agent/private-compute-check-integrity";
import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { validationLogsWithReadInputs } from "@/lib/agent/validation-log-read-input";
import { publishCompiledOperatorArtifactsForSession } from "@/lib/agent/compiled-operator-artifacts";
import {
  getBuilderSandboxId,
  setBuilderSandboxNetworkPolicy,
} from "../../lib/sandbox/builder-sandbox";
import { describeSelectedApp } from "@/lib/repository/app-description";
import { runAppBrowserTests } from "./run-app-browser-tests";
import { unavailableSourceAssessment } from "@/lib/agent/product-source-review";
import { productRequestState } from "@/lib/agent/product-source-review-state";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { draftReconciliationState } from "@/lib/agent/draft-reconciliation-state";
import { resolveDraftReviewedWorkflow } from "@/lib/agent/draft-reviewed-lineage";
import { validateDraftReconciliation } from "./validate_github_draft_pr_reconciliation";
import { currentDraftCandidateSource } from "@/lib/agent/published-draft-repair";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { prepareValidationLocalData } from "./prepare-app-local-preview";
import { resolvePreparedRuntimeExecution } from "@/lib/agent/prepared-runtime-execution";
import { prepareCompiledSchemaPredecessorsForValidationForSession } from "@/lib/agent/compiled-schema-validation-input";

import {
  applyImplementationFiles,
  assertExistingAppImplementationFiles,
  implementationFilesSchema,
} from "@/lib/agent/apply-implementation-files";
import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
} from "@/lib/agent/workflow-state";
import { repairCheckoutDependenciesAfterValidationFailure } from "@/lib/agent/checkout-dependencies";
import {
  createTargetValidationAttempt,
  readTargetValidationTestShards,
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
    return { status: "unassessed" as const };
  }
  return await runAppBrowserTests(input);
};

const prepareBackendValidationRuntime = async (
  description: Awaited<ReturnType<typeof describeSelectedApp>> | undefined,
  execution: () => Parameters<typeof resolvePreparedRuntimeExecution>[0],
  signal?: AbortSignal,
) => {
  if (description?.backend.kind !== GENERATED_BACKEND || description.validation.browser === null) {
    return { failure: null, runtime: null };
  }
  try {
    return { failure: null, runtime: await resolvePreparedRuntimeExecution(execution()) };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      failure: {
        problem:
          error instanceof Error ? error.message : "Authenticated runtime preparation failed.",
        reason: "authenticated-runtime-preparation",
        status: "blocked" as const,
      },
      runtime: null,
    };
  }
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
const appValidationInputSchema = z.object({
  implementationFiles: implementationFilesSchema.default([]),
  repairOnly: z.boolean().optional(),
  runBrowserTests: z.boolean().optional(),
});
type AppValidationInput = z.infer<typeof appValidationInputSchema>;
/** Internal execution ports keep the public tool fixed and focused fixtures faithful. */
export const createAppValidationTool = (
  executionPorts: AppValidationRuntime = appValidationRuntime,
) =>
  defineTool({
    description:
      "With no implementation files and a current owned draft, validate that actual isolated candidate through the normal draft-validation service without changing creation-workspace review state. Use repairOnly with implementationFiles to update the already approved app in its private checkout without running checks or requesting another Build. Open the updated app with start_app_preview. Otherwise validate the applied creation workspace at applyReceipt.applyRoot. Use validate_github_draft_pr_reconciliation for explicit candidate validation controls; creation-workspace results do not validate separate draft bytes. Command exit status is the technical validation result. Repository-owned local setup and technical checks precede full authenticated runtime preparation. Set runBrowserTests only when authenticated browser testing is wanted for this app. Report those results separately; a runtime block preserves the technical receipt. Independent paid source assessment can be requested at accept_change_set after implementation and technical checks are ready. None of these results alone proves hosted durability. This does not publish or otherwise change an external repository.",
    // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Keep the workflow phase, cancellation and original failure receipt branches explicit.
    async execute(input: AppValidationInput, ctx) {
      const workflowState = appBuilderWorkflowState.get();
      let current: AppBuilderWorkflowState;
      switch (workflowState.phase) {
        case "applied": {
          current = workflowState;
          break;
        }
        case "validation_pending": {
          current = workflowState;
          break;
        }
        case "validation_failed": {
          current = workflowState;
          break;
        }
        case "validated": {
          current = workflowState;
          break;
        }
        case "reviewed": {
          current = workflowState;
          break;
        }
        case "empty":
        case "prepared":
        case "ui_previewed":
        case "ui_accepted":
        case "app_spec_accepted":
        case "dependencies_prepared":
        case "identity_resolved":
        case "planned":
        case "apply_failed":
        case "publication_pending":
        case "publication_failed":
        case "published_local":
        case "branch_publication_pending":
        case "branch_publication_failed":
        case "published_branch_worktree":
        case "fresh_bootstrap_pending":
        case "fresh_bootstrap_failed":
        case "published_fresh_bootstrap": {
          throw new Error("Apply the requested changes before running the repository checks.");
        }
        default: {
          return workflowState satisfies never;
        }
      }
      if (input.repairOnly === true && input.implementationFiles.length === 0) {
        throw new Error("Supply the app files to repair before opening a working preview.");
      }
      const candidate = draftReconciliationState.get();
      const hasReviewedDraft =
        candidate !== null &&
        resolveDraftReviewedWorkflow(current, candidate) !== undefined &&
        currentDraftCandidateSource(current, candidate) !== undefined;
      if (input.implementationFiles.length === 0 && hasReviewedDraft) {
        return await validateDraftReconciliation(
          {
            additionalCheckTasks: [],
            incremental: false,
            runBrowserTests: input.runBrowserTests === true,
          },
          ctx,
        );
      }
      if (input.repairOnly === true) {
        assertApprovedPrivateApplySession({
          appId: current.appSpec.appId,
          appSpecDigest: current.appSpec.digest,
          proposalDigest: current.proposal.digest,
          sessionId: ctx.session.id,
          workspaceId: current.workspace.workspaceId,
        });
      }
      assertExistingAppImplementationFiles(input.implementationFiles, current.proposal.target);
      if (
        deletesPrivateComputeCheck(
          current.proposal.target.privateCompute,
          input.implementationFiles,
        )
      ) {
        return {
          failureClass: "private-compute-check-policy",
          problem: privateComputeCheckIntegrityProblem,
          reason: "validation-tooling-prerequisite",
          status: "needs_repair" as const,
        };
      }
      let repairComputeCheck: ReturnType<typeof prepareValidationPrivateComputeRepair>;
      try {
        repairComputeCheck = prepareValidationPrivateComputeRepair({
          files: input.implementationFiles,
          sessionId: ctx.session.id,
          signal: ctx.abortSignal,
          state: current,
        });
      } catch (error) {
        if (error instanceof ReviewedCheckRecipeRequiredError) {
          return {
            implementationFiles: [error.implementationFile],
            problem: error.message,
            reason: error.code,
            status: "needs_repair" as const,
          };
        }
        throw error;
      }
      validationPhase(ctx.callId, "resolving_sandbox");
      const sandbox = await ctx.getSandbox();
      validationPhase(ctx.callId, "sandbox_ready");
      const relativeApplyRoot = current.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
      const fixture = hasTestCapability("simulated-target");
      const priorPublishedGitHubDraftProposalDigest =
        current.publishedGitHubDraftProposalDigest ??
        (current.phase === "reviewed" ? current.githubDraftProposal?.proposal.digest : undefined);
      const base = {
        appSpec: current.appSpec,
        applyReceipt: current.applyReceipt,
        artifacts: current.artifacts,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: current.identityReceipt,
        preparedByCallId: current.preparedByCallId,
        proposal: current.proposal,
        sourceReceipt: current.sourceReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: current.workspace,
      };
      // SAFETY: workflowState was narrowed to validation-capable phases, whose shared fields match base.
      const workflowBase = { ...base } as typeof base & {
        publishedGitHubDraftProposalDigest?: string;
        checkoutDependencyAttempts?: typeof current.checkoutDependencyAttempts;
        githubSource?: typeof current.githubSource;
      };
      if (priorPublishedGitHubDraftProposalDigest !== undefined) {
        workflowBase.publishedGitHubDraftProposalDigest = priorPublishedGitHubDraftProposalDigest;
      }
      if (current.checkoutDependencyAttempts !== undefined) {
        workflowBase.checkoutDependencyAttempts = current.checkoutDependencyAttempts;
      }
      if (current.githubSource !== undefined) {
        workflowBase.githubSource = current.githubSource;
      }
      let checkoutDependencyAttempts = current.checkoutDependencyAttempts ?? [];
      appBuilderWorkflowState.update(() => ({
        ...workflowBase,
        phase: "applied",
      }));
      if (input.implementationFiles.length > 0) {
        invalidateProductBehaviorEvidence("source-repair");
        validationPhase(ctx.callId, "writing_implementation_files");
        ctx.abortSignal?.throwIfAborted();
        repairComputeCheck?.assertAuthorized();
        await applyImplementationFiles(sandbox, relativeApplyRoot, input.implementationFiles);
        await repairComputeCheck?.applyPolicy(sandbox);
        validationPhase(ctx.callId, "implementation_files_written");
      }
      if (input.repairOnly === true) {
        return { status: "repair_applied" as const };
      }
      if (
        !fixture &&
        !(await verifyPrivateComputeCheckIntegrity({
          appId: current.appSpec.appId,
          profile: current.proposal.target.privateCompute,
          root: current.applyReceipt.applyRoot,
          sandbox,
          signal: ctx.abortSignal,
        }))
      ) {
        return {
          failureClass: "private-compute-check-policy",
          problem: privateComputeCheckIntegrityProblem,
          reason: "validation-tooling-prerequisite",
          status: "needs_repair" as const,
        };
      }
      let logStore: Awaited<ReturnType<typeof validationLogStoreForSession>> | undefined;
      if (current.phase === "validation_failed") {
        let expected = appBuilderWorkflowState.get();
        const assertCurrent = () => {
          assertExactWorkflowState(
            appBuilderWorkflowState.get(),
            expected,
            "restore validation checkout dependencies",
          );
        };
        try {
          logStore = fixture
            ? undefined
            : await validationLogStoreForSession({
                sessionAuth: ctx.session.auth,
                sessionId: ctx.session.id,
              });
          await repairCheckoutDependenciesAfterValidationFailure({
            assertCurrent,
            attempts: checkoutDependencyAttempts,
            checkoutIdentity: current.applyReceipt.digest,
            failure: current.validationFailure,
            logStore,
            onAttempt: (dependencyAttempt) => {
              assertCurrent();
              const attempts = [
                ...checkoutDependencyAttempts.filter(
                  (saved) => saved.attemptDigest !== dependencyAttempt.attemptDigest,
                ),
                dependencyAttempt,
              ];
              appBuilderWorkflowState.update((latest) => {
                assertExactWorkflowState(latest, expected, "record dependency recovery");
                return { ...latest, checkoutDependencyAttempts: attempts };
              });
              expected = appBuilderWorkflowState.get();
              checkoutDependencyAttempts = attempts;
              workflowBase.checkoutDependencyAttempts = attempts;
            },
            prepareInstall: async () => {
              ctx.abortSignal?.throwIfAborted();
              assertCurrent();
              await setBuilderSandboxNetworkPolicy(sandbox, "allow-all");
            },
            root: current.applyReceipt.applyRoot,
            sandbox,
            sessionId: ctx.session.id,
            signal: ctx.abortSignal,
          });
        } catch (error) {
          appBuilderWorkflowState.update((latest) => {
            assertExactWorkflowState(latest, expected, "retain failed dependency recovery");
            return {
              ...workflowBase,
              checkoutDependencyAttempts,
              phase: "validation_failed",
              validationFailure: current.validationFailure,
            };
          });
          ctx.abortSignal?.throwIfAborted();
          return {
            dependencyAttempts: checkoutDependencyAttempts,
            problem:
              error instanceof Error ? error.message : "Repository dependency recovery failed.",
            reason: "dependency-recovery",
            status: "needs_repair" as const,
          };
        }
      }
      // Some repository test tasks start local services. Prepare the declared
      // local data task first so its server inherits the setup log file rather
      // than Turbo's captured test pipe, which would keep Turbo waiting after
      // the tests themselves have finished.
      const schemaInput = await prepareSchemaValidationInput({
        fixture,
        parameters: {
          adapterSessionId: ctx.session.id,
          appId: current.appSpec.appId,
          callId: ctx.callId,
          callbackExecution: hostedOperatorCallbackExecution(ctx.session),
          root: current.applyReceipt.applyRoot,
          sandbox,
          sessionAuth: ctx.session.auth,
          signal: ctx.abortSignal,
        },
        port: executionPorts.prepareSchemaInput,
      });
      if (!schemaInput.ok) {
        appBuilderWorkflowState.update(() => ({ ...workflowBase, phase: "applied" }));
        return schemaInput.result;
      }
      if (!fixture) {
        validationPhase(ctx.callId, "preparing_declared_local_data");
        try {
          // Repository-owned local setup keeps local services off the test runner's pipe.
          // No protected reference is resolved here; local technical data is not hosted evidence.
          await prepareValidationLocalData({
            appId: current.appSpec.appId,
            root: current.applyReceipt.applyRoot,
            sandbox,
            signal: ctx.abortSignal,
          });
        } catch (error) {
          ctx.abortSignal?.throwIfAborted();
          appBuilderWorkflowState.update(() => ({ ...workflowBase, phase: "applied" }));
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
      const testShards = await readTargetValidationTestShards({
        root: current.applyReceipt.applyRoot,
        sandbox,
        signal: ctx.abortSignal,
        workspacePath: current.applyReceipt.targetReceipt.workspacePath,
      });
      const attempt = createTargetValidationAttempt(current.applyReceipt, ctx.callId, testShards);
      appBuilderWorkflowState.update(() => ({
        ...workflowBase,
        phase: "validation_pending",
        validationAttempt: attempt,
      }));
      logStore ??= fixture
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
          : sandboxValidationCommandExecutor({ testShards }),
        logStore,
        sandbox,
        sessionId: ctx.session.id,
      });
      validationPhase(ctx.callId, "repository_commands_finished", result.ok);
      if (!result.ok) {
        appBuilderWorkflowState.update(() => ({
          ...workflowBase,
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
        ...workflowBase,
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
      appBuilderWorkflowState.update(() => ({
        ...workflowBase,
        appBackendKind: description?.backend.kind,
        phase: "validated",
        validationReceipt: result.receipt,
      }));
      validationPhase(ctx.callId, "capturing_validated_release");
      const captureFailure = await executionPorts.captureRelease(description, {
        adapterSessionId: ctx.session.id,
        appId: current.appSpec.appId,
        appSpecDigest: current.appSpec.digest,
        callId: ctx.callId,
        callbackExecution: hostedOperatorCallbackExecution(ctx.session),
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
      const browserDescription = input.runBrowserTests === true ? description : undefined;
      const preparedBackend = await prepareBackendValidationRuntime(
        browserDescription,
        () => ({
          appId: current.appSpec.appId,
          callbackExecution: hostedOperatorCallbackExecution(ctx.session),
          root: current.applyReceipt.applyRoot,
          sandboxId: getBuilderSandboxId(sandbox),
          sessionAuth: ctx.session.auth,
          sessionId: ctx.session.id,
          signal: ctx.abortSignal,
          state: current,
        }),
        ctx.abortSignal,
      );
      const { runtime } = preparedBackend;
      // A rejected protected reference never falls back to repository-local browser execution.
      const backendValidation =
        preparedBackend.failure ??
        (await executionPorts.validateBackend(browserDescription, {
          appId: current.appSpec.appId,
          root: current.applyReceipt.applyRoot,
          runtime,
          sandbox,
          signal: ctx.abortSignal,
        }));
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
            "Current source was not observed or independently assessed during technical validation; final acceptance observes the current implementation.",
          ],
          originalRequest: request.original,
          sourceDigest: current.applyReceipt.postTreeDigest,
        },
        "Independent source assessment can be requested separately during change-set acceptance.",
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
        logs: result.receipt.commands.map(
          (command) =>
            ({
              logs:
                command.logs === undefined
                  ? undefined
                  : validationLogsWithReadInputs(result.receipt.attemptDigest, command),
              name: command.name,
            }) satisfies { name: string; logs?: ReturnType<typeof validationLogsWithReadInputs> },
        ),
        productAcceptance: productAcceptanceObligations(
          current.appSpec,
          evidence,
          sourceAssessment,
        ),
        productBehaviorEvidence: evidence,
        productionHandoff,
        reused: false,
        sourceAssessment,
        technicalStatus: "passed" as const,
        status: backendValidationStatus(backendValidation.status),
      };
    },
    inputSchema: appValidationInputSchema,
  });

export default createAppValidationTool();
