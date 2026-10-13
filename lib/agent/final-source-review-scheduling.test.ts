/* oxlint-disable anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Exact consumed tool context fields and unused receipt identity sentinels are explicitly documented in this local execution-port fixture. */
/* oxlint-disable sonarjs/no-internal-api-use -- Focused tool fixtures use actual Eve session state only in tests. */
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { expect, it } from "vitest";
import { generateText, Output } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { createAppValidationTool } from "../../agent/tools/validate_app_creation";
import { createChangeSetAcceptanceTool } from "../../agent/tools/accept_change_set";
import { appBuilderWorkflowState, APP_BUILDER_WORKFLOW_VERSION, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  currentProductSourceAssessment,
  productRequestState,
  reviewCurrentProductSource,
} from "./product-source-review-state";
import { assessProductSource, unavailableSourceAssessment } from "./product-source-review";
import { deriveNormalizedChangeSet } from "../repository/reviewed-change-set";
import { createTargetValidationAttempt, validationBinding } from "../repository/target-validation";
import type { TargetApplyReceipt } from "../repository/target-apply";

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
    getSandbox: async () => await Promise.resolve({ id: "local-fixture" }),
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
    const tool = createAppValidationTool({
      async captureRelease() {
        boundaries.push("capture");
        return await Promise.resolve(null);
      },
      async describeApp() {
        boundaries.push("describe");
        // oxlint-disable-next-line typescript/no-confusing-void-expression, unicorn/no-useless-undefined -- The faithful describe port returns an absent description, matching its documented optional result.
        return await Promise.resolve(z.undefined().parse(undefined));
      },
      async executeValidation(input) {
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

it("final acceptance runs an independent local model assessment and reuses only matching completed source", async () => {
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
        return await Promise.resolve(deriveNormalizedChangeSet(apply, validation, "contract"));
      },
      async reviewSource(input) {
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
        // oxlint-disable-next-line typescript/no-confusing-void-expression, unicorn/no-useless-undefined -- Optional repository descriptions can be absent in the local fixture.
        return await Promise.resolve(z.undefined().parse(undefined));
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
    const first = await tool.execute({}, context("final-first"));
    expect(first).toMatchObject({
      sourceAssessment: { reviewCompleted: true, status: "unassessed" },
    });
    expect(model.doGenerateCalls).toHaveLength(1);
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
