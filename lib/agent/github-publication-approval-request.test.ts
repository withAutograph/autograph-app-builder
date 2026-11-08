/* oxlint-disable anti-slop/no-module-mocking -- Replace only saved workflow and repository/provider ports; the installed Eve approval path and publication checks remain real. */
/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the pinned installed Eve tool-loop approval boundary rather than an imitation approval gate. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { assertCurrentGitHubDraftProposal as ActualAssertCurrentGitHubDraftProposal } from "./workflow-state";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { createToolLoopHarness } from "../../node_modules/eve/dist/src/harness/tool-loop.js";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { SessionKey } from "../../node_modules/eve/dist/src/context/keys.js";
import type {
  HarnessSession,
  HarnessToolMap,
  StepInput,
} from "../../node_modules/eve/dist/src/harness/types.js";
import type { UnstampedMessageStreamEvent } from "../../node_modules/eve/dist/src/protocol/message.js";
import sealTool from "../../agent/tools/seal_github_draft_pr_proposal";
import publishTool from "../../agent/tools/publish_github_draft_pr";
import statusTool from "../../agent/tools/artifact_workflow_status";
import { approvalReceiptForDraftProposal, approvalReceiptSchema } from "./approval-receipt";

const fixture = vi.hoisted(() => {
  const proposal = {
    digest: "a".repeat(64),
    reviewDigest: "b".repeat(64),
    changeSetDigest: "c".repeat(64),
    repositoryId: "1234",
    owner: "fixture-team",
    name: "fixture-apps",
    baseBranch: "main",
    baseSha: "d".repeat(40),
    baseTree: "8".repeat(40),
  };
  const initial = () => ({
    phase: "reviewed",
    workspace: {},
    artifacts: [
      {
        appId: "requests",
        content: "Saved app requirements",
        digest: "5".repeat(64),
        mediaType: "text/markdown",
        path: "prototype/requests/app-spec.md",
        revision: "6".repeat(64),
        sessionId: "saved-builder-session",
        recordedByCallId: "spec",
      },
    ],
    appSpec: {
      appId: "requests",
      digest: "e".repeat(64),
      artifactPath: "prototype/requests/app-spec.md",
      artifactRevision: "6".repeat(64),
    },
    dependencyReceipt: { digest: "1".repeat(64) },
    identityReceipt: { digest: "2".repeat(64) },
    proposal: { digest: "3".repeat(64) },
    validationReceipt: { digest: "4".repeat(64), status: "succeeded" },
    appBackendKind: "static",
    githubSource: {
      digest: "f".repeat(64),
      repository: {
        repositoryId: proposal.repositoryId,
        owner: proposal.owner,
        name: proposal.name,
        defaultBranch: proposal.baseBranch,
      },
    },
    sourceReceipt: { sourceKind: "existing-repository", digest: "0".repeat(64) },
    applyReceipt: { applyRoot: "/workspace/repository" },
    reviewReceipt: { digest: proposal.reviewDigest, changeSetDigest: proposal.changeSetDigest },
    githubDestinationReview: {
      digest: "7".repeat(64),
      repository: {
        repositoryId: proposal.repositoryId,
        owner: proposal.owner,
        name: proposal.name,
        defaultBranch: proposal.baseBranch,
        headSha: proposal.baseSha,
        headTree: proposal.baseTree,
      },
    },
    githubDraftProposal: {
      proposal,
      sourceReceiptDigest: "0".repeat(64),
      githubSourceDigest: "f".repeat(64),
    },
  });
  return { proposal, initial, state: initial(), seal: vi.fn(), publish: vi.fn() };
});
vi.mock("./workflow-state", async (importOriginal) => ({
  ...(await importOriginal<{
    assertCurrentGitHubDraftProposal: typeof ActualAssertCurrentGitHubDraftProposal;
  }>()),
  appBuilderWorkflowState: { get: () => fixture.state },
  updateExactWorkflow: ({
    transition,
  }: {
    transition: (value: typeof fixture.state) => typeof fixture.state;
  }) => {
    fixture.state = transition(fixture.state);
  },
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: () =>
    Promise.resolve({
      sealDraftPullRequestProposal: fixture.seal,
      publishDraftPullRequest: fixture.publish,
    }),
}));
vi.mock("./app-baseline-state", () => ({ appBaselineState: { get: () => null } }));
vi.mock("../repository/reviewed-change-set", () => ({ assertExistingAppReviewScope: () => {} }));
vi.mock("../repository/source-receipt", () => ({ sourceReceiptEvidence: () => ({}) }));
vi.mock("../../agent/tools/change_set_status", () => ({
  exactNormalizedChangeSet: () => Promise.resolve({ digest: fixture.proposal.changeSetDigest }),
}));
vi.mock("./github-publication-content-source", () => ({
  publicationContentSourceForReviewedWorkflow: () => Promise.resolve({}),
}));
vi.mock("./published-app-source", () => ({
  recordPublishedAppSourceForSession: () => Promise.resolve({ status: "recorded" }),
}));

