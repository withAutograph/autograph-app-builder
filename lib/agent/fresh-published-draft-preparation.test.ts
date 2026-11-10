/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Only external provider and Eve-state boundaries are controlled; the real preparation and source resolver run. */
/* oxlint-disable eslint/require-await -- External provider boundaries use the production async signatures. */
import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { appBuilderWorkflowState, invalidateGitHubDestinationReview } from "./workflow-state";
import type {
  AppBuilderWorkflowState,
  assertCurrentGitHubDraftProposal,
  assertExactWorkflowState,
} from "./workflow-state";
import type {
  RepositoryAccessReceipt,
  repositoryAccessReceiptSchema,
} from "./repository-access-state";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePublishedDraftReconciliation } from "./prepare-published-draft-repair";
import prepareDraftReconciliationTool from "../../agent/tools/prepare_github_draft_pr_reconciliation";
import sealDraftReconciliationTool from "../../agent/tools/seal_github_draft_pr_reconciliation";
import { createChangeSetAcceptanceTool } from "../../agent/tools/accept_change_set";
import { createAppValidationTool } from "../../agent/tools/validate_app_creation";
import { executeProposalBoundValidation } from "../repository/target-validation";
// oxlint-disable-next-line sonarjs/no-internal-api-use -- Scope installed Eve state to this controlled test invocation.
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  createDraftPullRequestProposal,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "../repository/github-publication";
import type { DraftPullRequestProposal } from "../repository/github-publication";
import {
  createReviewedChangeSetReceipt,
  deriveNormalizedChangeSet,
} from "../repository/reviewed-change-set";
import { createGitHubDestinationReviewBinding } from "../repository/github-destination-review";
import { freshFixture, workflowKey } from "../eve/test-support/draft-reviewed-recovery";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";
import type { PublishedDraftRepairSource } from "./published-draft-repair";
import { retainedPublishedDraftOriginForReview } from "./published-draft-repair";
import type { observeNormalizedChangeSet } from "../../agent/tools/change_set_status";
import type { readPreparedSandboxSourceManifest } from "../repository/supported-template";
import type { OwnedPublicationReconciliationScope } from "../repository/github-draft-reconciliation";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type-only namespace preserves the actual overlay module fixture port.
import type * as TargetApplyModule from "../repository/target-apply";

type Fixture = Awaited<ReturnType<typeof freshFixture>>;
type Candidate = DraftReconciliationCandidate & {
  publishedOrigin: PublishedDraftRepairSource;
  publicationScope: OwnedPublicationReconciliationScope;
  reviewedLineage: Fixture["reviewed"];
  unpublished: string;
};
type Workflow = Extract<
  AppBuilderWorkflowState,
  { applyReceipt: TargetApplyModule.TargetApplyReceipt }
>;
interface Owned {
  draft: PublishedDraftRepairSource["draft"];
  source: PublishedDraftRepairSource["source"];
  proposal: OwnedPublicationReconciliationScope["proposal"];
  publication: OwnedPublicationReconciliationScope["publication"];
}
const signAccess = (
  unsigned: Omit<RepositoryAccessReceipt, "digest">,
): RepositoryAccessReceipt => ({
  ...unsigned,
  digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
});

const installation = (operation: "publish-draft-pull-request" | "resolve-existing-source") =>
  createGitHubInstallationIdentity({
    accountId: "20",
    accountLogin: "owner",
    accountType: "Organization",
    installationId: "10",
    operation,
    repositorySelection: "selected",
    selectedRepositoryIds: ["100"],
  });

interface PrepareRequest {
  previousCandidate: Candidate;
  replayPreviousCandidate?: boolean;
  forceFreshCandidate?: boolean;
}

const mocks = vi.hoisted(() => ({
  workflow: undefined as unknown as Workflow,
  candidate: undefined as unknown as Candidate,
  access: undefined as unknown as RepositoryAccessReceipt,
  owned: undefined as unknown as Owned,
  onOwnedRead: undefined as undefined | (() => void),
  classify: vi.fn<(proposal: DraftPullRequestProposal) => Promise<"recorded" | "unrecorded">>(),
  ownedProposalDigests: [] as string[],
  onSourceRead: undefined as undefined | (() => void),
  prepare: vi.fn<(request: PrepareRequest) => Promise<Candidate & { created: boolean }>>(),
  inspectCandidate: vi.fn(),
}));

