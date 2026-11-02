/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Exact consumed tool context fields and unused receipt identity sentinels are explicitly documented in this local execution-port fixture. */
/* oxlint-disable sonarjs/no-internal-api-use -- Focused tool fixtures use actual Eve session state only in tests. */
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sourceReviewContextStoreForSession } from "./source-review-journal-runtime";
import { generateText, Output } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import type { AppDescription } from "../repository/app-description";
import { createAppValidationTool } from "../../agent/tools/validate_app_creation";
import { createChangeSetAcceptanceTool } from "../../agent/tools/accept_change_set";
import {
  appBuilderWorkflowState,
  APP_BUILDER_WORKFLOW_VERSION,
  sha256,
  assertExactWorkflowState,
} from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  currentProductSourceAssessment,
  productRequestState,
  reviewCurrentProductSource,
} from "./product-source-review-state";
import {
  assessProductSource,
  sourceReviewPolicy,
  unavailableSourceAssessment,
} from "./product-source-review";
import { applicationSourceReviewRubricDigest } from "./application-source-review";
import {
  prepareAppliedProductSourceReview,
  finalizeAppliedProductSourceReview,
  currentScopedProductSourceAssessment,
  retainScopedProductSourceAssessment,
  sourceReviewScopeBindingDigest,
} from "./review-applied-product-source";
import { deriveNormalizedChangeSet } from "../repository/reviewed-change-set";
import { createTargetValidationAttempt, validationBinding } from "../repository/target-validation";
import type { TargetApplyReceipt } from "../repository/target-apply";
import { createGitHubDestinationReviewBinding } from "../repository/github-destination-review";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "../repository/github-publication";

const staticDescription: AppDescription = {
  app: { id: "example", routes: [], workspacePath: "apps/example" },
  backend: { kind: "static" },
  validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
  version: 1,
};

const appSpec = {
  acceptedByCallId: "accepted",
  appId: "example",
  artifactPath: "prototype/example/app-spec.md",
  artifactRevision: "artifact",
  content: "Save records",
  digest: "spec",
};
const apply: TargetApplyReceipt = {
  appSpecDigest: appSpec.digest,
  appSpecPath: appSpec.artifactPath,
  appliedByCallId: "apply",
  applyRoot: "/workspace/repository",
  artifactRevision: appSpec.artifactRevision,
  changedContentDigest: "changed",
  changes: [],
  command: { exitCode: 0, name: "create-app", stderrDigest: "stderr", stdoutDigest: "stdout" },
  dependencyCacheContentDigest: "dependencies",
  dependencyCacheDigest: "cache",
  dependencyReceiptDigest: "dependency",
  digest: "apply",
  eligibilityDigest: "eligibility",
  identityDigest: "identity",
  imageDigest: "image",
  planningTreeDigest: "planning",
  postTree: [],
  postTreeDigest: "applied-known-tree",
  preTree: [],
  preTreeDigest: "before",
  preparedTreeDigest: "prepared",
  proposalDigest: "proposal",
  sourceReceiptDigest: "source",
  sourceSha: "sha",
  sourceTree: "tree",
  status: "applied",
  targetReceipt: {
    appId: "example",
    mutations: ["apps/example", "microfrontends.json"],
    omittedAuthorities: ["provider-provisioning", "deployment", "production-readiness"],
    recovered: false,
    topology: { newDigest: "new", oldDigest: "old", path: "microfrontends.json" },
    version: 1,
    workspacePath: "apps/example",
  },
  version: 2,
  workspaceDigest: "workspace",
};
const initial = () => {
  // SAFETY: Real tools consume the complete typed apply receipt and exact spec above; unused preparation receipts are opaque identity sentinels in this execution-port fixture.
  const state = {
    appSpec,
    applyReceipt: apply,
    artifacts: [],
    dependencyReceipt: { dependencyLayout: {} },
    identityReceipt: {},
    phase: "applied",
    preparedByCallId: "prepare",
    proposal: {
      digest: "proposal",
      target: {
        operation: "iterate-existing-app",
        plan: { source: { workspacePath: "apps/example" } },
      },
    },
    sourceReceipt: {},
    version: APP_BUILDER_WORKFLOW_VERSION,
    workspace: {},
  } as unknown as AppBuilderWorkflowState;
  appBuilderWorkflowState.update(() => state);
  productRequestState.update(() => ({
    clarifications: [],
    original: "Save records",
    sequences: [],
  }));
};
const context = (callId: string) =>
  // SAFETY: These tool executions use only callId, getSandbox, session identity/turn and cancellation; actual Eve state is bound by contextStorage.run.
  ({
    callId,
    getSandbox: async () =>
      await Promise.resolve({
        id: "local-fixture",
        readTextFile: () => Promise.resolve(JSON.stringify({ scripts: { test: "vitest run" } })),
      }),
    session: { auth: null, id: "local-session", turn: { id: "turn" } },
  }) as unknown as Parameters<ReturnType<typeof createAppValidationTool>["execute"]>[1];