const context = {
  callId: "publish-reviewed-proposal",
  session: { id: "saved-builder-session", auth: {} },
  getSandbox: vi.fn(() => Promise.resolve({})),
};
// SAFETY: Only the trusted saved-session identity and provider-free sandbox port are consumed by these authored tools.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The runtime context has unrelated members outside this publication fixture.
const toolContext = context as never;

type PublicationInput = Parameters<typeof publishTool.execute>[0];
const setup = (input: PublicationInput) => {
  const inputSchema = publishTool.inputSchema;
  const approval = publishTool.approval;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow the installed SDK's function-or-configuration callback API, not external input.
  if (typeof approval !== "function") {
    throw new TypeError("Expected the authored native approval policy");
  }
  if (!(inputSchema instanceof z.ZodType)) {
    throw new Error("Expected the authored publication input schema");
  }
  let requested = false;
  const events: UnstampedMessageStreamEvent[] = [];
  const model = new MockLanguageModelV4({
    doStream: () => {
      const requestedNow = !requested;
      requested = true;
      const stream: Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] =
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (requestedNow) {
              controller.enqueue({
                type: "tool-call",
                toolCallId: context.callId,
                toolName: "publish_github_draft_pr",
                input: JSON.stringify(input),
              });
            } else {
              controller.enqueue({ type: "text-start", id: "reply" });
              controller.enqueue({
                type: "text-delta",
                id: "reply",
                delta: "Publication response received.",
              });
              controller.enqueue({ type: "text-end", id: "reply" });
            }
            controller.enqueue({
              type: "finish",
              finishReason: { unified: requestedNow ? "tool-calls" : "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 5, text: 5, reasoning: 0 },
              },
            });
            controller.close();
          },
        });
      return Promise.resolve({ stream });
    },
  });
  const tools: HarnessToolMap = new Map([
    [
      "publish_github_draft_pr",
      {
        name: "publish_github_draft_pr",
        description: publishTool.description,
        inputSchema,
        approval: (approvalContext) =>
          approval({
            ...approvalContext,
            toolInput: z
              .object({
                approvalReceipt: approvalReceiptSchema,
                expectedProposalDigest: z.string(),
              })
              .parse(approvalContext.toolInput),
          }),
        execute: (value: PublicationInput) => publishTool.execute(value, toolContext),
      },
    ],
  ]);
  const run = createToolLoopHarness({
    tools,
    capabilities: { requestInput: true },
    resolveModel: () => Promise.resolve(model),
    handleEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
  });
  const container = new ContextContainer();
  container.set(SessionKey, {
    sessionId: context.session.id,
    turn: { id: "publication-turn", sequence: 1 },
    auth: { current: null, initiator: null },
  });
  const initial: HarnessSession = {
    sessionId: context.session.id,
    continuationToken: "same-saved-turn",
    agent: {
      system: "Request approval for the reviewed publication.",
      tools: [],
      modelReference: { id: "synthetic" },
    },
    compaction: { recentWindowSize: 10, threshold: 1_000_000 },
    state: {},
    history: [],
  };
  return {
    events,
    initial,
    run: (session: HarnessSession, value?: StepInput) =>
      contextStorage.run(container, () => run(session, value)),
  };
};

beforeEach(() => {
  fixture.state = fixture.initial();
  context.getSandbox.mockClear();
  fixture.seal.mockReset().mockResolvedValue(fixture.proposal);
  fixture.publish
    .mockReset()
    .mockResolvedValue({ kind: "draft-pull-request", repositoryId: "1234" });
});

