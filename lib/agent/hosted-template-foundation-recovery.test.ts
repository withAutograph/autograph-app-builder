/* oxlint-disable sonarjs/no-internal-api-use -- Real installed Eve state proves retained session and approval authority across recovery. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Bounded fixtures model only recovery-consumed fields; the approval grant uses real Eve state. */
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { RuntimeSandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { createAppValidationTool } from "../../agent/tools/validate_app_creation";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Isolate the simulated external execution boundary while retaining the actual validation tool and receipt engine.
import * as testCapability from "../testing/test-capability";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Replace only external log persistence while exercising the real validation and recovery orchestration.
import * as validationLogRuntime from "./validation-log-store-for-session";
import { executeProposalBoundValidation } from "../repository/target-validation";
import type { ValidationLogStore, ValidationLogReference } from "../repository/validation-log";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { inspectCanonicalTemplateSnapshotReceipt } from "../repository/source-receipt";
import type { PreparedSandboxWorkspace } from "../repository/supported-template";
import type { HostedTemplateFoundationResult } from "../repository/hosted-template-source-reconciliation";
import {
  appBuilderWorkflowState,
  APP_BUILDER_WORKFLOW_VERSION,
  assertCurrentGitHubDraftProposal,
} from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "./source-state";
import {
  assertApprovedPrivateApplySession,
  readPrivateApplyAuthority,
  recordApprovedPrivateApply,
  requestPrivateApplyApproval,
} from "./private-apply-authority";
import { currentProductBehaviorGeneration } from "./product-behavior-state";
import { recoverHostedTemplateFoundation } from "./hosted-template-foundation-recovery";
import { hostedTemplateFoundationRecoveryHistory } from "./hosted-template-foundation-recovery-state";
import { resolveHostedTemplateFoundationBinding } from "./hosted-template-foundation-binding";
import { prepareValidationPrivateComputeRepair } from "./validation-private-compute-repair";
import {
  PRIVATE_COMPUTE_CHECK_TASK,
  privateComputeProfileSchema,
} from "../sandbox/private-compute-profile";

const scope = {
  appId: "notebook",
  appSpecDigest: "accepted-spec",
  proposalDigest: "approved-proposal",
  sessionId: "owned-session",
  workspaceId: "owned-workspace",
};
const subject = { appId: scope.appId, root: "/workspace/repository" };
const sourceReceipt = (identity: string) =>
  inspectCanonicalTemplateSnapshotReceipt({
    readinessDigest: "c".repeat(64),
    snapshot: {
      contents: {},
      contract: [],
      dirtyPaths: [],
      sourcePath: "/workspace/repository",
      sourceSha: identity.repeat(40),
      sourceTree: identity.repeat(40),
    },
  });
const originalSource = sourceReceipt("a");
const nextSource = sourceReceipt("b");
const workspace = (receipt = originalSource): PreparedSandboxWorkspace => ({
  adapter: receipt.adapter,
  eligibilityDigest: receipt.eligibilityDigest,
  sourcePath: receipt.sourcePath,
  sourceSha: receipt.sourceSha,
  sourceTree: receipt.sourceTree,
  workspaceDigest: receipt.sourceSha.slice(0, 1).repeat(64),
  workspaceId: scope.workspaceId,
  workspacePath: "/workspace/repository",
});
type ReviewedWorkflow = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
// SAFETY: The controlled workflow models the exact retained app/Build bindings
// consumed here; the grant itself is established through the real Eve state API.
const reviewed = (): ReviewedWorkflow => {
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Intentionally partial persisted fixture models the consumed scope; unrelated product metadata is outside this authority regression.
  const snapshot: unknown = {
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase: "reviewed",
    appSpec: {
      appId: scope.appId,
      digest: scope.appSpecDigest,
      artifactPath: ".config/app-specs/notebook.cue",
      artifactRevision: "accepted-revision",
      acceptedByCallId: "accept-spec",
      access: { mode: "private" },
    },
    artifacts: [{ path: "accepted-design" }],
    preparedByCallId: "original-prepare",
    sourceReceipt: originalSource,
    workspace: workspace(),
    dependencyReceipt: { digest: "original-dependencies" },
    identityReceipt: { digest: "original-private-identity" },
    proposal: {
      digest: scope.proposalDigest,
      appSpecDigest: scope.appSpecDigest,
      artifactRevision: "accepted-revision",
      sourceReceiptDigest: originalSource.digest,
      sourceSha: originalSource.sourceSha,
      sourceTree: originalSource.sourceTree,
      workspaceDigest: workspace().workspaceDigest,
      target: {
        contract: {
          appId: scope.appId,
          appSpec: { path: ".config/app-specs/notebook.cue", sha256: scope.appSpecDigest },
        },
      },
    },
    applyReceipt: {
      digest: "original-applied-app",
      appSpecDigest: scope.appSpecDigest,
      appSpecPath: ".config/app-specs/notebook.cue",
      artifactRevision: "accepted-revision",
      proposalDigest: scope.proposalDigest,
      applyRoot: subject.root,
      sourceReceiptDigest: originalSource.digest,
      sourceSha: originalSource.sourceSha,
      sourceTree: originalSource.sourceTree,
      workspaceDigest: workspace().workspaceDigest,
      targetReceipt: { appId: scope.appId, workspacePath: `apps/${scope.appId}` },
    },
    validationReceipt: { digest: "old-command-success" },
    reviewReceipt: { digest: "old-review" },
    githubDraftProposal: {
      proposal: { digest: "old-publication-approval", reviewDigest: "old-review" },
      sourceReceiptDigest: originalSource.digest,
    },
    githubDestinationReview: {
      digest: "old-destination-diff",
      validationDigest: "old-command-success",
    },
    publishedGitHubDraftProposalDigest: "owned-earlier-publication",
    checkoutDependencyAttempts: [{ attemptDigest: "retained-install" }],
  };
  // SAFETY: The fixture supplies recovery-consumed scope fields; real Eve approval and state transitions are exercised below.
  // oxlint-disable-next-line anti-slop/no-widen-then-assert -- The deliberately partial persisted fixture cannot claim to populate unrelated required product fields.
  return snapshot as ReviewedWorkflow;
};
const approve = (approved = scope) => {
  requestPrivateApplyApproval(approved, "original-build");
  recordApprovedPrivateApply(approved, "original-build");
};
const install = (state: AppBuilderWorkflowState = reviewed()) => {
  appBuilderWorkflowState.update(() => state);
  sourceWorkflowState.update(() => ({
    version: APP_BUILDER_SOURCE_VERSION,
    phase: "reviewed",
    receipt: originalSource,
  }));
  approve();
  return state;
};
const unavailableSandboxMethod = (): never => {
  throw new Error("Unexpected sandbox I/O outside the recovery transport");
};
const sandbox: RuntimeSandboxSession = {
  delete: unavailableSandboxMethod,
  stop: unavailableSandboxMethod,
  readBinaryFile: unavailableSandboxMethod,
  readFile: unavailableSandboxMethod,
  readTextFile: unavailableSandboxMethod,
  removePath: unavailableSandboxMethod,
  resolvePath: unavailableSandboxMethod,
  run: unavailableSandboxMethod,
  spawn: unavailableSandboxMethod,
  writeBinaryFile: unavailableSandboxMethod,
  writeFile: unavailableSandboxMethod,
  writeTextFile: unavailableSandboxMethod,
};
const outputStream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(output) {
      output.enqueue(new TextEncoder().encode(text));
      output.close();
    },
  });