const emptyJudgment = z.object({
  findings: z.array(z.never()),
  remainingRuntimeChecks: z.array(z.string()),
});
const sourceModel = () =>
  new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          text: JSON.stringify({
            findings: [],
            remainingRuntimeChecks: ["Execute save and independent readback"],
          }),
          type: "text",
        },
      ],
      finishReason: { raw: "stop", unified: "stop" },
      usage: {
        inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
        outputTokens: { reasoning: 0, text: 1, total: 1 },
      },
      warnings: [],
    },
  });

it("repeated intermediate validation executes technical checks and returns deferred source evidence", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    initial();
    let technicalRuns = 0;
    const boundaries: string[] = [];
    const compilerInput = {
      APP_SCHEMA_TRANSITION_PREDECESSOR_FILES:
        '["/private/original-predecessor/app-artifact.json"]',
    };
    const tool = createAppValidationTool({
      async captureRelease() {
        boundaries.push("capture");
        return await Promise.resolve(null);
      },
      async describeApp() {
        boundaries.push("describe");
        return await Promise.resolve(staticDescription);
      },
      async executeValidation(input) {
        expect(input.environment).toEqual(compilerInput);
        technicalRuns += 1;
        boundaries.push("commands");
        return await Promise.resolve({
          ok: true,
          receipt: {
            ...validationBinding(input.apply),
            attemptDigest: input.attempt.digest,
            commands: [],
            digest: `validation-${technicalRuns}`,
            status: "passed",
            validatedByCallId: input.attempt.startedByCallId,
            version: 3,
          },
        });
      },
      async prepareSchemaInput() {
        return await Promise.resolve({ environment: compilerInput });
      },
      async validateBackend() {
        boundaries.push("browser");
        return await Promise.resolve({ status: "unassessed" });
      },
    });
    const acceptedRequest = {
      appSpecDigest: appSpec.digest,
      clarifications: [],
      originalRequest: "Save records",
      sourceDigest: apply.postTreeDigest,
    };
    for (const callId of ["validation-first", "validation-repeat", "validation-ready"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Repeated calls must observe the state transition from the preceding validation.
      const result = await tool.execute({ implementationFiles: [] }, context(callId));
      expect(result).toMatchObject({
        reused: false,
        sourceAssessment: { findings: [], reviewCompleted: false, status: "unassessed" },
        technicalStatus: "passed",
      });
      const sourceEvidence = z
        .object({
          sourceAssessment: z.object({ omissions: z.array(z.string()), reason: z.string() }),
        })
        .parse(result).sourceAssessment;
      expect(sourceEvidence.reason).toContain("deferred to final change-set acceptance");
      expect(sourceEvidence.omissions[0]).toContain("not observed");
      expect(currentProductSourceAssessment(acceptedRequest)).toBeUndefined();
    }
    expect(technicalRuns).toBe(3);
    expect(boundaries).toEqual(
      Array.from({ length: 3 }, () => ["commands", "describe", "capture", "browser"]).flat(),
    );
    expect(appBuilderWorkflowState.get().phase).toBe("validated");
  });
});