describe("native draft publication approval", () => {
  it.each(["approve", "cancel", "moved-proposal"] as const)(
    "requests consent before publication and handles %s",
    async (decision) => {
      const proposal = z
        .object({ digest: z.string(), approvalReceipt: approvalReceiptSchema })
        .parse(
          await sealTool.execute(
            {
              expectedGitHubSourceDigest: "f".repeat(64),
              expectedReviewDigest: fixture.proposal.reviewDigest,
              title: "Add Requests",
            },
            toolContext,
          ),
        );
      expect(proposal.approvalReceipt).toEqual(approvalReceiptForDraftProposal(fixture.proposal));
      expect(fixture.publish).not.toHaveBeenCalled();
      const input = {
        expectedProposalDigest: proposal.digest,
        approvalReceipt: proposal.approvalReceipt,
      };
      const h = setup(input);
      const pending = await h.run(h.initial, { message: "Publish the reviewed app." });
      const event = h.events.find((value) => value.type === "input.requested");
      const request = event?.data.requests.find((value) => value.kind === "tool-approval");
      expect(request?.action).toMatchObject({ toolName: "publish_github_draft_pr", input });
      expect(fixture.publish).not.toHaveBeenCalled();
      if (!request) {
        throw new Error("Expected the ordinary native approval request");
      }
      if (decision === "moved-proposal") {
        fixture.state.githubDraftProposal.proposal = {
          ...fixture.proposal,
          digest: "9".repeat(64),
        };
      }
      await h.run(pending.session, {
        inputResponses: [
          { requestId: request.requestId, optionId: decision === "cancel" ? "cancel" : "approve" },
        ],
      });
      if (decision === "approve") {
        expect(fixture.publish).toHaveBeenCalledTimes(1);
        expect(fixture.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            approvalReceipt: proposal.approvalReceipt,
            expectedProposalDigest: proposal.digest,
          }),
        );
      } else {
        expect(fixture.publish).not.toHaveBeenCalled();
      }
    },
  );
});

const useFreshDestination = () => {
  fixture.state.sourceReceipt.sourceKind = "fresh-template";
  Reflect.deleteProperty(fixture.state, "githubSource");
  Reflect.deleteProperty(fixture.state.githubDraftProposal, "githubSourceDigest");
  Object.assign(fixture.state.githubDraftProposal, {
    destinationReviewDigest: fixture.state.githubDestinationReview.digest,
  });
};

