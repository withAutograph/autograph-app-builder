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
      installation: { installationId: "10" },
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
  return {
    proposal,
    initial,
    state: initial(),
    seal: vi.fn(),
    publish: vi.fn(),
    readPublished: vi.fn(),
    recordSource: vi.fn(),
    readGrant: vi.fn(),
  };
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
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  githubPublicationRuntimeForSession: () =>
    Promise.resolve({
      publishDraftPullRequest: fixture.publish,
      readSucceededDraftPublication: fixture.readPublished,
      sealDraftPullRequestProposal: fixture.seal,
    }),
}));
vi.mock("./direct-production-state", () => ({ currentDirectProductionGrant: fixture.readGrant }));
vi.mock("./app-baseline-state", () => ({ appBaselineState: { get: () => null } }));
vi.mock("../repository/reviewed-change-set", () => ({ assertExistingAppReviewScope: () => {} }));
vi.mock("../repository/source-receipt", () => ({ sourceReceiptEvidence: () => ({}) }));
vi.mock("../../agent/tools/change_set_status", () => ({
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  exactNormalizedChangeSet: () => Promise.resolve({ digest: fixture.proposal.changeSetDigest }),
}));
vi.mock("./github-publication-content-source", () => ({
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  publicationContentSourceForReviewedWorkflow: () => Promise.resolve({}),
}));
vi.mock("./published-app-source", () => ({
  recordPublishedAppSourceForSession: fixture.recordSource,
}));

const context = {
  callId: "publish-reviewed-proposal",
  session: { id: "saved-builder-session", auth: {} },
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
  getSandbox: vi.fn(() => Promise.resolve({})),
};
// SAFETY: Only the trusted saved-session identity and provider-free sandbox port are consumed by these authored tools.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The runtime context has unrelated members outside this publication fixture.
const toolContext = context as never;
const sealInSession = async (input: Parameters<typeof sealTool.execute>[0]) =>
  await contextStorage.run(
    new ContextContainer(),
    async () => await sealTool.execute(input, toolContext),
  );

type PublicationInput = Parameters<typeof publishTool.execute>[0];
const publicationInputFixture = z.object({
  approvalReceipt: approvalReceiptSchema,
  expectedProposalDigest: z.string(),
  recoverAppliedPublication: z.literal(true).optional(),
});
const setup = (input: PublicationInput) => {
  const { inputSchema } = publishTool;
  const { approval } = publishTool;
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
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    doStream: () => {
      const requestedNow = !requested;
      requested = true;
      const stream: Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] =
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            if (requestedNow) {
              controller.enqueue({
                input: JSON.stringify(input),
                toolCallId: context.callId,
                toolName: "publish_github_draft_pr",
                type: "tool-call",
              });
            } else {
              controller.enqueue({ id: "reply", type: "text-start" });
              controller.enqueue({
                delta: "Publication response received.",
                id: "reply",
                type: "text-delta",
              });
              controller.enqueue({ id: "reply", type: "text-end" });
            }
            controller.enqueue({
              finishReason: { raw: "stop", unified: requestedNow ? "tool-calls" : "stop" },
              type: "finish",
              usage: {
                inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
                outputTokens: { reasoning: 0, text: 5, total: 5 },
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
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
        approval: (approvalContext) =>
          approval({
            ...approvalContext,
            toolInput: publicationInputFixture.parse(approvalContext.toolInput),
          }),
        description: publishTool.description,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
        execute: (value: PublicationInput) => publishTool.execute(value, toolContext),
        inputSchema,
        name: "publish_github_draft_pr",
      },
    ],
  ]);
  const run = createToolLoopHarness({
    capabilities: { requestInput: true },
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    handleEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    resolveModel: () => Promise.resolve(model),
    tools,
  });
  const container = new ContextContainer();
  container.set(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: context.session.id,
    turn: { id: "publication-turn", sequence: 1 },
  });
  const initial: HarnessSession = {
    agent: {
      modelReference: { id: "synthetic" },
      system: "Request approval for the reviewed publication.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 1_000_000 },
    continuationToken: "same-saved-turn",
    history: [],
    sessionId: context.session.id,
    state: {},
  };
  return {
    events,
    initial,
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    run: (session: HarnessSession, value?: StepInput) =>
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      contextStorage.run(container, () => run(session, value)),
  };
};

beforeEach(() => {
  fixture.state = fixture.initial();
  context.getSandbox.mockClear();
  fixture.readGrant.mockReset();
  fixture.readPublished.mockReset();
  fixture.recordSource.mockReset().mockResolvedValue({ status: "recorded" });
  fixture.seal.mockReset().mockResolvedValue(fixture.proposal);
  fixture.publish
    .mockReset()
    .mockResolvedValue({ kind: "draft-pull-request", repositoryId: "1234" });
});