it("final acceptance permits absent or incomplete destination inspection coverage and reuses only matching completed source", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    initial();
    const attempt = createTargetValidationAttempt(apply, "validation");
    const validation = {
      ...validationBinding(apply),
      attemptDigest: attempt.digest,
      commands: [],
      digest: "validation",
      status: "passed" as const,
      validatedByCallId: "validation",
      version: 3 as const,
    };
    const before = appBuilderWorkflowState.get();
    if (before.phase !== "applied") {
      throw new Error("Expected applied fixture");
    }
    appBuilderWorkflowState.update(() => ({
      ...before,
      phase: "validated",
      validationReceipt: validation,
    }));
    const model = sourceModel();
    let source = "export const save = true;";
    let observations = 0;
    const tool = createChangeSetAcceptanceTool({
      async observeChangeSet() {
        return await Promise.resolve({
          changeSet: deriveNormalizedChangeSet(apply, validation, "contract"),
          observed: { files: apply.postTree, treeDigest: apply.postTreeDigest },
        });
      },
      async reviewSource(input) {
        expect(input.normalizedChanges).toEqual(apply.changes);
        expect(input.observed).toEqual({ files: apply.postTree, treeDigest: apply.postTreeDigest });
        observations += 1;
        const request = productRequestState.get();
        const reviewInput = {
          appSpec: input.appSpec.content ?? "",
          appSpecDigest: input.appSpec.digest,
          clarifications: request.clarifications,
          files: [{ content: source, path: "apps/example/page.ts" }],
          omissions: [],
          originalRequest: request.original,
          sourceDigest: sha256(source),
        };
        return await reviewCurrentProductSource(
          reviewInput,
          false,
          () => sha256(source),
          undefined,
          input.abortSignal,
          async (observed, options) =>
            await assessProductSource(observed, {
              ...options,
              async generate() {
                const generated = await generateText({
                  model,
                  output: Output.object({ schema: emptyJudgment }),
                  prompt: JSON.stringify(observed),
                });
                return generated.output;
              },
            }),
        );
      },
    });
    const validationBoundaries: string[] = [];
    const validator = createAppValidationTool({
      async captureRelease() {
        validationBoundaries.push("capture");
        return await Promise.resolve(null);
      },
      async describeApp() {
        validationBoundaries.push("describe");
        return await Promise.resolve(staticDescription);
      },
      async executeValidation() {
        validationBoundaries.push("commands");
        return await Promise.resolve({ ok: true, receipt: validation });
      },
      async validateBackend() {
        validationBoundaries.push("browser");
        return await Promise.resolve({ status: "unassessed" });
      },
    });
    await validator.execute({ implementationFiles: [] }, context("intermediate-one"));
    await validator.execute({ implementationFiles: [] }, context("intermediate-two"));
    expect(validationBoundaries).toEqual([
      "commands",
      "describe",
      "capture",
      "browser",
      "commands",
      "describe",
      "capture",
      "browser",
    ]);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(appBuilderWorkflowState.get()).toMatchObject({
      phase: "validated",
      appBackendKind: "static",
    });
    const installation = createGitHubInstallationIdentity({
      accountId: "20",
      accountLogin: "withAutograph",
      accountType: "Organization",
      installationId: "10",
      operation: "resolve-existing-source",
      repositorySelection: "selected",
      selectedRepositoryIds: ["100"],
    });
    const repository = createRepositoryObservation({
      defaultBranch: "main",
      headSha: "1".repeat(40),
      headTree: "2".repeat(40),
      installationIdentityDigest: installation.digest,
      name: "example",
      owner: "withAutograph",
      releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
      repositoryId: "100",
      visibility: "private",
    });
    const githubDestinationReview = createGitHubDestinationReviewBinding({
      applyDigest: apply.digest,
      candidatePaths: [],
      installation,
      postTreeDigest: apply.postTreeDigest,
      preTree: [],
      repository,
      validationDigest: validation.digest,
    });
    appBuilderWorkflowState.update((current) => {
      if (current.phase !== "validated") {
        throw new Error("Expected technically validated fixture");
      }
      return { ...current, githubDestinationReview };
    });
    expect(() => {
      assertExactWorkflowState(appBuilderWorkflowState.get(), before, "acceptance");
    }).toThrow("changed concurrently");
    const first = await tool.execute({}, context("final-first"));
    expect(appBuilderWorkflowState.get()).toMatchObject({
      phase: "reviewed",
      appBackendKind: "static",
    });
    expect(first).toMatchObject({
      sourceAssessment: { reviewCompleted: true, status: "unassessed" },
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    appBuilderWorkflowState.update((current) => {
      if (current.phase !== "reviewed") {
        throw new Error("Expected reviewed fixture");
      }
      return {
        ...current,
        githubDestinationReviewRead: {
          changeSetDigest: current.reviewReceipt.changeSetDigest,
          beforeComplete: true,
          afterComplete: false,
        },
      };
    });
    const same = await tool.execute({}, context("final-same"));
    expect(same).toMatchObject({ reused: true, sourceAssessment: { reviewCompleted: true } });
    expect(model.doGenerateCalls).toHaveLength(1);
    source = "export const save = false;";
    await tool.execute({}, context("final-changed-source"));
    expect(model.doGenerateCalls).toHaveLength(2);
    productRequestState.update((request) => ({ ...request, clarifications: ["Keep old records"] }));
    await tool.execute({}, context("final-changed-requirements"));
    expect(model.doGenerateCalls).toHaveLength(3);
    expect(observations).toBe(4);
  });
});