const context = () => ({
  callId: "recover-failed-local-task",
  session: { id: scope.sessionId },
  getSandbox: vi.fn(async () => await Promise.resolve(sandbox)),
});
const changed = (): HostedTemplateFoundationResult => ({
  changed: true,
  sourceReceipt: nextSource,
  workspace: workspace(nextSource),
  provenance: {
    previousSourceReceiptDigest: originalSource.digest,
    previousWorkspaceDigest: workspace().workspaceDigest,
    previousSourceSha: originalSource.sourceSha,
    sourceSha: nextSource.sourceSha,
    sourceTree: nextSource.sourceTree,
    sourceSnapshotTree: "d".repeat(40),
    checkpointRef: "refs/app-builder/source-checkpoints/owned-session",
  },
});
type Reconcile = NonNullable<Parameters<typeof recoverHostedTemplateFoundation>[2]>;

describe("failed local task recovery of a retained hosted template", () => {
  it("retains the same app and original Build while requiring fresh validation and publication review", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = install();
      const authority = readPrivateApplyAuthority();
      const generation = currentProductBehaviorGeneration();
      const reconcile = vi.fn<Reconcile>(async (input) => {
        await input.assertCurrent();
        return await Promise.resolve(changed());
      });
      expect(await recoverHostedTemplateFoundation(context(), subject, reconcile)).toBe(true);
      const next = appBuilderWorkflowState.get();
      expect(next.phase).toBe("applied");
      if (next.phase !== "applied" || original.phase !== "reviewed") {
        throw new Error("Expected retained applied workflow");
      }
      expect(next.appSpec).toEqual(original.appSpec);
      expect(next.proposal).toEqual(original.proposal);
      expect(next.applyReceipt).toEqual(original.applyReceipt);
      expect(next.dependencyReceipt).toEqual(original.dependencyReceipt);
      expect(next.identityReceipt).toEqual(original.identityReceipt);
      expect(next.artifacts).toEqual(original.artifacts);
      expect(next.checkoutDependencyAttempts).toEqual(original.checkoutDependencyAttempts);
      expect(next.publishedGitHubDraftProposalDigest).toBe("owned-earlier-publication");
      expect(next.sourceReceipt).toEqual(nextSource);
      expect(next.workspace.workspaceId).toBe(scope.workspaceId);
      expect(next).not.toHaveProperty("validationReceipt");
      expect(next).not.toHaveProperty("reviewReceipt");
      expect(next).not.toHaveProperty("githubDestinationReview");
      expect(next).not.toHaveProperty("githubDraftProposal");
      expect(() =>
        assertCurrentGitHubDraftProposal({
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- This API represents a missing sealed proposal with undefined, not null.
          binding: undefined,
          expectedProposalDigest: "old-publication-approval",
          reviewDigest: "old-review",
          changeSetDigest: "old-change-set",
          sourceReceiptDigest: next.sourceReceipt.digest,
        }),
      ).toThrow("exact proposal sealed");
      expect(readPrivateApplyAuthority()).toEqual(authority);
      expect(() => {
        assertApprovedPrivateApplySession(scope);
      }).not.toThrow();
      expect(currentProductBehaviorGeneration()).toBe(generation + 1);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toMatchObject([
        {
          appId: scope.appId,
          sessionId: scope.sessionId,
          appSpecDigest: scope.appSpecDigest,
          proposalDigest: scope.proposalDigest,
          applyDigest: original.applyReceipt.digest,
          previousSourceReceipt: originalSource,
          previousWorkspace: original.workspace,
          sourceReceipt: nextSource,
          provenance: { checkpointRef: changed().provenance.checkpointRef },
        },
      ]);
      expect(sourceWorkflowState.get()).toMatchObject({ receipt: nextSource });
    });
  });

  it("leaves an unchanged foundation and its valid review untouched", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = install();
      const source = sourceWorkflowState.get();
      const generation = currentProductBehaviorGeneration();
      const reconcile = vi.fn<Reconcile>(
        async () =>
          await Promise.resolve({
            ...changed(),
            changed: false,
            sourceReceipt: originalSource,
            workspace: workspace(),
          }),
      );
      expect(await recoverHostedTemplateFoundation(context(), subject, reconcile)).toBe(false);
      expect(appBuilderWorkflowState.get()).toEqual(original);
      expect(sourceWorkflowState.get()).toEqual(source);
      expect(currentProductBehaviorGeneration()).toBe(generation);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it.each(["success", "selected-failure", "cancelled", "concurrent-change"] as const)(
    "recovers the actual failed setup in the same normal validation call: %s",
    async (outcome) => {
      await contextStorage.run(new ContextContainer(), async () => {
        const original = reviewed();
        install(original);
        const authority = readPrivateApplyAuthority();
        const controller = new AbortController();
        const commands: string[] = [];
        const schemaSources: string[] = [];
        let setupAttempts = 0;
        let recoveryCalls = 0;
        let sourceWrites = 0;
        const descriptor = JSON.stringify({
          version: 1,
          app: { id: scope.appId, routes: ["/notebook"], workspacePath: `apps/${scope.appId}` },
          backend: {
            kind: "generated-postgres",
            authorization: "app-owned",
            roles: [],
            release: {
              artifactHash: "test-release-hash",
              directory: "test-release",
              id: "test-v1",
            },
            runtime: { databaseEnvironment: "NOTEBOOK_DATABASE_URL" },
            schemaReceipt: null,
          },
          validation: {
            browser: null,
            check: { task: "check" },
            test: { shards: 1, task: "test" },
          },
        });
        const validationSandbox: RuntimeSandboxSession = {
          ...sandbox,
          readTextFile: async ({ path }) => {
            expect(path).toBe(`${subject.root}/apps/${scope.appId}/package.json`);
            return await Promise.resolve(
              JSON.stringify({ name: scope.appId, scripts: { test: "vitest run" } }),
            );
          },
          run: async ({ command, workingDirectory }) => {
            expect(command).toContain(`app:describe ${scope.appId}`);
            expect(workingDirectory).toBe(subject.root);
            return await Promise.resolve({ exitCode: 0, stdout: descriptor, stderr: "" });
          },
          spawn: async ({ command, workingDirectory }) => {
            expect(command).toContain(`app:runtime prepare ${scope.appId} local`);
            expect(workingDirectory).toBe(subject.root);
            setupAttempts += 1;
            const current = appBuilderWorkflowState.get();
            if (current.phase !== "applied") {
              throw new Error("Expected applied local setup");
            }
            expect(current.sourceReceipt.digest).toBe(
              setupAttempts === 1 ? originalSource.digest : nextSource.digest,
            );
            const exitCode = setupAttempts === 1 ? 1 : 0;
            return await Promise.resolve({
              pid: setupAttempts,
              stdout: outputStream(exitCode === 0 ? "same app runtime reused\n" : ""),
              stderr: outputStream(
                exitCode === 0 ? "" : "controlled old-foundation local setup failure\n",
              ),
              wait: async () => await Promise.resolve({ exitCode }),
              kill: async () => {
                await Promise.resolve();
              },
            });
          },
        };
        const chunks = new Map<string, { content: string; digest: string }>();
        const references = new Map<string, ValidationLogReference>();
        const logStore: ValidationLogStore = {
          putChunk: async (key, index, content, digest) => {
            chunks.set(`${key.logId}/${index}`, { content, digest });
            await Promise.resolve();
          },
          publish: async (key, reference) => {
            references.set(key.logId, reference);
            await Promise.resolve();
          },
          removeStaged: async () => {
            await Promise.resolve();
          },
          getReference: async (key) => await Promise.resolve(references.get(key.logId)),
          getChunk: async (key, index) =>
            await Promise.resolve(chunks.get(`${key.logId}/${index}`)),
        };
        const simulated = vi.spyOn(testCapability, "hasTestCapability").mockReturnValue(false);
        const logs = vi
          .spyOn(validationLogRuntime, "validationLogStoreForSession")
          .mockResolvedValue(logStore);
        const reconcile: Reconcile = async (input) => {
          if (outcome === "cancelled") {
            controller.abort(new Error("creator cancelled recovery"));
          }
          if (outcome === "concurrent-change") {
            appBuilderWorkflowState.update((state) =>
              state.phase === "empty" ? state : { ...state, preparedByCallId: "other-owner-turn" },
            );
          }
          await input.assertCurrent();
          sourceWrites += 1;
          return changed();
        };
        try {
          const tool = createAppValidationTool({
            recoverSource: async (ctx, selected) => {
              recoveryCalls += 1;
              expect(setupAttempts).toBe(1);
              return await recoverHostedTemplateFoundation(ctx, selected, reconcile);
            },
            prepareSchemaInput: async () => {
              const current = appBuilderWorkflowState.get();
              if (current.phase === "empty") {
                throw new Error("Expected saved app source");
              }
              schemaSources.push(current.sourceReceipt.sourceSha);
              return await Promise.resolve({
                environment: { SCHEMA_INPUT_SOURCE_SHA: current.sourceReceipt.sourceSha },
              });
            },
            captureRelease: async () => await Promise.resolve(null),
            describeApp: async () => {
              await Promise.resolve();
              // oxlint-disable-next-line unicorn/no-useless-undefined -- Undefined is the supported unassessed app-description result.
              return undefined;
            },
            executeValidation: async (input) =>
              await executeProposalBoundValidation({
                ...input,
                executor: async ({ command, validationRoot }) => {
                  expect(validationRoot).toBe(subject.root);
                  expect(appBuilderWorkflowState.get()).toMatchObject({
                    phase: "validation_pending",
                    sourceReceipt: nextSource,
                    proposal: original.proposal,
                  });
                  expect(input.environment?.SCHEMA_INPUT_SOURCE_SHA).toBe(nextSource.sourceSha);
                  commands.push(command);
                  const exitCode =
                    outcome === "selected-failure" && command.includes("app:test") ? 1 : 0;
                  return await Promise.resolve({
                    exitCode,
                    stdout: "current checkout command completed",
                    stderr: exitCode === 0 ? "" : "controlled selected app test failure",
                  });
                },
              }),
            validateBackend: async () => await Promise.resolve({ status: "unassessed" as const }),
          });
          // SAFETY: The real validation tool consumes these ordinary tool/session fields; sandbox execution is the controlled external boundary above.
          const ctx = {
            ...context(),
            callId: "validate-recovered-app",
            abortSignal: controller.signal,
            getSandbox: async () => await Promise.resolve(validationSandbox),
            getToken: unavailableSandboxMethod,
            requireAuth: unavailableSandboxMethod,
            session: {
              id: scope.sessionId,
              auth: { current: null, initiator: null },
              turn: { id: "recovered-turn", sequence: 2 },
            },
            toolName: "validate_app_creation",
          } as ToolContext;
          const execution = tool.execute({ implementationFiles: [] }, ctx);
          if (outcome === "cancelled" || outcome === "concurrent-change") {
            await expect(execution).rejects.toThrow(
              outcome === "cancelled" ? "creator cancelled recovery" : "changed concurrently",
            );
            expect(setupAttempts).toBe(1);
            expect(sourceWrites).toBe(0);
            expect(recoveryCalls).toBe(1);
            expect(commands).toEqual([]);
            expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
            expect(readPrivateApplyAuthority()).toEqual(authority);
            return;
          }
          const result = await execution;
          expect(setupAttempts).toBe(2);
          expect(recoveryCalls).toBe(1);
          expect(sourceWrites).toBe(1);
          expect(schemaSources).toContain(originalSource.sourceSha);
          expect(schemaSources.at(-1)).toBe(nextSource.sourceSha);
          if (outcome === "selected-failure") {
            expect(result).toMatchObject({ status: "needs_repair", reason: "command-failed" });
            const failed = appBuilderWorkflowState.get();
            if (failed.phase !== "validation_failed") {
              throw new Error("Expected selected app test failure");
            }
            expect(failed.validationFailure.sourceReceiptDigest).toBe(nextSource.digest);
            expect(failed.validationFailure.commandFailure?.exitCode).toBe(1);
            expect(readPrivateApplyAuthority()).toEqual(authority);
            return;
          }
          expect(result).toMatchObject({
            status: "validated",
            technicalStatus: "passed",
            reused: false,
          });
          expect(commands.length).toBeGreaterThan(0);
          expect(commands.every((command) => command.includes(scope.appId))).toBe(true);
          const next = appBuilderWorkflowState.get();
          if (next.phase !== "validated") {
            throw new Error("Expected a new technical validation result");
          }
          expect(next.validationReceipt.commands.map(({ name }) => name)).toEqual(
            expect.arrayContaining(["check-build", "test"]),
          );
          expect(next.validationReceipt.digest).not.toBe("old-command-success");
          expect(next.validationReceipt.validatedByCallId).toBe("validate-recovered-app");
          expect(next.validationReceipt.sourceReceiptDigest).toBe(nextSource.digest);
          expect(next.validationReceipt.sourceSha).toBe(nextSource.sourceSha);
          expect(next.validationReceipt.workspaceDigest).toBe(
            workspace(nextSource).workspaceDigest,
          );
          expect(next.sourceReceipt).toEqual(nextSource);
          expect(next.proposal).toEqual(original.proposal);
          expect(next.applyReceipt).toEqual(original.applyReceipt);
          expect(readPrivateApplyAuthority()).toEqual(authority);
          expect(() => {
            assertApprovedPrivateApplySession(scope);
          }).not.toThrow();
        } finally {
          simulated.mockRestore();
          logs.mockRestore();
        }
      });
    },
  );

  it("resolves only a complete owned source chain while preserving the original approved source", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = reviewed();
      install(original);
      expect(resolveHostedTemplateFoundationBinding(original, scope.sessionId)).toBeUndefined();
      const reconcile: Reconcile = async () => await Promise.resolve(changed());
      await recoverHostedTemplateFoundation(context(), subject, reconcile);
      const current = appBuilderWorkflowState.get();
      if (current.phase !== "applied") {
        throw new Error("Expected retained applied app");
      }
      const binding = resolveHostedTemplateFoundationBinding(current, scope.sessionId);
      expect(binding).toMatchObject({
        approvedSourceReceipt: originalSource,
        approvedWorkspace: original.workspace,
        currentSourceReceipt: nextSource,
        currentWorkspace: workspace(nextSource),
        executionFoundation: {
          sourceReceiptDigest: nextSource.digest,
          sourceSha: nextSource.sourceSha,
          sourceTree: nextSource.sourceTree,
          workspaceDigest: workspace(nextSource).workspaceDigest,
        },
      });
      expect(() => resolveHostedTemplateFoundationBinding(current, "other-session")).toThrow(
        "approved build session",
      );
    });
  });

  it("leaves ordinary same-source workspace overlays outside the foundation recovery bridge", () => {
    contextStorage.run(new ContextContainer(), () => {
      const state = reviewed();
      state.workspace = { ...state.workspace, workspaceDigest: "ordinary-local-overlay" };
      expect(resolveHostedTemplateFoundationBinding(state, scope.sessionId)).toBeUndefined();
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it.each(["app", "session", "spec", "proposal", "apply", "chain", "current-source"] as const)(
    "denies an unrelated %s in the completed source history",
    async (field) => {
      await contextStorage.run(new ContextContainer(), async () => {
        install();
        const reconcile: Reconcile = async () => await Promise.resolve(changed());
        await recoverHostedTemplateFoundation(context(), subject, reconcile);
        const current = appBuilderWorkflowState.get();
        if (current.phase !== "applied") {
          throw new Error("Expected retained applied app");
        }
        const record = structuredClone(hostedTemplateFoundationRecoveryHistory.get()[0]);
        if (record === undefined) {
          throw new Error("Expected completed recovery");
        }
        if (field === "app") {
          record.appId = "another-app";
        }
        if (field === "session") {
          record.sessionId = "another-session";
        }
        if (field === "spec") {
          record.appSpecDigest = "another-spec";
        }
        if (field === "proposal") {
          record.proposalDigest = "another-proposal";
        }
        if (field === "apply") {
          record.applyDigest = "another-apply";
        }
        if (field === "chain") {
          record.previousWorkspace.workspaceDigest = "unrelated-base";
        }
        if (field === "current-source") {
          record.sourceReceipt = sourceReceipt("e");
        }
        hostedTemplateFoundationRecoveryHistory.update(() => [record]);
        expect(() => resolveHostedTemplateFoundationBinding(current, scope.sessionId)).toThrow(
          "retained approved app",
        );
        expect(() => {
          assertApprovedPrivateApplySession(scope);
        }).not.toThrow();
      });
    },
  );

  it("repairs the originally approved canonical check task on the recovered owned checkout", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const state = reviewed();
      const digest = createHash("sha256").update(PRIVATE_COMPUTE_CHECK_TASK).digest("hex");
      const task = `apps/${scope.appId}/.config/mise/tasks/check`;
      state.proposal.target.privateCompute = privateComputeProfileSchema.parse({
        version: 1,
        id: "private-checks-16gib-v1",
        vcpus: 8,
        memoryMiB: 16_384,
        lintWorkers: 1,
        target: { sandboxId: scope.workspaceId, workspaceDrive: "same-private-drive" },
        checkPolicy: { path: task, beforeSha256: digest, afterSha256: digest },
        limits: {
          version: 1,
          teamId: "team_fixture",
          projectId: "prj_fixture",
          plan: "pro",
          maxVcpus: 8,
          limited: false,
          observedAt: "2026-11-10T00:00:00.000Z",
        },
      });
      install(state);
      const reconcile: Reconcile = async () => await Promise.resolve(changed());
      await recoverHostedTemplateFoundation(context(), subject, reconcile);
      const current = appBuilderWorkflowState.get();
      if (current.phase !== "applied") {
        throw new Error("Expected retained applied app");
      }
      const written = new Map<string, string>();
      const repair = prepareValidationPrivateComputeRepair(
        {
          state: current,
          files: [{ path: task, operation: "upsert", content: PRIVATE_COMPUTE_CHECK_TASK }],
          sessionId: scope.sessionId,
        },
        async ({ applyRoot, profile }) => {
          expect(applyRoot).toBe(subject.root);
          written.set(profile.checkPolicy.path, PRIVATE_COMPUTE_CHECK_TASK);
          await Promise.resolve();
        },
      );
      expect(repair).toBeDefined();
      await repair?.applyPolicy(sandbox);
      expect(written.get(task)).toBe(PRIVATE_COMPUTE_CHECK_TASK);
      expect(current.proposal).toEqual(state.proposal);
      expect(() => {
        assertApprovedPrivateApplySession(scope);
      }).not.toThrow();
    });
  });

  it("retains immutable original provenance across another recovery of the same app", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = reviewed();
      install(original);
      const first: Reconcile = async () => await Promise.resolve(changed());
      expect(await recoverHostedTemplateFoundation(context(), subject, first)).toBe(true);
      const retained = structuredClone(hostedTemplateFoundationRecoveryHistory.get()[0]);
      const laterSource = sourceReceipt("e");
      const second: Reconcile = async () =>
        await Promise.resolve({
          changed: true,
          sourceReceipt: laterSource,
          workspace: workspace(laterSource),
          provenance: {
            previousSourceReceiptDigest: nextSource.digest,
            previousWorkspaceDigest: workspace(nextSource).workspaceDigest,
            previousSourceSha: nextSource.sourceSha,
            sourceSha: laterSource.sourceSha,
            sourceTree: laterSource.sourceTree,
            sourceSnapshotTree: "f".repeat(40),
            checkpointRef: "refs/app-builder/source-checkpoints/later-transition",
          },
        });
      expect(await recoverHostedTemplateFoundation(context(), subject, second)).toBe(true);
      const history = hostedTemplateFoundationRecoveryHistory.get();
      expect(history).toHaveLength(2);
      expect(history[0]).toEqual(retained);
      expect(history[1]).toMatchObject({
        previousSourceReceipt: nextSource,
        sourceReceipt: laterSource,
        proposalDigest: scope.proposalDigest,
        applyDigest: "original-applied-app",
      });
      expect(appBuilderWorkflowState.get()).toMatchObject({
        phase: "applied",
        appSpec: original.appSpec,
        proposal: original.proposal,
        sourceReceipt: laterSource,
        publishedGitHubDraftProposalDigest: "owned-earlier-publication",
      });
      expect(() => {
        assertApprovedPrivateApplySession(scope);
      }).not.toThrow();
    });
  });

  it.each([
    "app",
    "root",
    "session",
    "workspace",
    "proposal-app",
    "accepted-spec",
    "apply-root",
  ] as const)("rejects a foreign %s before opening or writing the source", async (field) => {
    await contextStorage.run(new ContextContainer(), async () => {
      const state = reviewed();
      const selected = { ...subject };
      const ctx = context();
      if (field === "app") {
        selected.appId = "other-app";
      }
      if (field === "root") {
        selected.root = "/workspace/other";
      }
      if (field === "session") {
        ctx.session.id = "other-session";
      }
      if (field === "workspace") {
        state.workspace.workspaceId = "other-workspace";
      }
      if (field === "proposal-app") {
        state.proposal.target.contract.appId = "other-app";
      }
      if (field === "accepted-spec") {
        state.appSpec.digest = "unapproved-spec";
      }
      if (field === "apply-root") {
        state.applyReceipt.applyRoot = "/workspace/other";
      }
      install(state);
      const reconcile = vi.fn<Reconcile>();
      await expect(recoverHostedTemplateFoundation(ctx, selected, reconcile)).rejects.toThrow();
      expect(ctx.getSandbox).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
      expect(appBuilderWorkflowState.get()).toEqual(state);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it("rejects cancellation and a concurrent workflow change before a transport write", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = install();
      const controller = new AbortController();
      controller.abort(new Error("creator cancelled"));
      const reconcile = vi.fn<Reconcile>();
      const ctx = context();
      await expect(
        recoverHostedTemplateFoundation(
          { ...ctx, abortSignal: controller.signal },
          subject,
          reconcile,
        ),
      ).rejects.toThrow("creator cancelled");
      expect(ctx.getSandbox).not.toHaveBeenCalled();
      let writes = 0;
      const concurrent: Reconcile = async (input) => {
        appBuilderWorkflowState.update(() => ({ ...original, preparedByCallId: "other-turn" }));
        await input.assertCurrent();
        writes += 1;
        return await Promise.resolve(changed());
      };
      await expect(recoverHostedTemplateFoundation(context(), subject, concurrent)).rejects.toThrow(
        "changed concurrently",
      );
      expect(writes).toBe(0);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it("rechecks the retained Build after opening asynchronous compute", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      install();
      const ctx = context();
      ctx.getSandbox.mockImplementation(async () => {
        approve({ ...scope, proposalDigest: "new-unrelated-build" });
        return await Promise.resolve(sandbox);
      });
      const reconcile = vi.fn<Reconcile>();
      await expect(recoverHostedTemplateFoundation(ctx, subject, reconcile)).rejects.toThrow(
        "approved build session",
      );
      expect(reconcile).not.toHaveBeenCalled();
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it("resumes the original completed filesystem transition after interruption before the Eve CAS", async () => {
    const savedContext = new ContextContainer();
    await contextStorage.run(savedContext, async () => {
      const original = reviewed();
      install(original);
      const controller = new AbortController();
      const completed = changed();
      let writes = 0;
      let frozen: HostedTemplateFoundationResult | undefined;
      const reconcile: Reconcile = async (input) => {
        await input.assertCurrent();
        expect(input.sourceReceipt.digest).toBe(originalSource.digest);
        expect(input.workspace.workspaceDigest).toBe(original.workspace.workspaceDigest);
        if (frozen === undefined) {
          writes += 1;
          frozen = completed;
          controller.abort(new Error("interrupted after filesystem checkpoint"));
        }
        return await Promise.resolve(frozen);
      };
      await expect(
        recoverHostedTemplateFoundation(
          { ...context(), abortSignal: controller.signal },
          subject,
          reconcile,
        ),
      ).rejects.toThrow("interrupted after filesystem checkpoint");
      expect(appBuilderWorkflowState.get()).toEqual(original);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
      const authority = readPrivateApplyAuthority();
      const resumed = new ContextContainer();
      for (const [key, value] of savedContext.entries()) {
        resumed.set(key, structuredClone(value));
      }
      await contextStorage.run(resumed, async () => {
        expect(await recoverHostedTemplateFoundation(context(), subject, reconcile)).toBe(true);
        expect(writes).toBe(1);
        expect(readPrivateApplyAuthority()).toEqual(authority);
        expect(hostedTemplateFoundationRecoveryHistory.get()).toHaveLength(1);
        expect(hostedTemplateFoundationRecoveryHistory.get()[0]?.provenance).toEqual(
          completed.provenance,
        );
        expect(appBuilderWorkflowState.get()).toMatchObject({
          phase: "applied",
          appSpec: original.appSpec,
          proposal: original.proposal,
          applyReceipt: original.applyReceipt,
          sourceReceipt: nextSource,
        });
      });
    });
  });

  it("preserves the saved workflow and original error when reconciliation fails", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = install();
      const error = new Error("owned transition is interrupted");
      const reconcile: Reconcile = async () => await Promise.reject(error);
      await expect(recoverHostedTemplateFoundation(context(), subject, reconcile)).rejects.toBe(
        error,
      );
      expect(appBuilderWorkflowState.get()).toEqual(original);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it("does not let a transport error conceal changed Build authority", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = install();
      const transportFailure = new Error("source transport unavailable");
      const reconcile: Reconcile = async () => {
        approve({ ...scope, proposalDigest: "another-approved-build" });
        return await Promise.reject(transportFailure);
      };
      await expect(recoverHostedTemplateFoundation(context(), subject, reconcile)).rejects.toThrow(
        "approved build session",
      );
      expect(appBuilderWorkflowState.get()).toEqual(original);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it("rejects a foreign returned workspace without publishing source or recovery history", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const original = install();
      const reconcile: Reconcile = async () =>
        await Promise.resolve({
          ...changed(),
          workspace: { ...workspace(nextSource), workspaceId: "foreign-workspace" },
        });
      await expect(recoverHostedTemplateFoundation(context(), subject, reconcile)).rejects.toThrow(
        "another app workspace",
      );
      expect(appBuilderWorkflowState.get()).toEqual(original);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toEqual([]);
    });
  });

  it("does not require optional source metadata to repair the same approved applied app", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const state = reviewed();
      install({ ...state, phase: "applied" });
      sourceWorkflowState.update(() => ({ version: APP_BUILDER_SOURCE_VERSION, phase: "empty" }));
      const reconcile: Reconcile = async () => await Promise.resolve(changed());
      expect(await recoverHostedTemplateFoundation(context(), subject, reconcile)).toBe(true);
      expect(sourceWorkflowState.get()).toMatchObject({ phase: "reviewed", receipt: nextSource });
      expect(() => {
        assertApprovedPrivateApplySession(scope);
      }).not.toThrow();
    });
  });

  it("does not recover an unapplied or selected existing-repository workflow", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const ctx = context();
      const reconcile = vi.fn<Reconcile>();
      appBuilderWorkflowState.update(() => ({
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "empty",
      }));
      expect(await recoverHostedTemplateFoundation(ctx, subject, reconcile)).toBe(false);
      const state = reviewed();
      // SAFETY: Presence alone makes this workflow ineligible; no GitHub receipt fields are consumed.
      state.githubSource = { digest: "selected-existing-repository" } as NonNullable<
        typeof state.githubSource
      >;
      install(state);
      expect(await recoverHostedTemplateFoundation(ctx, subject, reconcile)).toBe(false);
      expect(ctx.getSandbox).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    });
  });
});
