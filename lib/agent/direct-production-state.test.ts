/* oxlint-disable sonarjs/no-internal-api-use -- Exercise actual Eve state in the approval fixture. */
import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../../node_modules/eve/dist/src/context/keys.js";
import { createToolLoopHarness } from "../../node_modules/eve/dist/src/harness/tool-loop.js";
import type {
  HarnessSession,
  HarnessToolMap,
} from "../../node_modules/eve/dist/src/harness/types.js";
import { stampMessageStreamEvent } from "../../node_modules/eve/dist/src/protocol/message.js";
import type { MessageStreamEvent } from "eve/client";
import type { ToolContext } from "eve/tools";
import { z } from "zod";

import applyAppCreation from "../../agent/tools/apply_app_creation";
import releaseAppProduction from "../../agent/tools/release-app-production";
import {
  assertDirectRepositoryProductionApproval,
  readRepositoryProductionApproval,
} from "../eve/private-repository-production-approval";
import { observePrivateApplyDenials } from "../eve/private-apply-denial-evidence";
import {
  repositoryProductionApprovalInput,
  repositoryProductionApprovalReference,
} from "../provisioning/repository-production-approval";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The partial repository mock retains the full module contract.
import type * as targetApply from "../repository/target-apply";
import {
  createRealmContinuationServiceAuth,
  mintRealmContinuationAuthority,
  readRealmContinuationServiceIdentity,
} from "../hosted/realm-continuation-authority";
import {
  currentDirectProductionGrant,
  currentPlannedDirectProductionAuthoring,
  directProductionSubjectForPlan,
  recordDirectProductionGrant,
  requestDirectProductionGrant,
} from "./direct-production-state";
import {
  readPrivateApplyAuthority,
  recordApprovedPrivateApply,
  requestPrivateApplyApproval,
  retainPrivateApplyDenials,
} from "./private-apply-authority";
import { currentAuthoringDecision } from "./preapproval-authoring-runtime";
import {
  diagnosticBuildDecisionState,
  emitCurrentBuildWorkflowProjection,
} from "./approved-build-continuation-runtime";
import { stageImplementationFiles } from "./staged-implementation";
import { appBuilderWorkflowState, updateExactWorkflow } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  ARRUSTED_PRODUCTION_REPOSITORY,
  directProductionSubjectSchema,
} from "./direct-production-authorization";
import type { ReadyRepositoryAccess } from "../integrations/repository-access";
import type { ExistingRepositoryDestination } from "../provisioning/builder-session-destination-contract";
import { implementationFilesSchema } from "./apply-implementation-files";
import { approvePrepareAppProduction } from "./prepare-app-production-step";
import {
  recordRepositoryAccessReceipt,
  repositoryAccessReceiptState,
} from "./repository-access-state";