vi.mock("./workflow-state", async (importOriginal) => ({
  ...(await importOriginal<{
    assertCurrentGitHubDraftProposal: typeof assertCurrentGitHubDraftProposal;
    assertExactWorkflowState: typeof assertExactWorkflowState;
  }>()),
  appBuilderWorkflowState: {
    get: () => mocks.workflow,
    update: (transition: (state: Workflow) => Workflow) => {
      mocks.workflow = transition(mocks.workflow);
    },
  },
  updateExactWorkflow: ({
    expected,
    transition,
  }: {
    expected: Workflow;
    transition: () => Workflow;
  }) => {
    if (!isDeepStrictEqual(mocks.workflow, expected)) {
      throw new Error("The app workflow changed during publication recovery.");
    }
    mocks.workflow = transition();
  },
}));
// This fixture models an ordinary new Build, not resumeApprovedBuild history.
vi.mock("./existing-app-repair-planning", () => ({
  priorResumedBuildDraftProposal: () => {},
}));
vi.mock("./draft-reconciliation-state", () => ({
  draftReconciliationCompletions: { get: () => [] },
  draftReconciliationState: { get: () => mocks.candidate },
  publishedDraftRepairCompletions: { get: () => [] },
  samePersistedDraftCandidate: (left: unknown, right: unknown) =>
    // oxlint-disable-next-line unicorn/prefer-structured-clone, react-doctor/no-json-parse-stringify-clone -- Model the persisted JSON representation, which drops undefined fields.
    isDeepStrictEqual(JSON.parse(JSON.stringify(left)), JSON.parse(JSON.stringify(right))),
  updateExactDraftReconciliation: ({
    expected,
    transition,
  }: {
    expected: Candidate;
    transition: () => Candidate;
  }) => {
    if (
      !isDeepStrictEqual(
        // oxlint-disable-next-line unicorn/prefer-structured-clone, react-doctor/no-json-parse-stringify-clone -- Compare the persisted JSON representation.
        JSON.parse(JSON.stringify(expected)),
        // oxlint-disable-next-line unicorn/prefer-structured-clone, react-doctor/no-json-parse-stringify-clone -- Compare the persisted JSON representation.
        JSON.parse(JSON.stringify(mocks.candidate)),
      )
    ) {
      throw new Error("The draft candidate changed during preparation.");
    }
    mocks.candidate = transition();
  },
}));
vi.mock("./repository-access-state", async (importOriginal) => ({
  ...(await importOriginal<{
    repositoryAccessReceiptSchema: typeof repositoryAccessReceiptSchema;
  }>()),
  repositoryAccessReceiptState: { get: () => mocks.access },
}));
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: async () => ({
    inspectPriorAppPublication: mocks.classify,
    inspectExistingDraftReconciliationSource: async () => {
      mocks.onSourceRead?.();
      return { draft: mocks.owned.draft, base: { headSha: mocks.candidate.baseSha } };
    },
    inspectOwnedPublishedDraftRepairSource: async (request: {
      publishedProposalDigest: string;
      expectedInstallationId: string;
    }) => {
      mocks.ownedProposalDigests.push(request.publishedProposalDigest);
      mocks.onOwnedRead?.();
      if (request.expectedInstallationId !== "10") {
        throw new Error("The owned publication belongs to another installation.");
      }
      if (request.publishedProposalDigest !== mocks.owned.proposal.digest) {
        throw new Error("The original published draft proposal is unavailable in this tenant.");
      }
      return mocks.owned;
    },
  }),
}));
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: async () => ({
    acquireExistingSourceCredential: async () => "controlled",
  }),
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => ({ id: "controlled" }),
}));
vi.mock("./product-behavior-state", () => ({ currentProductBehaviorEvidence: () => [] }));
vi.mock("../testing/test-capability", () => ({
  hasTestCapability: (capability: string) => capability === "simulated-target",
}));
vi.mock("./verified-github-fetch-recovery", () => ({
  prepareWithVerifiedGitHubFetchRecovery: async ({
    prepare,
  }: {
    prepare: () => Promise<unknown>;
  }) => ({ prepared: await prepare(), retriedGitFetch: false }),
}));
vi.mock("../repository/sandbox-draft-reconciliation", () => ({
  prepareDraftReconciliation: mocks.prepare,
  preparePublishedDraftRepairCandidate: vi.fn(),
  inspectDraftReconciliation: mocks.inspectCandidate,
}));

const retainedSource = vi.hoisted(() => ({
  observed: vi.fn(),
  original: vi.fn(),
  overlay: vi.fn(),
  actualObservation: undefined as typeof observeNormalizedChangeSet | undefined,
}));
vi.mock("../../agent/tools/change_set_status", async (importOriginal) => {
  const actual = await importOriginal<{
    observeNormalizedChangeSet: typeof observeNormalizedChangeSet;
  }>();
  retainedSource.actualObservation = actual.observeNormalizedChangeSet;
  return { ...actual, observeNormalizedChangeSet: retainedSource.observed };
});
vi.mock("../repository/target-apply", async (importOriginal) => ({
  ...(await importOriginal<typeof TargetApplyModule>()),
  inspectApplyOverlay: retainedSource.overlay,
  inspectFixtureApplyOverlay: retainedSource.overlay,
}));
vi.mock("./app-baseline-state", () => ({ appBaselineState: { get: () => {} } }));
vi.mock("../repository/supported-template", async (importOriginal) => ({
  ...(await importOriginal<{
    readPreparedSandboxSourceManifest: typeof readPreparedSandboxSourceManifest;
  }>()),
  readPreparedSandboxSourceManifest: retainedSource.original,
}));