describe("retained draft publication subject recovery", () => {
  it.each(["legacy", "current"] as const)(
    "restores %s sealed publication input without another seal or implied consent",
    async (kind) => {
      const sealed =
        kind === "current"
          ? z.object({ approvalReceipt: approvalReceiptSchema }).parse(
              await sealTool.execute(
                {
                  expectedGitHubSourceDigest: fixture.state.githubSource.digest,
                  expectedReviewDigest: fixture.state.reviewReceipt.digest,
                  title: "Add Requests",
                },
                toolContext,
              ),
            )
          : undefined;
      fixture.seal.mockClear();
      context.getSandbox.mockClear();
      const saved = structuredClone(fixture.state);
      const recovered = z
        .object({
          githubDraftPublication: z.object({
            nextCall: z.object({
              tool: z.literal("publish_github_draft_pr"),
              arguments: z.object({
                approvalReceipt: approvalReceiptSchema,
                expectedProposalDigest: z.string(),
              }),
            }),
          }),
        })
        .parse(statusTool.execute({}, toolContext));
      const { nextCall } = recovered.githubDraftPublication;
      expect(nextCall.arguments).toEqual({
        approvalReceipt: approvalReceiptForDraftProposal(fixture.proposal),
        expectedProposalDigest: fixture.proposal.digest,
      });
      if (sealed) {
        expect(nextCall.arguments.approvalReceipt).toEqual(sealed.approvalReceipt);
      }
      expect(fixture.state).toEqual(saved);
      expect(fixture.state.githubDraftProposal).not.toHaveProperty("approvalReceipt");
      expect(fixture.seal).not.toHaveBeenCalled();
      expect(context.getSandbox).not.toHaveBeenCalled();
      expect(fixture.publish).not.toHaveBeenCalled();
      const h = setup(nextCall.arguments);
      await h.run(h.initial, { message: "Publish the reviewed app." });
      const event = h.events.find((value) => value.type === "input.requested");
      const request = event?.data.requests.find((value) => value.kind === "tool-approval");
      expect(request?.action).toMatchObject({ toolName: nextCall.tool, input: nextCall.arguments });
      expect(fixture.publish).not.toHaveBeenCalled();
    },
  );

  it("does not invent publication input before a draft proposal has been sealed", () => {
    Reflect.deleteProperty(fixture.state, "githubDraftProposal");
    expect(statusTool.execute({}, toolContext)).not.toHaveProperty("githubDraftPublication");
    expect(fixture.seal).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(context.getSandbox).not.toHaveBeenCalled();
  });

  it("retains the exact fresh-template destination without acquiring another source", () => {
    useFreshDestination();
    const recovered = statusTool.execute({}, toolContext);
    expect(recovered).toHaveProperty(
      "githubDraftPublication.nextCall.arguments.approvalReceipt.repository",
      `${fixture.proposal.owner}/${fixture.proposal.name}`,
    );
    expect(fixture.seal).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(context.getSandbox).not.toHaveBeenCalled();
  });

  it.each(["destination-review", "base-commit", "base-tree"] as const)(
    "does not expose publication input after a moved fresh-template %s binding",
    (binding) => {
      useFreshDestination();
      if (binding === "destination-review") {
        fixture.state.githubDestinationReview.digest = "9".repeat(64);
      } else if (binding === "base-commit") {
        fixture.state.githubDestinationReview.repository.headSha = "9".repeat(40);
      } else {
        fixture.state.githubDestinationReview.repository.headTree = "9".repeat(40);
      }
      const recovered = statusTool.execute({}, toolContext);
      expect(recovered).not.toHaveProperty("githubDraftPublication");
      expect(recovered).toMatchObject({
        phase: "reviewed",
        sessionId: context.session.id,
        appSpec: { digest: fixture.state.appSpec.digest },
        review: { digest: fixture.state.reviewReceipt.digest },
      });
      expect(fixture.publish).not.toHaveBeenCalled();
      expect(fixture.seal).not.toHaveBeenCalled();
      expect(context.getSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(["review", "diff", "source", "github-source", "repository"] as const)(
    "does not expose publication input after a moved %s binding",
    (binding) => {
      switch (binding) {
        case "review": {
          fixture.state.reviewReceipt.digest = "9".repeat(64);
          break;
        }
        case "diff": {
          fixture.state.reviewReceipt.changeSetDigest = "9".repeat(64);
          break;
        }
        case "source": {
          fixture.state.sourceReceipt.digest = "9".repeat(64);
          break;
        }
        case "github-source": {
          fixture.state.githubSource.digest = "9".repeat(64);
          break;
        }
        case "repository": {
          fixture.state.githubSource.repository.repositoryId = "9999";
          break;
        }
        default: {
          throw new Error("Unsupported moved binding");
        }
      }
      const recovered = statusTool.execute({}, toolContext);
      expect(recovered).not.toHaveProperty("githubDraftPublication");
      expect(recovered).toMatchObject({
        phase: "reviewed",
        sessionId: context.session.id,
        appSpec: { digest: fixture.state.appSpec.digest },
        review: {
          digest: fixture.state.reviewReceipt.digest,
          changeSetDigest: fixture.state.reviewReceipt.changeSetDigest,
        },
      });
      expect(fixture.publish).not.toHaveBeenCalled();
      expect(fixture.seal).not.toHaveBeenCalled();
      expect(context.getSandbox).not.toHaveBeenCalled();
    },
  );
  it("still rejects another session's artifacts before projecting status", () => {
    fixture.state.artifacts[0].sessionId = "another-builder-session";
    expect(() => statusTool.execute({}, toolContext)).toThrow("different session");
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.seal).not.toHaveBeenCalled();
    expect(context.getSandbox).not.toHaveBeenCalled();
  });

  it("does not suppress malformed canonical receipt errors as a stale binding", () => {
    fixture.state.githubDraftProposal.proposal = {
      ...fixture.proposal,
      baseSha: "invalid-base-commit",
    };
    expect(() => statusTool.execute({}, toolContext)).toThrow();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.seal).not.toHaveBeenCalled();
    expect(context.getSandbox).not.toHaveBeenCalled();
  });
});