const sessionId = "owned-session";
const specDigest = "c".repeat(64);
const proposalDigest = "d".repeat(64);
const appId = "fixture-app";
const buildWorkspaceId = "private-build";
const cuePath = `.config/app-specs/${appId}.cue`;
const appliedCuePath = `apps/${appId}/schema/${appId}.cue`;
const cue = { content: "package fixture_app", path: cuePath };
const planned = { phase: "planned" } as const;
const { repositoryCommand, classifyAccess } = vi.hoisted(() => ({
  repositoryCommand: vi.fn(),
  classifyAccess: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- The release tool uses its real access flow and receipt checks with a controlled GitHub response.
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: () => ({ classify: classifyAccess }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the actual Build tool, approval policy and Eve state while supplying a local repository command outcome.
vi.mock("../repository/target-apply", async (original) => ({
  ...(await original<typeof targetApply>()),
  executeProposalBoundApply: repositoryCommand,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Retain the real projection in Eve without a hosted Postgres transport.
vi.mock("../testing/test-capability", () => ({
  hasTestCapability: (name: string) => name === "simulated-target",
}));
const repo = {
  defaultBranch: "main",
  headSha: "a".repeat(40),
  headTree: "b".repeat(40),
  name: "arrusted-development",
  owner: "withAutograph",
  repositoryId: "21",
};
const readyAccess: ReadyRepositoryAccess = {
  accessDigest: "e".repeat(64),
  status: "ready",
  repository: {
    ...repo,
    archived: false,
    repositoryVariableNames: [],
    visibility: "private",
  },
  scope: { accountLogin: repo.owner, accountType: "Organization", installationId: "31" },
};
const user = (subject = "creator") => ({
  attributes: {
    "mcp:audience": "https://builder.example/mcp",
    "mcp:scopes": ["sessions:write"],
    "mcp:workspace-id": "workspace",
  },
  authenticator: "mcp-oauth-jwks" as const,
  issuer: "https://builder.example/api/auth",
  principalId: subject,
  principalType: "user" as const,
  subject,
});
const context = (subject?: string): Pick<ToolContext, "session"> => ({
  session: {
    id: sessionId,
    auth: { current: user(subject), initiator: user(subject) },
    turn: { id: "turn", sequence: 1 },
  },
});

const installPlan = (
  storageKind: "none" | "kernel" = "kernel",
  evidence:
    | { phase: "planned" }
    | { phase: "applied"; appliedPaths: readonly string[] }
    | {
        phase: "validated";
        appliedPaths: readonly string[];
        appBackendKind: "generated-postgres" | "static";
      } = planned,
  sourceKind: "existing-repository" | "fresh-template" = "existing-repository",
) => {
  const observed =
    evidence.phase === "planned"
      ? evidence
      : {
          ...evidence,
          applyReceipt: { postTree: evidence.appliedPaths.map((path) => ({ path })) },
        };
  const workflow = {
    ...observed,
    appSpec: {
      appId,
      digest: specDigest,
      acceptedByCallId: "accept-fixture-app",
      artifactPath: "prototype/fixture-app/app-spec.md",
      artifactRevision: "f".repeat(64),
    },
    artifacts: [],
    dependencyReceipt: {},
    identityReceipt: { identity: { schemaCuePath: appliedCuePath } },
    sourceReceipt: { sourceKind, digest: "a".repeat(64) },
    proposal: {
      digest: proposalDigest,
      target: { contract: { appId }, plan: { source: { schema: { kind: storageKind } } } },
    },
    workspace: { workspaceId: buildWorkspaceId, workspaceDigest: "b".repeat(64) },
  };
  if (sourceKind === "existing-repository") {
    Object.assign(workflow, { githubSource: { repository: repo, resolvedRef: "refs/heads/main" } });
  }
  // SAFETY: Drafting and approval use the supplied scope and applied source paths.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- The fixture omits unrelated workflow receipts.
  const state = workflow as unknown as AppBuilderWorkflowState;
  appBuilderWorkflowState.update(() => state);
  repositoryAccessReceiptState.update((current) =>
    recordRepositoryAccessReceipt({
      current,
      sessionId,
      confirmedByCallId: "verified-access",
      access: readyAccess,
    }),
  );
};

const requiredSubject = (subject: ReturnType<typeof directProductionSubjectForPlan>) => {
  if (subject === undefined) {
    throw new Error("The fixture must have a verified Arrusted release subject.");
  }
  return subject;
};

const releaseContext = {
  ...context(),
  abortSignal: new AbortController().signal,
  approvedTools: new Set<string>(),
  callId: "release-app",
  toolName: "release-app-production",
  getSandbox: () => {
    throw new Error("A release decision cannot open the build sandbox.");
  },
  getToken: () => {
    throw new Error("A release decision cannot access provider credentials.");
  },
  requireAuth: () => {
    throw new Error("A release decision cannot open provider authorization.");
  },
} satisfies ToolContext & { approvedTools: ReadonlySet<string> };

const authoringDecision = () =>
  currentAuthoringDecision(releaseContext, {
    completed: true,
    blocked: false,
    pendingInput: false,
  });

const authoredReleaseApproval = () => {
  const policy = releaseAppProduction.approval;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow the authored Eve callback type.
  if (typeof policy !== "function") {
    throw new TypeError("Expected the release approval policy.");
  }
  return policy;
};

const buildToolInput = z.object({
  directProduction: directProductionSubjectSchema,
  implementationFiles: implementationFilesSchema,
});

const buildCallId = "original-build";
const buildTool = "apply_app_creation";
const originalBuildHarness = (input: z.infer<typeof buildToolInput>) => {
  const { approval, inputSchema } = applyAppCreation;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow the authored Eve callback type.
  if (typeof approval !== "function" || !(inputSchema instanceof z.ZodType)) {
    throw new TypeError("Expected the authored Build approval and input schema.");
  }
  const ctx = {
    ...releaseContext,
    callId: buildCallId,
    toolName: buildTool,
    getSandbox: vi.fn<() => Promise<never>>(),
  };
  let requested = false;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const first = !requested;
      requested = true;
      const stream: Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] =
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (first) {
              controller.enqueue({
                type: "tool-call",
                input: JSON.stringify(input),
                toolCallId: buildCallId,
                toolName: buildTool,
              });
            } else {
              controller.enqueue({ type: "text-start", id: "response" });
              controller.enqueue({ type: "text-delta", id: "response", delta: "Build reviewed." });
              controller.enqueue({ type: "text-end", id: "response" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: { raw: "stop", unified: first ? "tool-calls" : "stop" },
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
                outputTokens: { reasoning: 0, text: 1, total: 1 },
              },
            });
            controller.close();
          },
        });
      return await Promise.resolve({ stream });
    },
  });
  const tools: HarnessToolMap = new Map([
    [
      buildTool,
      {
        approval: async (approvalCtx) =>
          await approval({
            ...approvalCtx,
            toolInput: buildToolInput.parse(approvalCtx.toolInput),
          }),
        description: applyAppCreation.description,
        execute: async (value: z.infer<typeof buildToolInput>) =>
          await applyAppCreation.execute(value, ctx),
        inputSchema,
        name: buildTool,
      },
    ],
  ]);
  const events: MessageStreamEvent[] = [];
  const run = createToolLoopHarness({
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(stampMessageStreamEvent(event));
      await Promise.resolve();
    },
    resolveModel: async () => await Promise.resolve(model),
    tools,
  });
  const initial: HarnessSession = {
    agent: {
      modelReference: { id: "synthetic" },
      system: "Request the Build approval.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1_000_000 },
    continuationToken: "saved-turn",
    history: [],
    sessionId,
    state: {},
  };
  return { events, initial, run };
};

