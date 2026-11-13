/* oxlint-disable sonarjs/no-internal-api-use -- Real Eve state and Build authority exercise source ownership across revisions. */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import type { ToolContext } from "eve/tools";
import type { RuntimeSandboxSession } from "eve/sandbox";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { DraftPullRequestProposal } from "../repository/github-publication";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
} from "../repository/github-publication";
import type { GitHubPublicationRuntime } from "./github-publication-runtime";
import type { ReadyRepositoryAccess } from "../integrations/repository-access";
import type {
  HostedTemplateFoundationInput,
  HostedTemplateFoundationResult,
} from "../repository/hosted-template-source-reconciliation";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Describe the untouched module exports when replacing its external filesystem/fetch port.
import type * as FoundationModule from "../repository/hosted-template-source-reconciliation";
import { inspectCanonicalTemplateSnapshotReceipt } from "../repository/source-receipt";
import {
  recordRepositoryAccessReceipt,
  repositoryAccessReceiptState,
} from "./repository-access-state";
import { appBuilderWorkflowState } from "./workflow-state";
import { sourceWorkflowState } from "./source-state";
import { hostedTemplateFoundationRecoveryHistory } from "./hosted-template-foundation-recovery-state";
import { refreshOwnedAppSource } from "./refresh-owned-app-source";
import {
  priorHostedTemplatePublication,
  resolveHostedTemplateFoundationBinding,
} from "./hosted-template-foundation-binding";
import {
  existingAppRepairHistory,
  priorOwnedAppDraftPublication,
} from "./existing-app-repair-planning";
import {
  assertApprovedPrivateApplySession,
  readPrivateApplyAuthority,
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
} from "./private-apply-authority";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import { draftReconciliationState } from "./draft-reconciliation-state";
import {
  currentDraftCandidateSource,
  createPublishedDraftRepairSource,
} from "./published-draft-repair";
import {
  fixture as connectedFixture,
  freshFixture,
} from "../eve/test-support/draft-reviewed-recovery";
import prepareApp from "../../agent/tools/prepare_app_creation";