it("a deferred assessment is never eligible as completed review evidence", async () => {
  const input = {
    appSpec: "Save records",
    appSpecDigest: "spec",
    clarifications: [],
    files: [],
    omissions: [],
    originalRequest: "Save records",
    sourceDigest: "known",
  };
  const deferred = unavailableSourceAssessment(input, "Deferred to final acceptance");
  let assessments = 0;
  const result = await reviewCurrentProductSource(
    input,
    true,
    () => input.sourceDigest,
    { get: () => deferred, set() {} },
    undefined,
    async (observed) => {
      assessments += 1;
      return await Promise.resolve(
        unavailableSourceAssessment(observed, "Model remains unassessed"),
      );
    },
  );
  expect(assessments).toBe(1);
  expect(result.reviewCompleted).toBe(false);
  expect(result.reason).toBe("Model remains unassessed");
});

it("retains canonical acceptance evidence while requiring matching private review scope for reuse", () => {
  contextStorage.run(new ContextContainer(), () => {
    const input = {
      appSpec: "Save records",
      appSpecDigest: "spec",
      clarifications: [],
      files: [],
      omissions: [],
      originalRequest: "Save records",
      sourceDigest: "same-current-tree",
    };
    const changes = [{ kind: "added" as const, path: "apps/example/page.tsx" }];
    const expanded = [...changes, { kind: "added" as const, path: "apps/example/error.tsx" }];
    const policy = sourceReviewPolicy();
    const assessment = {
      ...unavailableSourceAssessment(input, "fixture", "unassessed", policy.primary),
      reviewCompleted: true,
      reviewPolicyId: policy.id,
      reviewRubricDigest: applicationSourceReviewRubricDigest(),
    };
    const scope = sourceReviewScopeBindingDigest(input, changes);
    retainScopedProductSourceAssessment(assessment, scope);
    expect(currentProductSourceAssessment(input)).toBe(assessment);
    expect(currentScopedProductSourceAssessment(input, scope)).toBe(assessment);
    expect(
      currentScopedProductSourceAssessment(input, sourceReviewScopeBindingDigest(input, expanded)),
    ).toBeUndefined();
    expect(currentProductSourceAssessment(input)).toBe(assessment);
  });
});

it("prepared review resumes in the original acceptance context without a second paid direct loop", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    initial();
    const attempt = createTargetValidationAttempt(apply, "validation");
    const validation = {
      ...validationBinding(apply),
      attemptDigest: attempt.digest,
      commands: [],
      digest: "validation",
      status: "passed" as const,
      validatedByCallId: "validation",
      version: 3 as const,
    };
    const before = appBuilderWorkflowState.get();
    if (before.phase !== "applied") {
      throw new Error("Expected applied fixture");
    }
    appBuilderWorkflowState.update(() => ({
      ...before,
      phase: "validated",
      validationReceipt: validation,
    }));
    const reference = { appId: "example", contextRef: "opaque-context" };
    let directCalls = 0;
    let preparedCalls = 0;
    let finalizedCalls = 0;
    const tool = createChangeSetAcceptanceTool({
      async observeChangeSet() {
        return await Promise.resolve({
          changeSet: deriveNormalizedChangeSet(apply, validation, "contract"),
          observed: { files: apply.postTree, treeDigest: apply.postTreeDigest },
        });
      },
      async reviewSource() {
        directCalls += 1;
        await Promise.resolve();
        throw new Error("Direct paid loop must not run");
      },
      async prepareSourceReview(input) {
        preparedCalls += 1;
        expect(input.sessionId).toBe("local-session");
        return await Promise.resolve({ reference });
      },
      async finalizeSourceReview(input) {
        finalizedCalls += 1;
        expect(input.reference).toEqual(reference);
        expect(input.sessionId).toBe("local-session");
        return await Promise.resolve(
          unavailableSourceAssessment(
            {
              appSpecDigest: input.appSpec.digest,
              clarifications: [],
              originalRequest: "Save records",
              sourceDigest: input.observed.treeDigest,
              appSpec: "Save records",
              files: [],
              omissions: [],
            },
            "Review workflow was interrupted; source remains unassessed.",
            "blocked",
          ),
        );
      },
    });
    const pending = await tool.execute({}, context("prepare-review"));
    expect(pending).toMatchObject({ status: "source_review_pending", sourceReview: reference });
    expect(appBuilderWorkflowState.get().phase).toBe("validated");
    const accepted = await tool.execute({ sourceReview: reference }, context("finish-review"));
    expect(accepted).toMatchObject({
      sourceAssessment: { reviewCompleted: false, status: "blocked" },
    });
    expect(appBuilderWorkflowState.get().phase).toBe("reviewed");
    expect({ directCalls, preparedCalls, finalizedCalls }).toEqual({
      directCalls: 0,
      preparedCalls: 1,
      finalizedCalls: 1,
    });
  });
});