describe("native draft publication approval", () => {
  it("retries only source association after the reviewed GitHub publication succeeded", async () => {
    fixture.readGrant.mockReturnValue({ digest: "9".repeat(64) });
    const input = {
      expectedProposalDigest: fixture.proposal.digest,
      approvalReceipt: approvalReceiptForDraftProposal(fixture.proposal),
    };
    const publication = {
      status: "succeeded",
      proposalDigest: input.expectedProposalDigest,
      repositoryId: fixture.proposal.repositoryId,
    };
    fixture.publish.mockResolvedValue(publication);
    fixture.recordSource.mockRejectedValueOnce(new Error("source storage unavailable"));
    fixture.readPublished.mockResolvedValue(publication);
    const first = setup(input);
    await first.run(first.initial, { message: "Publish the reviewed app." });
    const firstResult = first.events.find((event) => event.type === "action.result")?.data.result;
    const output = z
      .object({
        status: z.literal("succeeded"),
        appSourceRecording: z.object({ status: z.literal("unavailable") }),
        nextCall: z.object({ input: publicationInputFixture }),
      })
      .parse(firstResult?.kind === "tool-result" ? firstResult.output : null);
    expect(output.nextCall.input.recoverAppliedPublication).toBe(true);
    expect(fixture.publish).toHaveBeenCalledOnce();

    fixture.readGrant.mockReset();
    const resumed = setup(output.nextCall.input);
    await resumed.run(resumed.initial, { message: "Continue the same publication." });
    expect(resumed.events.some((event) => event.type === "input.requested")).toBe(false);
    const observed = resumed.events.find((event) => event.type === "action.result")?.data.result;
    expect(observed).toMatchObject({
      output: {
        status: "succeeded",
        appSourceRecording: { status: "recorded" },
        nextCall: { tool: "read_github_pr_delivery", input: {} },
      },
    });
    expect(fixture.readPublished).toHaveBeenCalledExactlyOnceWith(input.expectedProposalDigest);
    expect(fixture.publish).toHaveBeenCalledOnce();
    expect(context.getSandbox).toHaveBeenCalledOnce();
  });

  it("does not dispatch or associate an unconfirmed Git write in source recovery mode", async () => {
    fixture.readPublished.mockRejectedValue(new Error("No successful journal receipt"));
    const harness = setup({
      expectedProposalDigest: fixture.proposal.digest,
      approvalReceipt: approvalReceiptForDraftProposal(fixture.proposal),
      recoverAppliedPublication: true,
    });
    await harness.run(harness.initial, { message: "Check the previous publication." });
    expect(
      harness.events.find((event) => event.type === "action.result")?.data.result,
    ).toMatchObject({ isError: true });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.recordSource).not.toHaveBeenCalled();
    expect(context.getSandbox).not.toHaveBeenCalled();
  });

  it("uses the current Production approval for the exact reviewed draft without opening another approval", async () => {
    fixture.readGrant.mockReturnValue({ digest: "9".repeat(64) });
    fixture.publish.mockResolvedValue({
      status: "succeeded",
      proposalDigest: fixture.proposal.digest,
      repositoryId: fixture.proposal.repositoryId,
    });
    const input = {
      expectedProposalDigest: fixture.proposal.digest,
      approvalReceipt: approvalReceiptForDraftProposal(fixture.proposal),
    };
    const harness = setup(input);
    await harness.run(harness.initial, { message: "Publish the reviewed app." });
    expect(harness.events.some((event) => event.type === "input.requested")).toBe(false);
    const publication = harness.events.find((event) => event.type === "action.result");
    expect(publication?.data.result).toMatchObject({
      output: { nextCall: { tool: "read_github_pr_delivery", input: {} } },
    });
    expect(fixture.readGrant).toHaveBeenCalledWith(expect.anything(), {
      appId: "requests",
      baseBranch: "main",
      installationId: "10",
      repositoryFullName: "fixture-team/fixture-apps",
      repositoryId: "1234",
    });
    expect(fixture.publish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        approvalReceipt: input.approvalReceipt,
        approvedByCallId: context.callId,
        expectedProposalDigest: input.expectedProposalDigest,
      }),
    );
    expect(
      z.object({ assertEffectCurrent: z.function() }).safeParse(fixture.publish.mock.calls[0]?.[0])
        .success,
    ).toBe(true);
  });

  it("stops a delegated publication when the release approval changes before provider dispatch", async () => {
    fixture.readGrant.mockReturnValue({ digest: "9".repeat(64) });
    context.getSandbox.mockImplementationOnce(async () => {
      fixture.readGrant.mockReset();
      return await Promise.resolve({});
    });
    const harness = setup({
      expectedProposalDigest: fixture.proposal.digest,
      approvalReceipt: approvalReceiptForDraftProposal(fixture.proposal),
    });
    await harness.run(harness.initial, { message: "Publish the reviewed app." });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(
      harness.events.some(
        (event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.isError === true,
      ),
    ).toBe(true);
  });

  it.each(["approve", "cancel", "moved-proposal"] as const)(
    "requests consent before publication and handles %s",
    async (decision) => {
      const proposal = z
        .object({ approvalReceipt: approvalReceiptSchema, digest: z.string() })
        .parse(
          await sealInSession({
            reviewReference: {
              kind: "current-session-reviewed-change-set",
              sessionId: context.session.id,
              digest: fixture.proposal.reviewDigest,
            },
            title: "Add Requests",
          }),
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
      expect(request?.action).toMatchObject({ input, toolName: "publish_github_draft_pr" });
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
          { optionId: decision === "cancel" ? "cancel" : "approve", requestId: request.requestId },
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
              await sealInSession({
                expectedGitHubSourceDigest: fixture.state.githubSource.digest,
                expectedReviewDigest: fixture.state.reviewReceipt.digest,
                title: "Add Requests",
              }),
            )
          : undefined;
      fixture.seal.mockClear();
      context.getSandbox.mockClear();
      fixture.readGrant.mockReset();
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
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
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
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    expect(() => statusTool.execute({}, toolContext)).toThrow();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.seal).not.toHaveBeenCalled();
    expect(context.getSandbox).not.toHaveBeenCalled();
  });
});
