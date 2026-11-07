/* oxlint-disable anti-slop/no-module-mocking -- Replace only saved workflow and repository/provider ports; the installed Eve approval path and publication checks remain real. */
/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the pinned installed Eve tool-loop approval boundary rather than an imitation approval gate. */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  };
  const initial = () => ({
    phase: "reviewed",
    appSpec: { appId: "requests", digest: "e".repeat(64) },
    appBackendKind: "static",
    githubSource: { digest: "f".repeat(64) },
    sourceReceipt: { sourceKind: "existing-repository", digest: "0".repeat(64) },
    applyReceipt: { applyRoot: "/workspace/repository" },
    reviewReceipt: { digest: proposal.reviewDigest, changeSetDigest: proposal.changeSetDigest },
    githubDestinationReview: { repository: { repositoryId: proposal.repositoryId } },
    githubDraftProposal: { proposal },
  });
  return { proposal, initial, state: initial(), seal: vi.fn(), publish: vi.fn() };
});
vi.mock("./workflow-state", () => ({
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
  getSandbox: () => Promise.resolve({}),
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