const markReviewed = () => {
  const state = appBuilderWorkflowState.get();
  if (state.phase !== "applied") {
    throw new Error("The approved Build did not apply in the controlled repository.");
  }
  // SAFETY: The fixture models the reviewed repository outcome. Production authority still uses the live Build receipt and workflow projection.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the validator and reviewer commands are outside this fixture.
  const reviewed = {
    ...state,
    phase: "reviewed",
    appBackendKind: "generated-postgres",
  } as Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
  updateExactWorkflow({
    expected: state,
    operation: "read test review outcome",
    transition: () => reviewed,
  });
};

describe("direct Production Build authority", () => {
  it.each([
    { repository: ARRUSTED_PRODUCTION_REPOSITORY },
    {
      repository: ARRUSTED_PRODUCTION_REPOSITORY,
      selectedInstallationId: readyAccess.scope.installationId,
    },
  ])("reads the verified existing Arrusted release for destination %j", async (destination) => {
    await contextStorage.run(new ContextContainer(), async () => {
      installPlan();
      classifyAccess.mockReset().mockResolvedValue(readyAccess);
      const accessBefore = repositoryAccessReceiptState.get();
      const subject = requiredSubject(directProductionSubjectForPlan(releaseContext));
      expect(currentPlannedDirectProductionAuthoring(releaseContext)).toBeUndefined();
      expect(authoringDecision().decision).toBe("planned");

      expect(await releaseAppProduction.execute({ destination }, releaseContext)).toMatchObject({
        status: "review-production-release",
        directProduction: subject,
      });
      expect(currentPlannedDirectProductionAuthoring(releaseContext)).toBe(proposalDigest);
      expect(authoringDecision().decision).toBe("runnable");
      expect(classifyAccess).not.toHaveBeenCalled();
      expect(repositoryAccessReceiptState.get()).toEqual(accessBefore);
      expect(currentDirectProductionGrant(releaseContext, subject)).toBeUndefined();
    });
  });

  it.each([
    { repository: "other/repository" },
    { repository: ARRUSTED_PRODUCTION_REPOSITORY, selectedInstallationId: "41" },
  ])("refuses to change the existing Arrusted release destination to %j", async (destination) => {
    await contextStorage.run(new ContextContainer(), async () => {
      installPlan();
      classifyAccess.mockReset().mockResolvedValue(readyAccess);
      const accessBefore = repositoryAccessReceiptState.get();

      expect(await releaseAppProduction.execute({ destination }, releaseContext)).toMatchObject({
        status: "managed-release-unavailable",
      });
      expect(classifyAccess).not.toHaveBeenCalled();
      expect(repositoryAccessReceiptState.get()).toEqual(accessBefore);
      expect(currentPlannedDirectProductionAuthoring(releaseContext)).toBeUndefined();
      expect(authoringDecision().decision).toBe("planned");
    });
  });

  it.each(["installation", "proposal"] as const)(
    "does not resume drafting after the verified %s changes",
    async (changed) => {
      await contextStorage.run(new ContextContainer(), async () => {
        installPlan();
        expect(await releaseAppProduction.execute({}, releaseContext)).toMatchObject({
          status: "review-production-release",
        });
        expect(currentPlannedDirectProductionAuthoring(releaseContext)).toBe(proposalDigest);
        if (changed === "installation") {
          repositoryAccessReceiptState.update((current) =>
            recordRepositoryAccessReceipt({
              current,
              sessionId,
              confirmedByCallId: "another-verified-installation",
              access: { ...readyAccess, scope: { ...readyAccess.scope, installationId: "41" } },
            }),
          );
        } else {
          const state = appBuilderWorkflowState.get();
          if (state.phase !== "planned") {
            throw new Error("The fixture must have a planned app.");
          }
          updateExactWorkflow({
            expected: state,
            operation: "plan a successor app proposal",
            transition: () => ({
              ...state,
              proposal: { ...state.proposal, digest: "e".repeat(64) },
            }),
          });
        }
        expect(currentPlannedDirectProductionAuthoring(releaseContext)).toBeUndefined();
        expect(authoringDecision().decision).toBe("planned");
      });
    },
  );

  it.each([
    { decision: "approve", sourceKind: "existing-repository" },
    { decision: "cancel", sourceKind: "existing-repository" },
    { decision: "approve", sourceKind: "fresh-template" },
  ] as const)(
    "honors the original Eve Build decision at protected Production setup ($decision, $sourceKind)",
    async ({ decision, sourceKind }) => {
      const container = new ContextContainer();
      const { session } = releaseContext;
      container.set(SessionKey, { auth: session.auth, sessionId, turn: session.turn });
      await contextStorage.run(container, async () => {
        installPlan("none", planned, sourceKind);
        classifyAccess.mockReset().mockResolvedValue(readyAccess);
        if (sourceKind === "fresh-template") {
          expect(await releaseAppProduction.execute({}, releaseContext)).toMatchObject({
            status: "production-destination-required",
          });
          expect(
            await releaseAppProduction.execute(
              {
                destination: { repository: "other/repository" },
              },
              releaseContext,
            ),
          ).toMatchObject({ status: "managed-release-unavailable" });
          expect(classifyAccess).not.toHaveBeenCalled();
        }
        repositoryCommand.mockReset().mockResolvedValue({
          ok: true,
          receipt: { changes: [], postTree: [{ path: appliedCuePath }] },
        });
        const preflight = await releaseAppProduction.execute(
          {
            storageKind: "postgres",
            destination: { repository: ARRUSTED_PRODUCTION_REPOSITORY },
          },
          releaseContext,
        );
        if (!("status" in preflight) || preflight.status !== "review-production-release") {
          throw new Error("The planned app must have a reviewable Arrusted release.");
        }
        expect(classifyAccess).toHaveBeenCalledTimes(sourceKind === "fresh-template" ? 1 : 0);
        expect(authoringDecision().decision).toBe("runnable");
        const subject = preflight.directProduction;
        const input = {
          directProduction: subject,
          implementationFiles: [{ ...cue, path: appliedCuePath }],
        };
        const { events, initial, run } = originalBuildHarness(input);
        const pending = await run(initial, {
          message: "Build and release this app to Arrusted Production.",
        });
        const requested = events.find((event) => event.type === "input.requested");
        const request = requested?.data.requests.find((value) => value.kind === "tool-approval");
        expect(request?.action).toMatchObject({ input, toolName: buildTool, callId: buildCallId });
        expect(repositoryCommand).not.toHaveBeenCalled();
        expect(currentDirectProductionGrant(releaseContext, subject)).toBeUndefined();
        expect(authoringDecision().decision).toBe("waiting-input");
        if (request === undefined) {
          throw new Error("The original Build must wait for an actual Eve approval.");
        }
        await run(pending.session, {
          inputResponses: [{ optionId: decision, requestId: request.requestId }],
        });
        expect(authoringDecision().decision).not.toBe("runnable");
        const requests = events.flatMap((event) =>
          event.type === "input.requested" ? event.data.requests : [],
        );
        expect(requests.filter((value) => value.kind === "tool-approval")).toHaveLength(1);
        const settlement = events.find((event) => event.type === "approval.settled");
        expect(settlement?.data).toMatchObject({
          requestId: request.requestId,
          responderPrincipalId: subject.authority.ownerUserId,
          outcome: decision === "approve" ? "approved" : "cancelled",
        });
        if (decision === "cancel") {
          const proofs = observePrivateApplyDenials({ calls: [buildCallId], events, sessionId });
          expect(proofs).toHaveLength(1);
          retainPrivateApplyDenials({ expected: readPrivateApplyAuthority(), proofs });
          expect(readPrivateApplyAuthority().pending).toHaveLength(0);
          expect(authoringDecision().decision).toBe("planned");
          await emitCurrentBuildWorkflowProjection(releaseContext);
          expect(diagnosticBuildDecisionState.get()?.directProduction).toBeUndefined();
          expect(repositoryCommand).not.toHaveBeenCalled();
          return;
        }
        expect(repositoryCommand).toHaveBeenCalledOnce();
        markReviewed();
        await emitCurrentBuildWorkflowProjection(releaseContext);
        const projected = diagnosticBuildDecisionState.get();
        if (projected === null || projected.directProduction === undefined) {
          throw new Error("The reviewed workflow must project the actual Build grant.");
        }
        const { directProduction: grant } = projected;
        expect(grant).toMatchObject({ callId: buildCallId, subject, toolName: buildTool });
        const owner = {
          kind: "direct" as const,
          authority: subject.authority,
          principal: { ...subject.authority, scopes: ["sessions:write"] },
          sessionId: "public-builder-session",
          adapterSessionId: sessionId,
          adapterGeneration: 1,
        };
        const plan = repositoryProductionApprovalInput(
          {
            authority: owner.authority,
            appId,
            repositoryId: repo.repositoryId,
            repositoryFullName: subject.repositoryFullName,
            projectId: "arrusted-project",
            organizationId: "dev",
            publicOrigin: "https://apps.example",
            environment: "production",
          },
          {
            sessionId: owner.sessionId,
            sourceSha: repo.headSha,
            creatorRoles: ["owner"],
            storage: {
              kind: "postgres",
              releaseId: "release",
              artifactRef: "compiled-release",
              manifestSha256: "b".repeat(64),
              databaseEnvironment: "APP_DATABASE_URL",
            },
          },
        );
        expect(
          await approvePrepareAppProduction({
            ...releaseContext,
            callId: "later-production-setup",
            toolName: "prepare-app-production",
            toolInput: repositoryProductionApprovalReference(plan),
          }),
        ).toBe("approved");
        const approval = {
          plan,
          grant,
          decision: projected,
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Exercise absent canonical destination before it is persisted.
          destination: undefined,
          logicalSessionId: sessionId,
          publishedDescription: true,
          owner,
        };
        if (sourceKind === "fresh-template") {
          expect(projected.existingRepositorySource).toBeUndefined();
          expect(() => {
            assertDirectRepositoryProductionApproval(approval);
          }).toThrow("repository_production_approval_required");
          const destination: ExistingRepositoryDestination = {
            kind: "existing-repository",
            version: 1,
            appId,
            repository: {
              repositoryId: repo.repositoryId,
              owner: repo.owner,
              name: repo.name,
              defaultBranch: repo.defaultBranch,
            },
            installationId: subject.installationId,
            confirmedByCallId: "review-verified-access",
          };
          assertDirectRepositoryProductionApproval({ ...approval, destination });
          expect(() => {
            assertDirectRepositoryProductionApproval({
              ...approval,
              destination: { ...destination, installationId: "999" },
            });
          }).toThrow("repository_production_approval_required");
          expect(appBuilderWorkflowState.get().phase).toBe("reviewed");
        } else {
          assertDirectRepositoryProductionApproval(approval);
        }
        await expect(
          readRepositoryProductionApproval({
            plan,
            callId: grant.callId,
            owner,
            directProduction: { grant, logicalSessionId: sessionId },
            assertOwner: async () => {},
            readHistory: async (start, observe) => {
              for (const event of events.slice(start)) {
                observe(event);
              }
              return await Promise.resolve({
                complete: true,
                nativeTailIndex: events.length,
                nextNativeIndex: events.length,
              });
            },
          }),
        ).resolves.toEqual({ approvalId: request.requestId, approvedByCallId: buildCallId });
      });
    },
  );

  it("keeps a pending Build private until its exact release is approved", () => {
    contextStorage.run(new ContextContainer(), () => {
      installPlan();
      const ctx = context();
      const subject = requiredSubject(directProductionSubjectForPlan(ctx));
      const input = {
        callId: "build",
        implementationFiles: [],
        toolName: "apply_app_creation" as const,
        subject,
      };
      expect(subject.storageKind).toBe("postgres");
      expect(() => recordDirectProductionGrant(ctx, input)).toThrow(
        "no matching Production approval",
      );
      expect(requestDirectProductionGrant(ctx, input)).toBe("user-approval");
      expect(currentDirectProductionGrant(ctx, subject)).toBeUndefined();
      const grant = recordDirectProductionGrant(ctx, input);
      expect(currentDirectProductionGrant(ctx, subject)).toEqual(grant);
      expect(requestDirectProductionGrant(ctx, { ...input, callId: "repair" })).toBe("approved");
      expect(currentDirectProductionGrant(context("other-creator"), subject)).toBeUndefined();
      expect(
        currentDirectProductionGrant(ctx, { ...subject, baseBranch: "wrong" }),
      ).toBeUndefined();

      installPlan("none");
      expect(currentDirectProductionGrant(ctx, subject)).toBeUndefined();
    });
  });

  it("does not let a stale or edited subject request a release", () => {
    contextStorage.run(new ContextContainer(), () => {
      installPlan();
      const ctx = context();
      const subject = requiredSubject(directProductionSubjectForPlan(ctx));
      expect(() =>
        requestDirectProductionGrant(ctx, {
          callId: "wrong-installation",
          toolName: "release-app-production",
          subject: { ...subject, installationId: "41" },
        }),
      ).toThrow("Review the current app and Arrusted destination");
      expect(currentDirectProductionGrant(ctx, subject)).toBeUndefined();
    });
  });

  it("uses the current Realm owner anchor while retaining the original logical session", () => {
    contextStorage.run(new ContextContainer(), () => {
      installPlan();
      const human = context();
      const subject = requiredSubject(directProductionSubjectForPlan(human));
      const input = {
        callId: "direct-build",
        implementationFiles: [],
        subject,
        toolName: "apply_app_creation" as const,
      };
      requestDirectProductionGrant(human, input);
      const grant = recordDirectProductionGrant(human, input);
      const ownerAnchorRunId = "recovered-owner-run";
      const environment = {
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
        EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
        EVE_HOSTED_VERCEL_TEAM_SLUG: "withautograph",
        VERCEL_ENV: "preview",
      };
      const config = { tokenKey: Buffer.alloc(32, 7), tokenKeyVersion: "fixture-v1" };
      const service = readRealmContinuationServiceIdentity(environment);
      const initiator = user();
      const auth = createRealmContinuationServiceAuth({
        config,
        service,
        initiator,
        claim: mintRealmContinuationAuthority({
          config,
          service,
          observed: {
            adapterSessionId: ownerAnchorRunId,
            appId,
            approvedPlanDigest: proposalDigest,
            authority: subject.authority,
            initiator,
            nonceSha256: "b".repeat(64),
            operationRef: "123e4567-e89b-42d3-a456-426614174002",
            ownerSessionId: "public-builder-session",
            reason: { kind: "expired-technical-wait", expiresAt: "2026-10-01T00:00:00.000Z" },
          },
        }),
      });
      try {
        for (const [key, value] of Object.entries(environment)) {
          vi.stubEnv(key, value);
        }
        vi.stubEnv("VERCEL_INTEGRATION_TOKEN_KEY", config.tokenKey.toString("base64"));
        vi.stubEnv("VERCEL_INTEGRATION_TOKEN_KEY_VERSION", config.tokenKeyVersion);
        vi.stubEnv("VERCEL_INTEGRATION_TOKEN_PREVIOUS_KEYS", "");
        const session = { ...human.session, auth, ownerAnchorRunId };
        expect(currentDirectProductionGrant({ session }, subject)).toEqual(grant);
        expect(() =>
          currentDirectProductionGrant(
            { session: { ...session, ownerAnchorRunId: "another-owner-run" } },
            subject,
          ),
        ).toThrow("Hosted session authority is invalid");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  it("uses the read-only planned hint only when the Build really supplies the exact scaffold CUE", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      installPlan("none");
      const hint = { storageKind: "postgres" as const };
      const approval = authoredReleaseApproval();
      expect(await approval({ ...releaseContext, toolInput: hint })).toBe("not-applicable");
      const preview = await releaseAppProduction.execute(hint, releaseContext);
      if (!("status" in preview) || preview.status !== "review-production-release") {
        throw new Error("Expected the read-only release summary.");
      }
      const { directProduction: subject } = preview;
      expect(subject.storageKind).toBe("postgres");
      expect(directProductionSubjectForPlan(releaseContext)?.storageKind).toBe("none");
      const input = {
        callId: "build",
        implementationFiles: [cue],
        toolName: "apply_app_creation" as const,
        subject,
      };
      expect(() =>
        requestDirectProductionGrant(releaseContext, {
          ...input,
          implementationFiles: [{ ...cue, path: `${cuePath}.bak` }],
        }),
      ).toThrow("Review the current app and Arrusted destination");
      expect(requestDirectProductionGrant(releaseContext, input)).toBe("user-approval");
      expect(directProductionSubjectForPlan(releaseContext)?.storageKind).toBe("none");
      expect(() =>
        recordDirectProductionGrant(releaseContext, { ...input, implementationFiles: [] }),
      ).toThrow("changed after the Production approval");
      const grant = recordDirectProductionGrant(releaseContext, input);
      stageImplementationFiles({ appSpecDigest: specDigest, files: [cue], proposalDigest });
      expect(currentDirectProductionGrant(releaseContext, subject)).toEqual(grant);
      expect(
        requestDirectProductionGrant(releaseContext, {
          ...input,
          callId: "repair",
          implementationFiles: [],
        }),
      ).toBe("approved");
      expect(() =>
        requestDirectProductionGrant(releaseContext, {
          ...input,
          callId: "remove-cue",
          implementationFiles: [{ operation: "delete", path: cuePath }],
        }),
      ).toThrow("Review the current app and Arrusted destination");
    });
  });

  it.each([
    { phase: "applied", appliedPaths: [appliedCuePath] },
    { phase: "validated", appliedPaths: [], appBackendKind: "generated-postgres" },
  ] as const)("releases an existing private $phase app without another Build", async (evidence) => {
    await contextStorage.run(new ContextContainer(), async () => {
      installPlan("none", evidence);
      const scope = {
        appId,
        appSpecDigest: specDigest,
        proposalDigest,
        sessionId,
        workspaceId: buildWorkspaceId,
      };
      requestPrivateApplyApproval(scope, "old-private-build");
      recordApprovedPrivateApply(scope, "old-private-build");
      const subject = requiredSubject(directProductionSubjectForPlan(releaseContext));
      expect(subject.storageKind).toBe("postgres");
      const toolInput = { directProduction: subject };
      expect(currentDirectProductionGrant(releaseContext, subject)).toBeUndefined();
      expect(
        await releaseAppProduction.execute({ storageKind: "none" }, releaseContext),
      ).toMatchObject({ directProduction: subject });
      await expect(releaseAppProduction.execute(toolInput, releaseContext)).rejects.toThrow(
        "no matching Production approval",
      );
      expect(await authoredReleaseApproval()({ ...releaseContext, toolInput })).toBe(
        "user-approval",
      );
      expect(currentDirectProductionGrant(releaseContext, subject)).toBeUndefined();
      expect(await releaseAppProduction.execute(toolInput, releaseContext)).toEqual({
        status: "production-release-approved",
      });
      expect(currentDirectProductionGrant(releaseContext, subject)).toMatchObject({
        toolName: "release-app-production",
        subject,
      });
    });
  });
});