it("captures parent evidence and finalizes a private durable outcome without rerunning assessment", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "review-prepare-finalize-")));
  try {
    await mkdir(path.join(root, "runs"), { mode: 0o700 });
    // Exercise real private persistence without invoking a model or any provider.
    vi.stubEnv("APP_BUILDER_TEST_MODEL", "0");
    for (const [key, value] of Object.entries({
      APP_BUILDER_DEV_RUNS_ROOT: path.join(root, "runs"),
      APP_BUILDER_EXECUTION_BUNDLE: "local-development",
      APP_BUILDER_EXECUTION_MODE: "development",
      APP_BUILDER_LOCAL_ADAPTER: "1",
      APP_BUILDER_SANDBOX_PROVIDER: "vercel",
      EVE_HOSTED_ADAPTER: "0",
    })) {
      vi.stubEnv(key, value);
    }
    await contextStorage.run(new ContextContainer(), async () => {
      initial();
      const observed = { files: [], treeDigest: sha256("[]") };
      const input = {
        appSpec,
        applyReceipt: apply,
        normalizedChanges: [],
        observed,
        // SAFETY: This controlled fixture provides the only consumed provider id and structured snapshot command; no Sandbox network methods are invoked.
        getSandbox: async () =>
          await Promise.resolve({
            id: "server-captured-sandbox",
            run: async () => await Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
          } as unknown as Awaited<
            ReturnType<Parameters<typeof prepareAppliedProductSourceReview>[0]["getSandbox"]>
          >),
        sessionAuth: {},
        sessionId: "native-parent",
      };
      const prepared = await prepareAppliedProductSourceReview(input);
      if (!("reference" in prepared)) {
        throw new Error("Expected private review reference");
      }
      const store = await sourceReviewContextStoreForSession({
        appId: "example",
        sessionAuth: {},
        sessionId: "native-parent",
      });
      const descriptor = await store.readContext(prepared.reference.contextRef);
      expect(descriptor.parentSessionId).toBe("native-parent");
      expect(descriptor.sandboxName).toBe("server-captured-sandbox");
      expect(descriptor.reviewInput.originalRequest).toBe("Save records");
      const unassessed = unavailableSourceAssessment(
        { ...descriptor.reviewInput, files: [] },
        "Evidence unavailable",
        "blocked",
      );
      const outcomeRef = await store.publishOutcome(prepared.reference.contextRef, unassessed);
      const result = await finalizeAppliedProductSourceReview({
        ...input,
        reference: { ...prepared.reference, outcomeRef },
      });
      expect(result).toMatchObject({ reviewCompleted: false, status: "blocked" });
      const policy = sourceReviewPolicy();
      const completed = {
        ...unassessed,
        modelId: policy.primary.modelId,
        reasoningEffort: policy.primary.reasoningEffort,
        reviewPolicyId: policy.id,
        reviewRubricDigest: applicationSourceReviewRubricDigest(),
        reviewCompleted: true,
        status: "unassessed" as const,
      };
      const completedRef = await store.publishOutcome(prepared.reference.contextRef, completed);
      expect(
        await finalizeAppliedProductSourceReview({
          ...input,
          reference: { ...prepared.reference, outcomeRef: completedRef },
        }),
      ).toMatchObject({ reviewCompleted: true });
      expect(await prepareAppliedProductSourceReview(input)).toMatchObject({
        assessment: { reviewCompleted: true, invocation: { journalReuses: 1 } },
      });
      expect(
        await finalizeAppliedProductSourceReview({
          ...input,
          reference: { ...prepared.reference, appId: "foreign" },
        }),
      ).toMatchObject({ reviewCompleted: false });
    });
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