interface ControlledDeploymentPorts {
  access: unknown;
  publication: unknown;
  reconcile: Mock<typeof FoundationModule.reconcileHostedTemplateFoundation>;
}
const defaultPorts = vi.hoisted((): ControlledDeploymentPorts => ({
  access: null,
  publication: null,
  reconcile: vi.fn<typeof FoundationModule.reconcileHostedTemplateFoundation>(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Only deployment-owned external access ports are controlled; tool/state/approval/recovery stay real.
vi.mock("./deployment-repository-access-runtime", () => ({
  repositoryAccessRuntimeForSession: async () => await Promise.resolve(defaultPorts.access),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- No GitHub provider or credentials are available in this local fixture.
vi.mock("./deployment-github-publication-runtime", () => ({
  githubPublicationRuntimeForSession: async () => await Promise.resolve(defaultPorts.publication),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Replace filesystem/fetch I/O only, while exercising the real owned refresh and durable recovery state.
vi.mock("../repository/hosted-template-source-reconciliation", async (original) => ({
  ...(await original<typeof FoundationModule>()),
  reconcileHostedTemplateFoundation: defaultPorts.reconcile,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Public progress projection is separate from the private source/approval transition under test.
vi.mock("./approved-build-continuation-runtime", () => ({
  emitCurrentBuildWorkflowProjection: async () => {},
}));

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unsupported = (): never => {
  throw new Error("Unexpected Sandbox command outside the controlled transport");
};
const clearRepositoryAccess = () => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- A missing receipt is the actual reconnect/cancellation state under test.
  repositoryAccessReceiptState.update(() => undefined);
};
const sessionId = "same-owned-session";
const appId = "orchard-notebook";
const source = (character: string) =>
  inspectCanonicalTemplateSnapshotReceipt({
    readinessDigest: hash(character),
    snapshot: {
      sourcePath: "/workspace/repository",
      sourceSha: character.repeat(40),
      sourceTree: character.repeat(40),
      contents: {},
      contract: [],
      dirtyPaths: [],
    },
  });
const workspace = (receipt = source("a")) => ({
  adapter: receipt.adapter,
  eligibilityDigest: receipt.eligibilityDigest,
  sourcePath: receipt.sourcePath,
  sourceSha: receipt.sourceSha,
  sourceTree: receipt.sourceTree,
  workspaceDigest: hash(receipt.sourceSha),
  workspaceId: "owned-compute",
  workspacePath: "/workspace/repository" as const,
});
const grant = (proposalDigest = "original-build") => ({
  appId,
  sessionId,
  appSpecDigest: "accepted-product",
  proposalDigest,
  workspaceId: "owned-compute",
});
const approve = (proposalDigest = "original-build") => {
  const scope = grant(proposalDigest);
  requestPrivateApplyApproval(scope, proposalDigest);
  recordApprovedPrivateApply(scope, proposalDigest);
};
const within = async (operation: () => Promise<void>) => {
  await contextStorage.run(new ContextContainer(), operation);
};

const fixture = () => {
  const original = source("a");
  // SAFETY: Only real source/Build and publication lookup fields consumed by this
  // test are populated. The provider-owned canonical proposal proof is exercised
  // separately through the real publication runtime tests.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Bounded in-memory journal input, no external credential or effect ports.
  const proposal = {
    digest: "published-app",
    repositoryId: "1221250267",
    owner: "withAutograph",
    name: "arrusted-development",
    approvedPaths: [`apps/${appId}/package.json`],
  } as unknown as DraftPullRequestProposal;
  const publication = { proposal, installationId: "17" };
  // SAFETY: The fixture supplies every scope field consumed by real recovery,
  // history and Build assertions. It cannot execute a repository/app command.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Test-owned settled workflow omits unrelated UI/compile payloads.
  const initial = {
    version: 17,
    phase: "reviewed",
    appSpec: {
      appId,
      digest: "accepted-product",
      artifactPath: "prototype/orchard-notebook/app-spec.md",
      artifactRevision: "accepted-revision",
    },
    artifacts: [{ path: "retained-design" }],
    preparedByCallId: "original-prepare",
    sourceReceipt: original,
    workspace: workspace(),
    dependencyReceipt: { digest: "installed-dependencies" },
    identityReceipt: { digest: "same-app-identity" },
    proposal: {
      digest: "original-build",
      appSpecDigest: "accepted-product",
      artifactRevision: "accepted-revision",
      sourceReceiptDigest: original.digest,
      sourceSha: original.sourceSha,
      sourceTree: original.sourceTree,
      workspaceDigest: workspace().workspaceDigest,
      target: {
        operation: "create-app",
        contract: {
          appId,
          appSpec: { path: "prototype/orchard-notebook/app-spec.md", sha256: "accepted-product" },
        },
      },
    },
    applyReceipt: {
      digest: "original-apply",
      appSpecDigest: "accepted-product",
      proposalDigest: "original-build",
      appSpecPath: "prototype/orchard-notebook/app-spec.md",
      artifactRevision: "accepted-revision",
      sourceReceiptDigest: original.digest,
      sourceSha: original.sourceSha,
      sourceTree: original.sourceTree,
      workspaceDigest: workspace().workspaceDigest,
      applyRoot: "/workspace/repository",
    },
    validationReceipt: { digest: "old-validation" },
    reviewReceipt: { digest: "old-review" },
    githubDraftProposal: { proposal },
    publishedGitHubDraftProposalDigest: proposal.digest,
  } as unknown as Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
  appBuilderWorkflowState.update(() => initial);
  sourceWorkflowState.update(() => ({ version: 3, phase: "reviewed", receipt: original }));
  approve();
  const observed: ReadyRepositoryAccess = {
    status: "ready",
    accessDigest: hash("connected-access"),
    scope: { accountLogin: "withAutograph", accountType: "Organization", installationId: "17" },
    repository: {
      owner: "withAutograph",
      name: "arrusted-development",
      repositoryId: "1221250267",
      defaultBranch: "main",
      headSha: "b".repeat(40),
      headTree: "b".repeat(40),
      archived: false,
      visibility: "private",
      repositoryVariableNames: [],
    },
  };
  repositoryAccessReceiptState.update(() =>
    recordRepositoryAccessReceipt({
      sessionId,
      confirmedByCallId: "store-in",
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- This is the initial receipt, with no previous owner binding.
      current: undefined,
      access: observed,
    }),
  );
  const cancellation = new AbortController();
  const sandbox: RuntimeSandboxSession = {
    delete: unsupported,
    stop: unsupported,
    resolvePath: unsupported,
    removePath: unsupported,
    readBinaryFile: unsupported,
    readFile: unsupported,
    readTextFile: unsupported,
    run: unsupported,
    spawn: unsupported,
    writeBinaryFile: unsupported,
    writeFile: unsupported,
    writeTextFile: unsupported,
  };
  // SAFETY: Recovery uses the real state container plus these session/cancel/
  // compute ports. No approval or identity fields come from model input.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled tool context omits unrelated logging APIs.
  const ctx = {
    callId: "refresh-current-source",
    session: { id: sessionId, auth: {} },
    abortSignal: cancellation.signal,
    getSandbox: async () => await Promise.resolve(sandbox),
  } as ToolContext;
  const classify = vi.fn(async () => await Promise.resolve(observed));
  const acquireExistingSourceCredential = vi.fn(
    async () => await Promise.resolve({ token: "private-test-read-token" }),
  );
  const installation = createGitHubInstallationIdentity({
    accountId: "20",
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId: "17",
    operation: "resolve-existing-source",
    repositorySelection: "selected",
    selectedRepositoryIds: ["1221250267"],
  });
  const repository = () =>
    createRepositoryObservation({
      ...observed.repository,
      installationIdentityDigest: installation.digest,
      releaseGate: { name: "REPOSITORY_RELEASE_ENABLED", configured: true },
    });
  const inspectDraftDestination = vi.fn<
    NonNullable<GitHubPublicationRuntime["inspectDraftDestination"]>
  >(
    async () =>
      await Promise.resolve({
        repository: repository(),
        installation,
        preTree: [],
        ownedCompletedPublication: publication,
      }),
  );
  let next = source("b");
  const reconcile = vi.fn(
    async (input: HostedTemplateFoundationInput): Promise<HostedTemplateFoundationResult> => {
      await input.assertCurrent();
      await input.reader?.acquire();
      const head = await input.readCanonicalHead?.("private-test-read-token");
      expect(head).toEqual({ sourceSha: next.sourceSha, sourceTree: next.sourceTree });
      await input.assertCurrent();
      return {
        changed: input.sourceReceipt.sourceSha !== next.sourceSha,
        sourceReceipt: next,
        workspace: workspace(next),
        provenance: {
          previousSourceReceiptDigest: input.sourceReceipt.digest,
          previousWorkspaceDigest: input.workspace.workspaceDigest,
          previousSourceSha: input.sourceReceipt.sourceSha,
          sourceSha: next.sourceSha,
          sourceTree: next.sourceTree,
          sourceSnapshotTree: next.sourceTree,
          checkpointRef: `refs/app-builder/source-checkpoints/${hash(sessionId)}`,
        },
      };
    },
  );
  const inspectSourceBranch = vi.fn<GitHubPublicationRuntime["inspectSourceBranch"]>(
    async () =>
      await Promise.resolve({
        branch: "main",
        headSha: observed.repository.headSha,
        headTree: observed.repository.headTree,
      }),
  );
  const ports = {
    access: { classify, acquireExistingSourceCredential },
    publication: { inspectDraftDestination, inspectSourceBranch },
    reconcile,
  };
  return {
    initial,
    publication,
    observed,
    installation,
    repository,
    cancellation,
    ctx,
    ports,
    setNext: (character: string) => {
      next = source(character);
      observed.repository.headSha = next.sourceSha;
      observed.repository.headTree = next.sourceTree;
    },
  };
};

const retainCandidate = async (f: ReturnType<typeof fixture>) => {
  const retained = await freshFixture();
  const origin = retained.candidate.publishedOrigin;
  if (origin === undefined) {
    throw new Error("Expected controlled provider-owned source");
  }
  const repair = createPublishedDraftRepairSource({
    appId,
    appSpecDigest: f.initial.appSpec.digest,
    originSourceReceiptDigest: f.initial.sourceReceipt.digest,
    publicationProposalDigest: f.publication.proposal.digest,
    publicationDigest: origin.publicationDigest,
    installationId: f.publication.installationId,
    source: origin.source,
    draft: origin.draft,
  });
  draftReconciliationState.update(() => ({
    kind: "published-draft-repair",
    repair,
    appId,
    version: 1,
    workspaceRoot: "/workspace",
    root: "/workspace/retained-delivered-candidate",
    repositoryId: repair.draft.repositoryId,
    pullRequestNumber: repair.draft.number,
    githubSourceDigest: repair.source.digest,
    originalReviewDigest: f.initial.reviewReceipt.digest,
    reviewedLineage: f.initial,
    baseSha: repair.draft.headSha,
    baseTree: repair.draft.headTree,
    headSha: repair.draft.headSha,
    headTree: repair.draft.headTree,
    conflicts: [],
    validation: {
      resolvedTree: repair.draft.headTree,
      commands: [{ command: "old-app-build", exitCode: 0 }],
      validatedByCallId: "old-candidate-validation",
    },
  }));
  expect(currentDraftCandidateSource(f.initial, draftReconciliationState.get())).toEqual(
    repair.source,
  );
};

describe("same delivered app source refresh", () => {
  it("keeps an acquired repository ready to plan and leaves source refresh to approved compilation", async () => {
    await within(async () => {
      const f = fixture();
      const connected = connectedFixture().reviewed;
      const acquire = vi.fn(f.ports.access.classify);
      defaultPorts.access = { ...f.ports.access, classify: acquire };
      appBuilderWorkflowState.update(() => connected);
      await expect(prepareApp.execute({ refreshSource: true }, f.ctx)).resolves.toMatchObject({
        appId: connected.appSpec.appId,
        status: "connected_source_retained",
      });
      expect(appBuilderWorkflowState.get()).toEqual(connected);
      expect(acquire).not.toHaveBeenCalled();
    });
  });

  it("handles current-source continuation through the normal preparation tool without asking for repository or database details", async () => {
    await within(async () => {
      const f = fixture();
      defaultPorts.access = f.ports.access;
      defaultPorts.publication = f.ports.publication;
      defaultPorts.reconcile.mockImplementation(f.ports.reconcile);
      await expect(prepareApp.execute({ refreshSource: true }, f.ctx)).resolves.toMatchObject({
        appId,
        status: "source_refreshed",
      });
      expect(appBuilderWorkflowState.get()).toHaveProperty(
        "sourceReceipt.sourceSha",
        "b".repeat(40),
      );
    });
  });
  it("refreshes the old snapshot without replacing app identity, original Build or destination, and retires old review", async () => {
    await within(async () => {
      const f = fixture();
      const authority = readPrivateApplyAuthority();
      await expect(refreshOwnedAppSource(f.ctx, f.ports)).resolves.toMatchObject({
        appId,
        status: "source_refreshed",
      });
      const updated = appBuilderWorkflowState.get();
      expect(updated).toMatchObject({
        phase: "applied",
        appSpec: f.initial.appSpec,
        artifacts: f.initial.artifacts,
        applyReceipt: f.initial.applyReceipt,
        identityReceipt: f.initial.identityReceipt,
        sourceReceipt: source("b"),
        publishedGitHubDraftProposalDigest: f.publication.proposal.digest,
      });
      expect(updated).not.toHaveProperty("githubSource");
      expect(updated).not.toHaveProperty("reviewReceipt");
      expect(updated).not.toHaveProperty("validationReceipt");
      expect(updated).not.toHaveProperty("githubDraftProposal");
      expect(readPrivateApplyAuthority()).toEqual(authority);
      expect(hostedTemplateFoundationRecoveryHistory.get()).toHaveLength(1);
      expect(JSON.stringify(updated)).not.toContain("private-test-read-token");
    });
  });

  it("retains a renamed delivery default branch while refreshing the recorded canonical main source", async () => {
    await within(async () => {
      const f = fixture();
      f.observed.repository.defaultBranch = "trunk";
      await expect(refreshOwnedAppSource(f.ctx, f.ports)).resolves.toHaveProperty(
        "status",
        "source_refreshed",
      );
      expect(repositoryAccessReceiptState.get()?.repository.defaultBranch).toBe("trunk");
      expect(appBuilderWorkflowState.get()).toHaveProperty(
        "sourceReceipt.provenance.ref",
        "refs/heads/main",
      );
    });
  });

  it.each(["reconnect", "cancel"] as const)(
    "does not overwrite access after a post-recovery %s race",
    async (kind) => {
      await within(async () => {
        const f = fixture();
        const originalUpdate = hostedTemplateFoundationRecoveryHistory.update.bind(
          hostedTemplateFoundationRecoveryHistory,
        );
        const spy = vi
          .spyOn(hostedTemplateFoundationRecoveryHistory, "update")
          .mockImplementationOnce((transition) => {
            originalUpdate(transition);
            queueMicrotask(() => {
              if (kind === "cancel") {
                f.cancellation.abort();
              } else {
                clearRepositoryAccess();
              }
            });
          });
        try {
          await expect(refreshOwnedAppSource(f.ctx, f.ports)).rejects.toThrow();
          expect(appBuilderWorkflowState.get()).toHaveProperty(
            "sourceReceipt.sourceSha",
            "b".repeat(40),
          );
          if (kind === "reconnect") {
            expect(repositoryAccessReceiptState.get()).toBeUndefined();
          } else {
            expect(repositoryAccessReceiptState.get()?.confirmedByCallId).toBe("store-in");
          }
        } finally {
          spy.mockRestore();
        }
      });
    },
  );

  it("preserves a legacy distinct authored apply root rather than silently replacing it with the baseline", async () => {
    await within(async () => {
      const f = fixture();
      const legacy = {
        ...f.initial,
        applyReceipt: { ...f.initial.applyReceipt, applyRoot: "/workspace/private-authored-app" },
      };
      appBuilderWorkflowState.update(() => legacy);
      await expect(refreshOwnedAppSource(f.ctx, f.ports)).rejects.toThrow(
        "approved app and workspace",
      );
      expect(appBuilderWorkflowState.get()).toEqual(legacy);
      expect(f.ports.reconcile).not.toHaveBeenCalled();
    });
  });

  it("keeps repeated refresh history linear and original ownership usable after a separately approved new revision", async () => {
    await within(async () => {
      const f = fixture();
      await retainCandidate(f);
      await refreshOwnedAppSource(f.ctx, f.ports);
      f.setNext("c");
      await refreshOwnedAppSource({ ...f.ctx, callId: "second-refresh" }, f.ports);
      const refreshed = appBuilderWorkflowState.get();
      if (refreshed.phase !== "applied") {
        throw new Error("Expected refreshed applied app");
      }
      expect(
        resolveHostedTemplateFoundationBinding(refreshed, sessionId)?.approvedSourceReceipt,
      ).toEqual(f.initial.sourceReceipt);
      expect(priorHostedTemplatePublication(refreshed, sessionId)).toEqual(f.publication);
      expect(
        currentDraftCandidateSource(refreshed, draftReconciliationState.get()),
      ).toBeUndefined();
      const rows = hostedTemplateFoundationRecoveryHistory.get();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => !("previousWorkflow" in row) && !("history" in row))).toBe(true);
      // A new app proposal never borrows the retained original Build grant.
      expect(() => {
        assertApprovedPrivateApplySession(grant("new-app-edit"));
      }).toThrow("approved build session");
      const current: Extract<AppBuilderWorkflowState, { phase: "validated" }> = {
        ...refreshed,
        phase: "validated",
        proposal: {
          ...refreshed.proposal,
          digest: "new-app-edit",
          target: { ...refreshed.proposal.target, operation: "iterate-existing-app" },
        },
        applyReceipt: {
          ...refreshed.applyReceipt,
          digest: "new-applied-edit",
          proposalDigest: "new-app-edit",
          sourceReceiptDigest: refreshed.sourceReceipt.digest,
        },
        validationReceipt: { ...f.initial.validationReceipt, digest: "new-source-validation" },
      };
      existingAppRepairHistory.update(() => [
        {
          requestDigest: "new-app-edit-request",
          proposalDigest: current.proposal.digest,
          sessionId,
          previousWorkflow: refreshed,
          approvedBase: refreshed,
        },
      ]);
      approve("new-app-edit");
      appBuilderWorkflowState.update(() => current);
      expect(() => {
        assertApprovedPrivateApplySession(grant());
      }).toThrow("approved build session");
      expect(priorOwnedAppDraftPublication(current, sessionId)).toMatchObject(f.publication);
      expect(appBuilderWorkflowState.get()).not.toHaveProperty("reviewReceipt");
      expect(appBuilderWorkflowState.get()).not.toHaveProperty("githubDraftProposal");
      expect(resolveDraftReviewedWorkflow(current, draftReconciliationState.get())).toBeUndefined();
      expect(currentDraftCandidateSource(current, draftReconciliationState.get())).toBeUndefined();
      expect(() => resolveHostedTemplateFoundationBinding(refreshed, sessionId)).toThrow(
        "approved build session",
      );
    });
  });

  it.each(["owner", "repository", "installation", "access-denied"] as const)(
    "does not refresh changed %s authority",
    async (kind) => {
      await within(async () => {
        const f = fixture();
        const ctx =
          kind === "owner"
            ? { ...f.ctx, session: { ...f.ctx.session, id: "another-session" } }
            : f.ctx;
        if (kind === "repository") {
          f.observed.repository.repositoryId = "999";
        }
        if (kind === "installation") {
          f.observed.scope.installationId = "99";
        }
        if (kind === "access-denied") {
          f.ports.access.classify.mockRejectedValue(new Error("read access denied"));
        }
        await expect(refreshOwnedAppSource(ctx, f.ports)).rejects.toThrow();
        expect(f.ports.reconcile).not.toHaveBeenCalled();
        expect(hostedTemplateFoundationRecoveryHistory.get()).toHaveLength(0);
        expect(appBuilderWorkflowState.get()).toEqual(f.initial);
      });
    },
  );

  it.each(["open-publication", "wrong-repository", "wrong-installation"] as const)(
    "does not adopt %s as source ownership",
    async (kind) => {
      await within(async () => {
        const f = fixture();
        f.ports.publication.inspectDraftDestination.mockImplementationOnce(async () => {
          await Promise.resolve();
          if (kind === "open-publication") {
            throw new Error("Use this app's existing open draft");
          }
          const owned = structuredClone(f.publication);
          if (kind === "wrong-repository") {
            owned.proposal.repositoryId = "999";
          }
          if (kind === "wrong-installation") {
            owned.installationId = "99";
          }
          return {
            repository: f.repository(),
            installation: f.installation,
            preTree: [],
            ownedCompletedPublication: owned,
          };
        });
        await expect(refreshOwnedAppSource(f.ctx, f.ports)).rejects.toThrow();
        expect(f.ports.reconcile).not.toHaveBeenCalled();
        expect(appBuilderWorkflowState.get()).toEqual(f.initial);
      });
    },
  );

  it.each(["cancelled", "concurrent-workflow", "concurrent-access"] as const)(
    "preserves saved work after %s during protected acquisition",
    async (kind) => {
      await within(async () => {
        const f = fixture();
        f.ports.access.acquireExistingSourceCredential.mockImplementationOnce(async () => {
          await Promise.resolve();
          if (kind === "cancelled") {
            f.cancellation.abort();
          }
          if (kind === "concurrent-workflow") {
            appBuilderWorkflowState.update(() => ({
              ...f.initial,
              preparedByCallId: "competing-turn",
            }));
          }
          if (kind === "concurrent-access") {
            clearRepositoryAccess();
          }
          return { token: "private-test-read-token" };
        });
        await expect(refreshOwnedAppSource(f.ctx, f.ports)).rejects.toThrow();
        expect(hostedTemplateFoundationRecoveryHistory.get()).toHaveLength(0);
        expect(appBuilderWorkflowState.get()).toHaveProperty("reviewReceipt");
      });
    },
  );

  it("does not fabricate historical ownership for an old-format source transition", async () => {
    await within(async () => {
      const f = fixture();
      await refreshOwnedAppSource(f.ctx, f.ports);
      const state = appBuilderWorkflowState.get();
      if (state.phase !== "applied") {
        throw new Error("Expected applied app");
      }
      hostedTemplateFoundationRecoveryHistory.update((rows) =>
        rows.map(({ publication: _unused, ...row }) => row),
      );
      expect(resolveHostedTemplateFoundationBinding(state, sessionId)).toBeDefined();
      expect(priorHostedTemplatePublication(state, sessionId)).toBeUndefined();
      await expect(refreshOwnedAppSource(f.ctx, f.ports)).resolves.toHaveProperty(
        "status",
        "source_unchanged",
      );
      expect(priorHostedTemplatePublication(state, sessionId)).toEqual(f.publication);
      expect(appBuilderWorkflowState.get()).not.toHaveProperty("reviewReceipt");
    });
  });

  it("rejects an interrupted or tampered chain without reviving old approval proofs", async () => {
    await within(async () => {
      const f = fixture();
      await refreshOwnedAppSource(f.ctx, f.ports);
      const state = appBuilderWorkflowState.get();
      if (state.phase !== "applied") {
        throw new Error("Expected applied app");
      }
      hostedTemplateFoundationRecoveryHistory.update((rows) =>
        rows.map((row) => ({
          ...row,
          provenance: { ...row.provenance, previousSourceSha: "f".repeat(40) },
        })),
      );
      expect(() => priorHostedTemplatePublication(state, sessionId)).toThrow(
        "completed source recovery",
      );
      expect(appBuilderWorkflowState.get()).not.toHaveProperty("reviewReceipt");
    });
  });
});