describe("owned fresh-template draft preparation after review recovery", () => {
  let fixture: Fixture;
  let root: string;
  const ctx = {
    callId: "prepare",
    session: { id: "logical-original", auth: {}, turn: { id: "current-app-turn" } },
    getSandbox: async () => ({ id: "controlled" }),
  } as unknown as ToolContext;
  beforeEach(async () => {
    fixture = await freshFixture();
    root = mkdtempSync(path.join(tmpdir(), "builder-fresh-owned-"));
    writeFileSync(path.join(root, "candidate.txt"), "latest unpublished candidate bytes\n");
    mocks.workflow = structuredClone(fixture.currentContext[workflowKey]);
    mocks.candidate = {
      ...structuredClone(fixture.candidate),
      root,
      reviewedLineage: structuredClone(fixture.reviewed),
    };
    const origin = mocks.candidate.publishedOrigin;
    const scope = mocks.candidate.publicationScope;
    const { defaultBranch, headSha, headTree, name, owner, repositoryId } =
      origin.source.repository;
    mocks.access = signAccess({
      confirmedByCallId: "record-access",
      providerAccessDigest: origin.source.digest,
      repository: { defaultBranch, headSha, headTree, name, owner, repositoryId },
      scope: {
        accountLogin: owner,
        accountType: "Organization",
        installationId: origin.installationId,
      },
      sessionId: "logical-original",
      version: 1,
    });
    mocks.owned = {
      draft: origin.draft,
      source: origin.source,
      proposal: scope.proposal,
      publication: scope.publication,
    };
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    mocks.onOwnedRead = undefined;
    mocks.classify.mockReset().mockResolvedValue("unrecorded");
    mocks.ownedProposalDigests = [];
    // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
    mocks.onSourceRead = undefined;
    mocks.prepare.mockReset();
    mocks.inspectCandidate.mockReset();
    mocks.prepare.mockImplementation(async (request) => ({
      ...structuredClone(mocks.candidate),
      root: request.previousCandidate.root,
      created: false,
    }));
    retainedSource.observed.mockReset().mockImplementation(async () => {
      const state =
        mocks.workflow.phase === "reviewed" ? mocks.workflow : mocks.candidate.reviewedLineage;
      return {
        changeSet: { ...state.reviewReceipt, digest: state.reviewReceipt.changeSetDigest },
        observed: {
          files: state.applyReceipt.postTree,
          treeDigest: state.reviewReceipt.postTreeDigest,
        },
      };
    });
  });
  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  const reviewedNewBuild = () => {
    const state = structuredClone(fixture.reviewed);
    delete state.publishedGitHubDraftProposalDigest;
    state.proposal.digest = "1".repeat(64);
    state.applyReceipt = {
      ...state.applyReceipt,
      digest: "2".repeat(64),
      proposalDigest: state.proposal.digest,
    };
    state.reviewReceipt = { ...state.reviewReceipt, digest: "3".repeat(64) };
    mocks.workflow = state;
    return state;
  };

  const secondPublication = () => {
    const state = reviewedNewBuild();
    state.reviewReceipt = createReviewedChangeSetReceipt(
      deriveNormalizedChangeSet(
        state.applyReceipt,
        state.validationReceipt,
        state.reviewReceipt.contractDigest,
      ),
      "review-next-app-pr",
    );
    const publicationInstallation = installation("publish-draft-pull-request");
    const readInstallation = installation("resolve-existing-source");
    const { digest: _repositoryDigest, ...repositoryFields } = mocks.owned.source.repository;
    void _repositoryDigest;
    const repository = createRepositoryObservation({
      ...repositoryFields,
      installationIdentityDigest: publicationInstallation.digest,
    });
    const proposal = createDraftPullRequestProposal({
      installation: publicationInstallation,
      repository,
      review: state.reviewReceipt,
      changedPathsSinceBase: [],
      title: "Next owned app revision",
    });
    const destination = createGitHubDestinationReviewBinding({
      applyDigest: state.applyReceipt.digest,
      validationDigest: state.validationReceipt.digest,
      postTreeDigest: state.reviewReceipt.postTreeDigest,
      candidatePaths: state.reviewReceipt.approvedPaths,
      installation: readInstallation,
      repository: createRepositoryObservation({
        ...repositoryFields,
        installationIdentityDigest: readInstallation.digest,
      }),
      preTree: state.applyReceipt.preTree.filter((file) =>
        state.reviewReceipt.approvedPaths.includes(file.path),
      ),
    });
    state.githubDestinationReview = destination;
    state.githubDraftProposal = {
      proposal,
      sourceReceiptDigest: state.sourceReceipt.digest,
      destinationReviewDigest: destination.digest,
    };
    const { digest: _publicationDigest, ...priorPublication } = mocks.owned.publication;
    void _publicationDigest;
    const unsignedPublication = {
      ...priorPublication,
      proposalDigest: proposal.digest,
      idempotencyKey: proposal.idempotencyKey,
      branchName: proposal.branchName,
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve absent optional publication metadata as undefined under the existing contract.
      reviewDigest: undefined,
      changeSetDigest: proposal.changeSetDigest,
      changedContentDigest: proposal.changedContentDigest,
      normalizedChangedPaths: proposal.approvedPaths,
      pullRequestNumber: 43,
      pullRequestId: "401",
      branchSha: "f".repeat(40),
      branchTree: "e".repeat(40),
    };
    Reflect.deleteProperty(unsignedPublication, "reviewDigest");
    const publication = {
      ...unsignedPublication,
      digest: createHash("sha256").update(JSON.stringify(unsignedPublication)).digest("hex"),
    };
    const sourceBody = {
      ...mocks.owned.source,
      repository: createRepositoryObservation({
        ...repositoryFields,
        headSha: publication.branchSha,
        headTree: publication.branchTree,
      }),
      resolvedRef: `refs/heads/${proposal.branchName}`,
      resolvedSha: publication.branchSha,
      resolvedTree: publication.branchTree,
    };
    Reflect.deleteProperty(sourceBody, "digest");
    const source = {
      ...sourceBody,
      digest: createHash("sha256").update(JSON.stringify(sourceBody)).digest("hex"),
    };
    mocks.owned = {
      proposal,
      publication,
      source,
      draft: {
        ...mocks.owned.draft,
        number: 43,
        pullRequestId: "401",
        headBranch: proposal.branchName,
        headSha: publication.branchSha,
        headTree: publication.branchTree,
        verifiedBuilderOrigin: {
          appId: "builder",
          authorId: "builder",
          marker: proposal.idempotencyKey,
        },
      },
    };
    mocks.classify.mockResolvedValue("recorded");
    return state;
  };

  it.each([false, true])(
    "refreshes a stale creation review before acquiring a candidate (retained destination %s)",
    async (retainedDestination) => {
      mocks.workflow = structuredClone(fixture.reviewed);
      const state = mocks.workflow;
      if (retainedDestination) {
        state.githubDestinationReview = createGitHubDestinationReviewBinding({
          applyDigest: state.applyReceipt.digest,
          validationDigest: state.validationReceipt.digest,
          postTreeDigest: state.reviewReceipt.postTreeDigest,
          candidatePaths: state.reviewReceipt.approvedPaths,
          installation: installation("resolve-existing-source"),
          repository: mocks.owned.source.repository,
          preTree: state.applyReceipt.preTree,
        });
      }
      const appFile = `apps/${state.appSpec.appId}/__tests__/data.test.ts`;
      const file = path.join(root, appFile);
      const content = "export const reopenedRecord = () => 'saved';\n";
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      const after = {
        digest: createHash("sha256").update(content).digest("hex"),
        mode: "644",
      };
      const changes = [
        ...state.reviewReceipt.changes,
        { path: appFile, kind: "added" as const, after },
      ];
      let current = deriveNormalizedChangeSet(
        {
          ...state.applyReceipt,
          changes,
          postTreeDigest: createHash("sha256").update(JSON.stringify(changes)).digest("hex"),
        },
        state.validationReceipt,
        state.proposal.contractDigest,
        state.sourceReceipt.contractDigest,
      );
      const observed = {
        changeSet: current,
        observed: { files: [{ path: appFile, ...after }], treeDigest: current.postTreeDigest },
      };
      if (retainedDestination) {
        const observe = retainedSource.actualObservation;
        if (observe === undefined) {
          throw new Error("Missing real change-set observer");
        }
        retainedSource.overlay.mockResolvedValue(observed.observed);
        retainedSource.observed.mockImplementation(observe);
        const withoutOldDestination = invalidateGitHubDestinationReview(state);
        const observation = await observe({
          sandbox: await ctx.getSandbox(),
          state: withoutOldDestination,
        });
        current = observation.changeSet;
      } else {
        retainedSource.observed.mockResolvedValue(observed);
      }
      await expect(
        prepareDraftReconciliationTool.execute({ pullRequestNumber: 42 }, ctx),
      ).resolves.toMatchObject({
        status: "review_refresh_required",
        nextCall: { tool: "accept_change_set", input: {} },
        afterReview: {
          tool: "prepare_github_draft_pr_reconciliation",
          input: { pullRequestNumber: 42 },
        },
      });
      expect(readFileSync(file, "utf-8")).toBe(content);
      expect(mocks.workflow.phase).toBe("validated");
      expect(mocks.workflow.applyReceipt).toBe(state.applyReceipt);
      expect(mocks.workflow.validationReceipt).toBe(state.validationReceipt);
      expect(mocks.workflow.sourceReceipt).toBe(state.sourceReceipt);
      expect(mocks.workflow).not.toHaveProperty("githubDestinationReview");
      expect(mocks.workflow).not.toHaveProperty("reviewReceipt");
      expect(mocks.prepare).not.toHaveBeenCalled();
      const accept = createChangeSetAcceptanceTool({
        observeChangeSet: retainedSource.observed,
        reviewSource: async () => {
          throw new Error("Independent source assessment was not requested");
        },
      });
      await accept.execute({}, ctx);
      expect(mocks.workflow.phase).toBe("reviewed");
      if (mocks.workflow.phase !== "reviewed") {
        throw new Error("Expected the current app review");
      }
      expect(mocks.workflow.reviewReceipt.changeSetDigest).toBe(current.digest);
      expect(mocks.workflow.reviewReceipt.digest).not.toBe(state.reviewReceipt.digest);
      expect(mocks.workflow.reviewReceipt.approvedPaths).toContain(appFile);
      expect(mocks.workflow.applyReceipt).toBe(state.applyReceipt);
      await expect(
        sealDraftReconciliationTool.execute(
          { expectedReviewDigest: state.reviewReceipt.digest },
          ctx,
        ),
      ).rejects.toThrow();
      expect(mocks.inspectCandidate).not.toHaveBeenCalled();
      expect(mocks.workflow).not.toHaveProperty("githubDraftProposal");
      await expect(
        prepareDraftReconciliationTool.execute({ pullRequestNumber: 42 }, ctx),
      ).resolves.toMatchObject({ status: "ready_for_validation" });
      expect(readFileSync(file, "utf-8")).toBe(content);
    },
  );

  it("validates changed creation bytes before refreshing an owned review from an applied workflow", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      const state = structuredClone(fixture.reviewed);
      const creationRoot = path.join(root, "creation");
      const appFile = `apps/${state.appSpec.appId}/page.ts`;
      const creationFile = path.join(creationRoot, appFile);
      const candidateFile = path.join(mocks.candidate.root, appFile);
      const creationContent = "export const saved = 'current creation repair';\n";
      const candidateContent = "export const saved = 'separate draft candidate';\n";
      for (const file of [creationFile, candidateFile]) {
        mkdirSync(path.dirname(file), { recursive: true });
      }
      writeFileSync(creationFile, creationContent);
      writeFileSync(candidateFile, candidateContent);
      const manifest = path.join(creationRoot, `apps/${state.appSpec.appId}/package.json`);
      writeFileSync(manifest, JSON.stringify({ name: "@fixture/orchard" }));
      const candidateBefore = structuredClone(mocks.candidate);
      const applied = { ...state, phase: "applied" as const };
      Reflect.deleteProperty(applied, "reviewReceipt");
      Reflect.deleteProperty(applied, "validationReceipt");
      mocks.workflow = applied;
      const observe = retainedSource.actualObservation;
      if (observe === undefined) {
        throw new Error("Missing real change-set observer");
      }
      retainedSource.overlay.mockImplementation(async (_sandbox, observedRoot: string) => {
        expect(observedRoot).toBe(state.applyReceipt.applyRoot);
        const content = readFileSync(creationFile, "utf-8");
        const files = [
          {
            path: appFile,
            mode: "644",
            digest: createHash("sha256").update(content).digest("hex"),
          },
        ];
        return {
          files,
          treeDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
        };
      });
      retainedSource.observed.mockImplementation(observe);
      const validationContext = {
        ...ctx,
        getSandbox: async () => ({
          id: "controlled",
          readTextFile: async ({ path: requestedPath }: { path: string }) => {
            expect(requestedPath).toBe(
              path.posix.join(
                state.applyReceipt.applyRoot,
                `apps/${state.appSpec.appId}/package.json`,
              ),
            );
            return readFileSync(manifest, "utf-8");
          },
        }),
      } as unknown as ToolContext;
      const refresh = await prepareDraftReconciliationTool.execute(
        { pullRequestNumber: 42 },
        validationContext,
      );
      expect(refresh).toMatchObject({
        status: "review_refresh_required",
        nextCall: {
          tool: "validate_app_creation",
          input: { implementationFiles: [], validationTarget: "creation-workspace" },
        },
      });
      expect(mocks.workflow).toEqual(applied);
      expect(mocks.candidate).toEqual(candidateBefore);
      expect(mocks.prepare).not.toHaveBeenCalled();
      if (!("nextCall" in refresh) || refresh.nextCall.tool !== "validate_app_creation") {
        throw new Error("Expected explicit creation validation continuation");
      }
      const commands: { root: string; content: string; exitCode: number }[] = [];
      let failRequiredCheck = true;
      const validate = createAppValidationTool({
        captureRelease: async () => null,
        // oxlint-disable-next-line unicorn/no-useless-undefined -- This fixture has no backend description; source validation is the behavior under test.
        describeApp: async () => undefined,
        executeValidation: async (input) =>
          await executeProposalBoundValidation({
            ...input,
            executor: async ({ validationRoot }) => {
              expect(validationRoot).toBe(state.applyReceipt.applyRoot);
              expect(validationRoot).not.toBe(mocks.candidate.root);
              const content = readFileSync(creationFile, "utf-8");
              expect(content).toBe(creationContent);
              const exitCode = failRequiredCheck ? 1 : 0;
              commands.push({ root: validationRoot, content, exitCode });
              return {
                exitCode,
                stdout: "",
                stderr: exitCode === 0 ? "" : "Required check failed",
              };
            },
          }),
        validateBackend: async () => ({ status: "unassessed" }),
      });
      const accept = createChangeSetAcceptanceTool({
        observeChangeSet: observe,
        reviewSource: async () => {
          throw new Error("Independent source assessment was not requested");
        },
      });
      await expect(
        validate.execute(refresh.nextCall.input, validationContext),
      ).resolves.toMatchObject({
        status: "needs_repair",
      });
      expect(mocks.workflow.phase).toBe("validation_failed");
      await expect(accept.execute({}, validationContext)).rejects.toThrow("repository validation");
      expect(mocks.candidate).toEqual(candidateBefore);
      failRequiredCheck = false;
      await expect(
        validate.execute(refresh.nextCall.input, validationContext),
      ).resolves.toMatchObject({
        status: "validated",
      });
      expect(commands[0]?.exitCode).toBe(1);
      expect(commands.slice(1).every(({ exitCode }) => exitCode === 0)).toBe(true);
      const validated = appBuilderWorkflowState.get();
      if (validated.phase !== "validated") {
        throw new Error("Expected real creation validation receipt");
      }
      const validation = validated.validationReceipt;
      expect(validation.digest).not.toBe(state.validationReceipt.digest);
      expect(validation.commands.length).toBeGreaterThan(0);
      expect(
        validation.commands.every(
          ({ validationRoot }) => validationRoot === state.applyReceipt.applyRoot,
        ),
      ).toBe(true);
      expect(mocks.candidate).toEqual(candidateBefore);
      await accept.execute({}, validationContext);
      const reviewed = appBuilderWorkflowState.get();
      if (reviewed.phase !== "reviewed") {
        throw new Error("Expected fresh current creation review");
      }
      expect(reviewed.reviewReceipt.digest).not.toBe(state.reviewReceipt.digest);
      expect(reviewed.reviewReceipt.validationDigest).toBe(validation.digest);
      const reviewedFile = reviewed.reviewReceipt.changes.find(
        ({ path: changedPath }) => changedPath === appFile,
      );
      expect(reviewedFile?.after?.digest).toBe(
        createHash("sha256").update(creationContent).digest("hex"),
      );
      await expect(
        prepareDraftReconciliationTool.execute({ pullRequestNumber: 42 }, validationContext),
      ).resolves.toMatchObject({ status: "ready_for_validation" });
      expect(mocks.candidate.pullRequestNumber).toBe(42);
      expect(mocks.candidate.originalReviewDigest).toBe(reviewed.reviewReceipt.digest);
      expect(readFileSync(candidateFile, "utf-8")).toBe(candidateContent);
      expect(readFileSync(creationFile, "utf-8")).toBe(creationContent);
    });
  });

  it.each(
    (["reviewed", "applied"] as const).flatMap((phase) =>
      (["cancelled", "workflow-changed", "candidate-changed"] as const).map((change) => ({
        phase,
        change,
      })),
    ),
  )(
    "does not return a $phase review refresh after $change during current byte observation",
    async ({ phase, change }) => {
      mocks.workflow = structuredClone(fixture.reviewed);
      if (phase === "applied") {
        const applied = { ...mocks.workflow, phase };
        Reflect.deleteProperty(applied, "reviewReceipt");
        Reflect.deleteProperty(applied, "validationReceipt");
        mocks.workflow = applied;
      }
      const state = mocks.workflow;
      const controller = new AbortController();
      retainedSource.observed.mockImplementation(async () => {
        if (change === "cancelled") {
          controller.abort();
        }
        if (change === "workflow-changed") {
          mocks.workflow = { ...state, workspace: { ...state.workspace, workspaceId: "foreign" } };
        }
        if (change === "candidate-changed") {
          mocks.candidate = { ...mocks.candidate, root: "/workspace/another-candidate" };
        }
        return {
          changeSet: { ...fixture.reviewed.reviewReceipt, digest: "f".repeat(64) },
          observed: {},
        };
      });
      await expect(
        prepareDraftReconciliationTool.execute(
          { pullRequestNumber: 42 },
          { ...ctx, abortSignal: controller.signal },
        ),
      ).rejects.toThrow();
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("repairs the next published PR instead of the old retained merged PR", async () => {
    const state = secondPublication();
    const privateBefore = readFileSync(path.join(root, "candidate.txt"), "utf-8");
    expect(mocks.candidate.pullRequestNumber).toBe(42);
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 43, state }),
    ).resolves.toMatchObject({ status: "ready_for_validation" });
    expect(mocks.ownedProposalDigests).toContain(state.githubDraftProposal?.proposal.digest);
    expect(mocks.workflow).toMatchObject({
      publishedGitHubDraftProposalDigest: mocks.owned.proposal.digest,
    });
    expect(mocks.candidate.pullRequestNumber).toBe(43);
    expect(readFileSync(path.join(root, "candidate.txt"), "utf-8")).toBe(privateBefore);
  });

  it.each(["pending", "rejected", "unknown", "moved-head"])(
    "does not use a recorded current %s result as published proof or fall back to the old PR",
    async (reason) => {
      const state = secondPublication();
      const oldCandidate = structuredClone(mocks.candidate);
      mocks.onOwnedRead = () => {
        throw new Error(`owned publication ${reason}`);
      };
      await expect(
        preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 43, state }),
      ).rejects.toThrow(`owned publication ${reason}`);
      expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(mocks.candidate).toEqual(oldCandidate);
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.ownedProposalDigests).toEqual([mocks.owned.proposal.digest]);
    },
  );

  it.each(["repository", "installation", "requested-pr"])(
    "keeps the current published seal bound to verified %s access",
    async (binding) => {
      const state = secondPublication();
      const oldCandidate = structuredClone(mocks.candidate);
      if (binding === "repository") {
        mocks.owned.draft = { ...mocks.owned.draft, repositoryId: "999" };
      }
      if (binding === "installation") {
        const { digest: _digest, ...access } = mocks.access;
        void _digest;
        mocks.access = signAccess({ ...access, scope: { ...access.scope, installationId: "999" } });
      }
      await expect(
        preparePublishedDraftReconciliation({
          ctx,
          pullRequestNumber: binding === "requested-pr" ? 42 : 43,
          state,
        }),
      ).rejects.toThrow();
      expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(mocks.candidate).toEqual(oldCandidate);
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to an old PR when current canonical lookup is unavailable", async () => {
    const state = secondPublication();
    mocks.classify.mockRejectedValue(new Error("canonical lookup unavailable"));
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 43, state }),
    ).rejects.toThrow("canonical lookup unavailable");
    expect(mocks.ownedProposalDigests).toEqual([]);
    expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(["lookup", "owned-read"])(
    "rechecks the exact current seal after %s before recording its marker",
    async (phase) => {
      const state = secondPublication();
      const moveSeal = () => {
        const sealed = state.githubDraftProposal;
        if (sealed === undefined) {
          throw new Error("Missing current seal fixture");
        }
        mocks.workflow = {
          ...state,
          githubDraftProposal: {
            ...sealed,
            proposal: { ...sealed.proposal, digest: "9".repeat(64) },
          },
        };
      };
      if (phase === "lookup") {
        mocks.classify.mockImplementation(async () => {
          moveSeal();
          return "recorded";
        });
      } else {
        mocks.onOwnedRead = moveSeal;
      }
      await expect(
        preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 43, state }),
      ).rejects.toThrow("workflow changed concurrently");
      expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("recovers a lost publication marker after a new Build without losing its accepted private fixes", async () => {
    const state = reviewedNewBuild();
    const before = readFileSync(path.join(root, "candidate.txt"), "utf-8");
    const result = await preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state });
    expect(result).toMatchObject({ status: "ready_for_validation" });
    expect(mocks.ownedProposalDigests).toContain(mocks.owned.proposal.digest);
    expect(mocks.workflow).toMatchObject({
      publishedGitHubDraftProposalDigest: mocks.owned.proposal.digest,
      proposal: state.proposal,
      applyReceipt: state.applyReceipt,
      reviewReceipt: state.reviewReceipt,
    });
    expect(mocks.candidate.originalReviewDigest).toBe(state.reviewReceipt.digest);
    expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({
      unpublished: {
        reviewDigest: state.reviewReceipt.digest,
        changes: state.reviewReceipt.changes,
      },
    });
    expect(readFileSync(path.join(root, "candidate.txt"), "utf-8")).toBe(before);
  });

  it("supports a canonical retained repair without requiring reconciliation-only scope metadata", () => {
    const state = reviewedNewBuild();
    const { publicationScope: _scope, publishedOrigin, ...candidate } = mocks.candidate;
    void _scope;
    const repair: DraftReconciliationCandidate = {
      ...candidate,
      kind: "published-draft-repair",
      repair: publishedOrigin,
      baseSha: candidate.headSha,
      baseTree: candidate.headTree,
    };
    expect(retainedPublishedDraftOriginForReview(state, repair)?.digest).toBe(
      publishedOrigin.digest,
    );
  });

  it("uses the retained original before a newly sealed unpublished proposal", async () => {
    const state = reviewedNewBuild();
    state.githubDraftProposal = {
      proposal: { ...mocks.owned.proposal, digest: "4".repeat(64) },
      sourceReceiptDigest: state.sourceReceipt.digest,
      destinationReviewDigest: "5".repeat(64),
    };
    await preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state });
    expect(mocks.ownedProposalDigests).toContain(mocks.owned.proposal.digest);
    expect(mocks.ownedProposalDigests).not.toContain(state.githubDraftProposal.proposal.digest);
    expect(mocks.workflow).toMatchObject({ githubDraftProposal: state.githubDraftProposal });
  });

  it("never overrides a present contradictory publication marker with an old retained origin", async () => {
    const state = reviewedNewBuild();
    state.publishedGitHubDraftProposalDigest = "4".repeat(64);
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
    ).rejects.toThrow("The original published draft proposal is unavailable in this tenant.");
    expect(mocks.workflow.publishedGitHubDraftProposalDigest).toBe(
      state.publishedGitHubDraftProposalDigest,
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([
    "app",
    "spec",
    "source",
    "workspace",
    "path",
    "digest",
    "sha",
    "tree",
    "apply-root",
  ] as const)(
    "does not borrow a canonical retained origin across changed current %s binding",
    async (binding) => {
      const state = reviewedNewBuild();
      const change = {
        app: () => {
          state.appSpec.appId = "another-app";
        },
        spec: () => {
          state.appSpec.digest = "6".repeat(64);
        },
        source: () => {
          state.sourceReceipt.digest = "6".repeat(64);
        },
        workspace: () => {
          state.workspace.workspaceId = "another-workspace";
        },
        path: () => {
          // A controlled foreign persisted path must not borrow the original lookup.
          state.workspace.workspacePath =
            "/workspace/another" as typeof state.workspace.workspacePath;
        },
        digest: () => {
          state.workspace.workspaceDigest = "6".repeat(64);
        },
        sha: () => {
          state.workspace.sourceSha = "6".repeat(40);
        },
        tree: () => {
          state.workspace.sourceTree = "6".repeat(40);
        },
        "apply-root": () => {
          state.applyReceipt.applyRoot = "/workspace/another";
        },
      };
      change[binding]();
      await expect(
        preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
      ).rejects.toThrow(
        "The owned original draft publication or its repository access is unavailable",
      );
      expect(mocks.ownedProposalDigests).toEqual([]);
      expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it.each(["session", "repository", "installation"] as const)(
    "keeps lost-marker recovery bound to fresh %s access",
    async (binding) => {
      const state = reviewedNewBuild();
      const { digest: _digest, ...access } = mocks.access;
      void _digest;
      const changed = {
        ...access,
        sessionId: binding === "session" ? "another-session" : access.sessionId,
        repository: {
          ...access.repository,
          repositoryId: binding === "repository" ? "999" : access.repository.repositoryId,
        },
        scope: {
          ...access.scope,
          installationId: binding === "installation" ? "999" : access.scope.installationId,
        },
      };
      mocks.access = signAccess(changed);
      await expect(
        preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
      ).rejects.toThrow();
      expect(mocks.ownedProposalDigests).toEqual([]);
      expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("does not record recovered publication provenance when its provider read fails", async () => {
    const state = reviewedNewBuild();
    const candidate = structuredClone(mocks.candidate);
    mocks.onOwnedRead = () => {
      throw new Error("controlled GitHub ownership read failed");
    };
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
    ).rejects.toThrow("controlled GitHub ownership read failed");
    expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
    expect(mocks.candidate).toEqual(candidate);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("preserves cancellation after ownership read without recording the marker or preparing files", async () => {
    const state = reviewedNewBuild();
    const controller = new AbortController();
    mocks.onOwnedRead = () => {
      controller.abort();
    };
    await expect(
      preparePublishedDraftReconciliation({
        ctx: { ...ctx, abortSignal: controller.signal },
        pullRequestNumber: 42,
        state,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("rechecks the exact workspace after the owned publication read before recording recovery", async () => {
    const state = reviewedNewBuild();
    mocks.onOwnedRead = () => {
      mocks.workflow = {
        ...state,
        workspace: { ...state.workspace, workspaceId: "replaced-workspace" },
      };
    };
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state }),
    ).rejects.toThrow("The accepted app workflow changed during draft repair preparation.");
    expect(mocks.workflow).not.toHaveProperty("publishedGitHubDraftProposalDigest");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "restores a missing package and registration (starter repository: %s)",
    async (sameRepository) => {
      const state = structuredClone(fixture.reviewed);
      const appRoot = `apps/${state.appSpec.appId}`;
      retainedSource.original.mockReset();
      if (sameRepository) {
        mocks.owned.proposal = {
          ...mocks.owned.proposal,
          owner: "withAutograph",
          name: "arrusted-development",
        };
        retainedSource.original.mockRejectedValue(new Error("Prepared manifest missing"));
      } else {
        retainedSource.original.mockResolvedValue([
          { path: "microfrontends.json", mode: "100644", sha256: "starter" },
        ]);
      }
      retainedSource.observed.mockResolvedValue({
        observed: {
          treeDigest: "current",
          files: [
            { path: `${appRoot}/package.json`, mode: "644", digest: "manifest" },
            { path: `${appRoot}/app/page.tsx`, mode: "644", digest: "page" },
            { path: "microfrontends.json", mode: "644", digest: "registered" },
            { path: "apps/another/app/page.tsx", mode: "644", digest: "other" },
          ],
        },
      });
      await preparePublishedDraftReconciliation({
        ctx,
        pullRequestNumber: 42,
        restoreInitialAppSource: true,
        state,
      });
      const expectedUnpublished = () => {
        interface ExpectedUnpublishedSource {
          restoreInitialAppSource: boolean;
          initialSourceRevision?: { sha: string; tree: string };
        }
        const source: ExpectedUnpublishedSource = { restoreInitialAppSource: true };
        if (sameRepository) {
          source.initialSourceRevision = {
            sha: state.sourceReceipt.sourceSha,
            tree: state.sourceReceipt.sourceTree,
          };
        }
        return {
          ...source,
          changes: [
            { kind: "added", path: `${appRoot}/app/page.tsx` },
            { kind: "added", path: `${appRoot}/package.json` },
            sameRepository
              ? { kind: "added", path: "microfrontends.json" }
              : {
                  before: { digest: "starter", mode: "644" },
                  kind: "modified",
                  path: "microfrontends.json",
                },
          ],
        };
      };
      expect(mocks.prepare.mock.calls[0]?.[0]).toMatchObject({
        forceFreshCandidate: true,
        ownedPublication: { proposal: mocks.owned.proposal, publication: mocks.owned.publication },
        unpublished: expectedUnpublished(),
      });
    },
  );

  it("keeps the validated workflow and exact candidate/private edits when normal preparation reuses it", async () => {
    const before = structuredClone(mocks.candidate);
    const workflow = structuredClone(mocks.workflow);
    const result = await preparePublishedDraftReconciliation({
      ctx,
      pullRequestNumber: 42,
      state: fixture.reviewed,
    });
    expect(result.root).toBe(before.root);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    const [[request]] = mocks.prepare.mock.calls;
    expect(request.previousCandidate).toEqual(before);
    expect(request.replayPreviousCandidate).toBe(true);
    expect(request.forceFreshCandidate).toBeUndefined();
    expect(mocks.candidate.unpublished).toBe(before.unpublished);
    expect(readFileSync(path.join(result.root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
    expect(mocks.workflow).toEqual(workflow);
    expect(mocks.workflow.phase).toBe("validated");
  });

  it("passes explicit original-publication cleanup through the same owned app and retains private replay", async () => {
    const previous = structuredClone(mocks.candidate);
    await preparePublishedDraftReconciliation({
      state: fixture.reviewed,
      ctx,
      pullRequestNumber: 42,
      repairOriginalPublication: { discardAddedPaths: ["app/page.tsx"] },
    });
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({
      originalPublicationRepair: { discardAddedPaths: ["app/page.tsx"] },
      ownedPublication: { proposal: mocks.owned.proposal, publication: mocks.owned.publication },
      previousCandidate: { root: previous.root, appId: previous.appId },
      replayPreviousCandidate: true,
    });
    expect(readFileSync(path.join(previous.root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
  });

  it("retains the original cleanup selection for a retry against the same owned head", async () => {
    mocks.candidate.originalPublicationRepair = { discardAddedPaths: ["app/page.tsx"] };
    await preparePublishedDraftReconciliation({
      state: fixture.reviewed,
      ctx,
      pullRequestNumber: 42,
    });
    expect(mocks.prepare.mock.calls[0][0]).toMatchObject({
      originalPublicationRepair: { discardAddedPaths: ["app/page.tsx"] },
      replayPreviousCandidate: true,
    });
  });

  it("retains the old owned candidate for inspection when a fresh review has a different digest", async () => {
    mocks.workflow = structuredClone(fixture.reviewed);
    mocks.candidate.originalReviewDigest = "e".repeat(64);
    const previous = structuredClone(mocks.candidate);
    mocks.prepare.mockImplementation(async () => ({
      ...structuredClone(previous),
      root: `${root}-new`,
      created: true,
    }));
    const result = await preparePublishedDraftReconciliation({
      ctx,
      pullRequestNumber: 42,
      recovery: "reopen-current-owned-draft",
      state: fixture.reviewed,
    });
    expect(mocks.prepare.mock.calls[0][0].previousCandidate).toBeUndefined();
    expect(result.preservedWorkspaces).toContainEqual({
      kind: "draft-candidate",
      reviewDigest: previous.originalReviewDigest,
      root,
    });
    expect(mocks.candidate.preservedWorkspaces).toContainEqual({
      kind: "draft-candidate",
      reviewDigest: previous.originalReviewDigest,
      root,
    });
    expect(readFileSync(path.join(root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
  });

  it.each(["app", "repository", "pull-request", "publication", "installation"] as const)(
    "does not expose a candidate with a different %s as preserved work",
    async (difference) => {
      mocks.workflow = structuredClone(fixture.reviewed);
      if (difference === "app") {
        mocks.candidate.appId = "foreign-app";
      }
      if (difference === "repository") {
        mocks.candidate.repositoryId = "foreign-repository";
      }
      if (difference === "pull-request") {
        mocks.candidate.pullRequestNumber = 99;
      }
      if (difference === "publication") {
        mocks.candidate.publishedOrigin.publicationDigest = "f".repeat(64);
      }
      if (difference === "installation") {
        mocks.candidate.publishedOrigin.installationId = "foreign-installation";
      }
      const previous = structuredClone(mocks.candidate);
      mocks.prepare.mockImplementation(async () => ({
        ...structuredClone(previous),
        root: `${root}-new`,
        created: true,
      }));
      const result = await preparePublishedDraftReconciliation({
        ctx,
        pullRequestNumber: 42,
        recovery: "reopen-current-owned-draft",
        state: fixture.reviewed,
      });
      expect(mocks.prepare.mock.calls[0][0].previousCandidate).toBeUndefined();
      expect(result.preservedWorkspaces).not.toContainEqual(
        expect.objectContaining({ kind: "draft-candidate", root }),
      );
    },
  );

  it.each(["root", "source", "review"] as const)(
    "refuses a %s change during the first ownership read",
    async (variant) => {
      mocks.onOwnedRead = () => {
        if (variant === "root") {
          mocks.candidate = { ...mocks.candidate, root: "/workspace/other" };
        }
        if (variant === "source") {
          mocks.workflow = {
            ...mocks.workflow,
            sourceReceipt: { ...mocks.workflow.sourceReceipt, digest: "f".repeat(64) },
          };
        }
        if (variant === "review") {
          mocks.candidate = { ...mocks.candidate, originalReviewDigest: "e".repeat(64) };
        }
      };
      await expect(
        preparePublishedDraftReconciliation({
          ctx,
          pullRequestNumber: 42,
          state: fixture.reviewed,
        }),
      ).rejects.toThrow();
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("refuses a candidate replacement during draft source inspection before preparing a checkout", async () => {
    mocks.onSourceRead = () => {
      mocks.candidate = { ...mocks.candidate, root: "/workspace/replaced" };
    };
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state: fixture.reviewed }),
    ).rejects.toThrow("candidate changed");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("accepts an equivalent reordered candidate with an omitted optional value during inspection", async () => {
    mocks.onSourceRead = () => {
      mocks.candidate = {
        ...Object.fromEntries(Object.entries(mocks.candidate).toReversed()),
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
        review: undefined,
      } as Candidate;
    };
    const result = await preparePublishedDraftReconciliation({
      ctx,
      pullRequestNumber: 42,
      state: fixture.reviewed,
    });
    expect(result.root).toBe(root);
    expect(readFileSync(path.join(result.root, "candidate.txt"), "utf-8")).toBe(
      "latest unpublished candidate bytes\n",
    );
  });

  it("refuses a foreign session before reading the owned publication", async () => {
    const { digest, ...unsigned } = mocks.access;
    mocks.access = signAccess({ ...unsigned, sessionId: "foreign" });
    expect(mocks.access.digest).not.toBe(digest);
    await expect(
      preparePublishedDraftReconciliation({ ctx, pullRequestNumber: 42, state: fixture.reviewed }),
    ).rejects.toThrow("another session");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
