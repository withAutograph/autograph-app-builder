/* oxlint-disable sonarjs/no-internal-api-use -- Real Eve context isolation reproduces workflow children without parent Builder state. */
import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepToolContext } from "eve/tools";
import type { HookContext, HookEvent } from "eve/hooks";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import continueApprovedBuild from "../../agent/hooks/continue-approved-build";
import {
  diagnosticBuildDecisionState,
  emitCurrentBuildWorkflowProjection,
  recordApprovedBuildDecision,
} from "./approved-build-continuation-runtime";
import {
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
  readPrivateApplyAuthority,
  retainPrivateApplyDenials,
} from "./private-apply-authority";
import { privateApplyDenialEvents } from "../eve/private-apply-denial.test-fixture";
import { observePrivateApplyDenials } from "../eve/private-apply-denial-evidence";
import {
  captureGitHubPrDeliveryAuthority,
  readGitHubPrDeliveryAuthority,
} from "./github-pr-delivery-authority";
import type { GitHubPrDeliveryOwnerSnapshot } from "./github-pr-delivery-authority";
import {
  captureGitHubPrDeliveryCallScope,
  currentGitHubPrDeliveryAuthorityProjection,
  githubPrDeliveryInputDigest,
} from "./github-pr-delivery-authority-state";
import { continueGitHubPrDeliveryWithPorts } from "./github-pr-delivery-execution";
import type { GitHubPrDeliveryStepPorts } from "./github-pr-delivery-execution";
import type { GitHubPrDeliveryApproval } from "./github-pr-delivery-approval";
import { createGitHubPrEffectReceipt } from "../repository/github-pr-effect-journal";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { managedProductionDeliveryRequirements } from "./production-delivery-requirement";
import { resolveGitHubProductionDeliveryReadiness } from "./github-production-delivery-readiness";

const sessionId = "owned-parent-session";
const appId = "control-notes";
const appSpecDigest = "a".repeat(64);
const readyAt = "2026-11-10T05:23:00Z";
const mergeCommitSha = "d".repeat(40);
const target = {
  baseBranch: "main",
  headSha: "b".repeat(40),
  name: "controlled-repository",
  owner: "controlled-owner",
  pullRequestNumber: 17,
  repositoryId: "100",
};
const approval: GitHubPrDeliveryApproval = {
  ...target,
  installationId: "10",
  proposalDigest: "c".repeat(64),
};
const managed = {
  appId,
  repositoryId: target.repositoryId,
  repositoryFullName: `${target.owner}/${target.name}`,
  operationRef: "retained-managed-setup",
};
const unavailable = (): never => {
  throw new Error("Unexpected external operation");
};
const context = (controller = new AbortController()): WorkflowStepToolContext => ({
  abortSignal: controller.signal,
  callId: "approved-parent-delivery-call",
  getToken: unavailable,
  requireAuth: unavailable,
  session: {
    id: sessionId,
    ownerRunId: "owned-parent-worker",
    ownerAnchorRunId: sessionId,
    auth: { current: null, initiator: null },
    turn: { id: "parent-turn", sequence: 3 },
  },
  toolName: "finish-github-pr-delivery",
});

const installReviewedParent = (input: GitHubPrDeliveryApproval, managedSetup: boolean) => {
  // SAFETY: These are the parent workflow fields consumed by the real reviewed-
  // publication resolver and lifecycle observer; external execution stays controlled.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled fixture includes only the source-owned fields read by the publication resolver.
  const state = {
    version: APP_BUILDER_WORKFLOW_VERSION,
    phase: "reviewed",
    appSpec: { appId, digest: appSpecDigest },
    workspace: { workspaceId: "owned-sandbox" },
    proposal: { digest: "9".repeat(64) },
    reviewReceipt: { digest: "e".repeat(64) },
    githubDraftProposal: { proposal: { digest: input.proposalDigest } },
    githubDestinationReview: { installation: { installationId: input.installationId } },
  } as Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
  appBuilderWorkflowState.update(() => state);
  managedProductionDeliveryRequirements.update(() => (managedSetup ? [managed] : []));
};

const approveCurrentBuild = () => {
  const state = appBuilderWorkflowState.get();
  if (!("proposal" in state)) {
    throw new Error("Missing controlled Build proposal");
  }
  const scope = {
    appId: state.appSpec.appId,
    appSpecDigest: state.appSpec.digest,
    proposalDigest: state.proposal.digest,
    sessionId,
    workspaceId: state.workspace.workspaceId,
  };
  requestPrivateApplyApproval(scope, "actual-approved-build");
  recordApprovedPrivateApply(scope, "actual-approved-build");
};

const replaceCurrentProposal = () => {
  const state = appBuilderWorkflowState.get();
  if (state.phase !== "reviewed") {
    throw new Error("Missing controlled reviewed app");
  }
  appBuilderWorkflowState.update(() => ({
    ...state,
    proposal: { ...state.proposal, digest: "5".repeat(64) },
  }));
};

const capturedParent = (input = approval, managedSetup = false) =>
  contextStorage.run(new ContextContainer(), () => {
    installReviewedParent(input, managedSetup);
    const ctx = context();
    const owner = {
      ownerKey: "fixture-owner",
      adapterSessionId: sessionId,
      adapterGeneration: 1,
      cancellationRevision: 0,
    };
    captureGitHubPrDeliveryCallScope(input, ctx.callId, owner, ctx.session.turn);
    const snapshot: GitHubPrDeliveryOwnerSnapshot = {
      owner,
      decision: {
        adapterSessionId: sessionId,
        currentSpec: { appId, appSpecDigest, sessionId, workspaceId: "owned-sandbox" },
        decision: "settled",
        githubDelivery: currentGitHubPrDeliveryAuthorityProjection(),
        turnId: ctx.session.turn.id,
        turnSequence: ctx.session.turn.sequence,
        version: 1,
        workflowPhase: "reviewed",
      },
    };
    return { ctx, snapshot: structuredClone(snapshot) };
  });

const delivery = (snapshot: GitHubPrDeliveryOwnerSnapshot, alreadyReady = false) => {
  let checksPassed = false;
  let liveHead = target.headSha;
  let liveReadyAt = readyAt;
  const effects: {
    kind: "pr-ready" | "pr-merge";
    approvedByCallId: string;
    headSha: string;
    readyAt?: string;
  }[] = [];
  const ports: GitHubPrDeliveryStepPorts = {
    readAuthority: async (input, ctx) =>
      await readGitHubPrDeliveryAuthority(input, ctx, async () => await Promise.resolve(snapshot)),
    runtime: async () =>
      await Promise.resolve({
        inspectPublishedPullRequest: async () =>
          await Promise.resolve({
            ...target,
            checks: checksPassed ? ("passed" as const) : ("pending" as const),
            draft: !alreadyReady && effects.length === 0,
            headSha: liveHead,
            readyAt: liveReadyAt,
            reviewedRevision: liveHead === target.headSha,
            reviewedTarget: target,
            state: "open" as const,
          }),
        runPublishedPullRequestEffect: async (input) => {
          const effect = {
            kind: input.kind,
            approvedByCallId: input.approvedByCallId,
            headSha: input.reviewedTarget.headSha,
          };
          effects.push(input.kind === "pr-merge" ? { ...effect, readyAt: input.readyAt } : effect);
          const common = {
            ...target,
            installationIdentityDigest: "f".repeat(64),
            publicationDigest: approval.proposalDigest,
          };
          return await Promise.resolve(
            input.kind === "pr-ready"
              ? createGitHubPrEffectReceipt({
                  intent: { ...common, kind: "pr-ready" },
                  approvedByCallId: input.approvedByCallId,
                  status: "succeeded",
                  evidence: { kind: "pr-ready", readyAt },
                })
              : createGitHubPrEffectReceipt({
                  intent: { ...common, kind: "pr-merge", readyAt: input.readyAt },
                  approvedByCallId: input.approvedByCallId,
                  status: "succeeded",
                  evidence: { kind: "pr-merge", mergeCommitSha },
                }),
          );
        },
      }),
    readProduction: async (selected, _ctx, projection) =>
      await resolveGitHubProductionDeliveryReadiness({
        target: selected,
        operatorConfigured: false,
        requirements: projection?.requirements ?? [],
        read: unavailable,
        retain: unavailable,
      }),
  };
  return {
    effects,
    ports,
    pass: () => {
      checksPassed = true;
    },
    moveHead: () => {
      liveHead = "f".repeat(40);
    },
    moveReadyCycle: () => {
      liveReadyAt = "2026-11-10T05:45:00Z";
    },
  };
};

describe("GitHub delivery authority across workflow child contexts", () => {
  it.each(["missing", "stale-adapter"] as const)(
    "captures a first Ready call from the actual approved Build with a %s prior projection",
    async (prior) => {
      await contextStorage.run(new ContextContainer(), async () => {
        installReviewedParent(approval, true);
        approveCurrentBuild();
        const ctx = context();
        const owner = {
          ownerKey: "fixture-owner",
          adapterSessionId: sessionId,
          adapterGeneration: 2,
          cancellationRevision: 0,
        };
        let decision = prior === "missing" ? undefined : capturedParent().snapshot.decision;
        if (decision !== undefined) {
          decision.adapterSessionId = "previous-physical-adapter";
        }
        const readOwner = async (): Promise<GitHubPrDeliveryOwnerSnapshot> => {
          if (decision === undefined || decision.adapterSessionId !== owner.adapterSessionId) {
            throw new Error("The prior parent projection is unavailable");
          }
          return await Promise.resolve({ owner, decision });
        };
        const ports = {
          readOwnerBinding: async () => await Promise.resolve(owner),
          readOwner,
          persist: async () => {
            await emitCurrentBuildWorkflowProjection(ctx);
            const current = diagnosticBuildDecisionState.get();
            if (current === null) {
              throw new Error("The parent did not persist its actual current projection");
            }
            decision = current;
          },
        };
        await captureGitHubPrDeliveryAuthority(approval, ctx, ports);
        const durable = await readOwner();
        await contextStorage.run(new ContextContainer(), async () => {
          const current = await readGitHubPrDeliveryAuthority(approval, ctx, readOwner);
          expect(current.subject).toMatchObject({ appId, appSpecDigest });
          expect(current.requirements).toContainEqual(managed);
          expect(appBuilderWorkflowState.get().phase).toBe("empty");
        });
        expect(durable.decision.githubDelivery?.calls).toMatchObject([
          { callId: ctx.callId, owner, inputDigest: githubPrDeliveryInputDigest(approval) },
        ]);
      });
    },
  );

  it.each(["missing", "app", "spec", "proposal", "session", "workspace"] as const)(
    "does not bootstrap Ready from a missing or foreign %s Build grant",
    async (binding) => {
      await contextStorage.run(new ContextContainer(), async () => {
        installReviewedParent(approval, false);
        const ctx = context();
        if (binding !== "missing") {
          const grant = {
            appId,
            appSpecDigest,
            proposalDigest: "9".repeat(64),
            sessionId,
            workspaceId: "owned-sandbox",
          };
          if (binding === "app") {
            grant.appId = "other-app";
          }
          if (binding === "spec") {
            grant.appSpecDigest = "8".repeat(64);
          }
          if (binding === "proposal") {
            grant.proposalDigest = "7".repeat(64);
          }
          if (binding === "session") {
            grant.sessionId = "other-session";
          }
          if (binding === "workspace") {
            grant.workspaceId = "other-workspace";
          }
          requestPrivateApplyApproval(grant, "foreign-approved-build");
          recordApprovedPrivateApply(grant, "foreign-approved-build");
        }
        let persists = 0;
        const f = capturedParent();
        const ports = {
          readOwnerBinding: async () => await Promise.resolve(f.snapshot.owner),
          readOwner: async () => await Promise.resolve(f.snapshot),
          persist: async () => {
            persists += 1;
            await Promise.resolve();
          },
        };
        await expect(captureGitHubPrDeliveryAuthority(approval, ctx, ports)).rejects.toMatchObject({
          reason: "build-approval-unavailable",
        });
        expect(persists).toBe(0);
        expect(currentGitHubPrDeliveryAuthorityProjection().calls).toEqual([]);
      });
    },
  );

  it("does not transfer an older Build approval to a denied successor proposal", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      installReviewedParent(approval, false);
      approveCurrentBuild();
      const priorGrant = readPrivateApplyAuthority().grant;
      const state = appBuilderWorkflowState.get();
      if (state.phase !== "reviewed") {
        throw new Error("Missing controlled reviewed app");
      }
      appBuilderWorkflowState.update(() => ({
        ...state,
        proposal: { ...state.proposal, digest: "6".repeat(64) },
      }));
      const nextScope = { ...priorGrant, proposalDigest: "6".repeat(64) };
      if (priorGrant === null) {
        throw new Error("Missing actual original Build approval");
      }
      requestPrivateApplyApproval({ ...priorGrant, ...nextScope }, "denied-successor-build");
      retainPrivateApplyDenials({
        expected: readPrivateApplyAuthority(),
        proofs: observePrivateApplyDenials({
          sessionId,
          calls: ["denied-successor-build"],
          events: privateApplyDenialEvents("denied-successor-build"),
        }),
      });
      expect(readPrivateApplyAuthority()).toMatchObject({ grant: priorGrant, pending: [] });
      const f = capturedParent();
      let persists = 0;
      const ports = {
        readOwnerBinding: async () => await Promise.resolve(f.snapshot.owner),
        readOwner: async () => await Promise.resolve(f.snapshot),
        persist: async () => {
          persists += 1;
          await Promise.resolve();
        },
      };
      await expect(
        captureGitHubPrDeliveryAuthority(approval, context(), ports),
      ).rejects.toMatchObject({
        reason: "build-approval-unavailable",
      });
      expect(persists).toBe(0);
    });
  });

  it("retains the actual approval refusal if diagnostic delivery fails", async () => {
    const logger = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("Diagnostic sink unavailable");
    });
    try {
      await contextStorage.run(new ContextContainer(), async () => {
        installReviewedParent(approval, false);
        const f = capturedParent();
        await expect(captureGitHubPrDeliveryAuthority(approval, f.ctx)).rejects.toMatchObject({
          reason: "build-approval-unavailable",
        });
      });
    } finally {
      logger.mockRestore();
    }
  });

  it("honors cancellation during the canonical owner read before persisting a Ready call", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      installReviewedParent(approval, false);
      approveCurrentBuild();
      const controller = new AbortController();
      const ctx = context(controller);
      const cancelled = new Error("Actual native cancellation");
      const f = capturedParent();
      let persists = 0;
      const ports = {
        readOwnerBinding: async () => {
          controller.abort(cancelled);
          return await Promise.resolve(f.snapshot.owner);
        },
        readOwner: async () => await Promise.resolve(f.snapshot),
        persist: async () => {
          persists += 1;
          await Promise.resolve();
        },
      };
      await expect(captureGitHubPrDeliveryAuthority(approval, ctx, ports)).rejects.toBe(cancelled);
      expect(persists).toBe(0);
      expect(currentGitHubPrDeliveryAuthorityProjection().calls).toEqual([]);
    });
  });

  it.each(["owner", "worker", "generation", "stop"] as const)(
    "does not offer Ready approval when the canonical %s changes during persistence",
    async (binding) => {
      await contextStorage.run(new ContextContainer(), async () => {
        installReviewedParent(approval, false);
        approveCurrentBuild();
        const f = capturedParent();
        const before = structuredClone(f.snapshot.owner);
        const ports = {
          readOwnerBinding: async () => await Promise.resolve(before),
          readOwner: async () => await Promise.resolve(f.snapshot),
          persist: async () => {
            if (binding === "owner") {
              f.snapshot.owner.ownerKey = "different-owner";
            }
            if (binding === "worker") {
              f.snapshot.owner.adapterSessionId = "different-worker";
            }
            if (!("adapterGeneration" in f.snapshot.owner)) {
              throw new Error("Expected hosted owner");
            }
            if (binding === "generation") {
              f.snapshot.owner.adapterGeneration += 1;
            }
            if (binding === "stop") {
              f.snapshot.owner.cancellationRevision += 1;
            }
            await Promise.resolve();
          },
        };
        await expect(
          captureGitHubPrDeliveryAuthority(approval, f.ctx, ports),
        ).rejects.toMatchObject({
          reason: "owner-changed",
        });
      });
    },
  );

  it.each(["owner-read", "persist"] as const)(
    "does not transfer Ready capture to an unapproved successor during %s",
    async (boundary) => {
      await contextStorage.run(new ContextContainer(), async () => {
        installReviewedParent(approval, false);
        approveCurrentBuild();
        const f = capturedParent();
        let persists = 0;
        const ports = {
          readOwnerBinding: async () => {
            if (boundary === "owner-read") {
              replaceCurrentProposal();
            }
            return await Promise.resolve(f.snapshot.owner);
          },
          readOwner: async () => await Promise.resolve(f.snapshot),
          persist: async () => {
            persists += 1;
            replaceCurrentProposal();
            await Promise.resolve();
          },
        };
        await expect(
          captureGitHubPrDeliveryAuthority(approval, f.ctx, ports),
        ).rejects.toMatchObject({
          reason: "build-approval-unavailable",
        });
        expect(persists).toBe(boundary === "owner-read" ? 0 : 1);
      });
    },
  );

  it("rechecks the persisted current review before requesting actual Ready approval", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      installReviewedParent(approval, false);
      approveCurrentBuild();
      const f = capturedParent();
      const ports = {
        readOwnerBinding: async () => await Promise.resolve(f.snapshot.owner),
        readOwner: async () => await Promise.resolve(f.snapshot),
        persist: async () => {
          const state = appBuilderWorkflowState.get();
          if (state.phase !== "reviewed") {
            throw new Error("Missing controlled reviewed app");
          }
          appBuilderWorkflowState.update(() => ({
            ...state,
            reviewReceipt: { ...state.reviewReceipt, digest: "4".repeat(64) },
          }));
          await emitCurrentBuildWorkflowProjection(f.ctx);
          const current = diagnosticBuildDecisionState.get();
          if (current === null) {
            throw new Error("Missing actual persisted projection");
          }
          f.snapshot.decision = current;
        },
      };
      await expect(captureGitHubPrDeliveryAuthority(approval, f.ctx, ports)).rejects.toMatchObject({
        reason: "captured-call-mismatch",
      });
    });
  });

  it("marks Ready then merges the same approved revision after checks without parent Builder state", async () => {
    const f = capturedParent();
    const run = delivery(f.snapshot);
    await contextStorage.run(new ContextContainer(), async () => {
      expect(appBuilderWorkflowState.get().phase).toBe("empty");
      expect(currentGitHubPrDeliveryAuthorityProjection().current).toBeNull();
      expect(
        await continueGitHubPrDeliveryWithPorts(approval, f.ctx, undefined, run.ports),
      ).toEqual({ status: "waiting-for-checks", readyAt });
      run.pass();
      expect(await continueGitHubPrDeliveryWithPorts(approval, f.ctx, readyAt, run.ports)).toEqual({
        status: "merged",
        mergeCommitSha,
      });
      expect(appBuilderWorkflowState.get().phase).toBe("empty");
    });
    expect(run.effects).toEqual([
      { kind: "pr-ready", approvedByCallId: f.ctx.callId, headSha: target.headSha },
      { kind: "pr-merge", approvedByCallId: f.ctx.callId, headSha: target.headSha, readyAt },
    ]);
    expect(f.snapshot.decision.githubDelivery?.calls).toHaveLength(1);
  });

  it("continues one newly approved call for an already Ready PR without another capture", async () => {
    const input = { ...approval, readyAt };
    const f = capturedParent(input);
    const run = delivery(f.snapshot, true);
    await contextStorage.run(new ContextContainer(), async () => {
      expect(await continueGitHubPrDeliveryWithPorts(input, f.ctx, undefined, run.ports)).toEqual({
        status: "waiting-for-checks",
        readyAt,
      });
      expect(await continueGitHubPrDeliveryWithPorts(input, f.ctx, readyAt, run.ports)).toEqual({
        status: "waiting-for-checks",
        readyAt,
      });
      run.pass();
      expect(await continueGitHubPrDeliveryWithPorts(input, f.ctx, readyAt, run.ports)).toEqual({
        status: "merged",
        mergeCommitSha,
      });
    });
    expect(run.effects).toEqual([
      { kind: "pr-merge", approvedByCallId: f.ctx.callId, headSha: target.headSha, readyAt },
    ]);
    expect(f.snapshot.decision.githubDelivery?.calls).toHaveLength(1);
  });

  it.each(["publication", "reconciliation", "app", "spec", "review"] as const)(
    "refuses a changed current %s before effects",
    async (field) => {
      const f = capturedParent();
      const projection = f.snapshot.decision.githubDelivery;
      if (projection?.current === null || projection === undefined) {
        throw new Error("Missing controlled current publication");
      }
      if (field === "publication") {
        projection.current.proposalDigest = "1".repeat(64);
      }
      if (field === "reconciliation") {
        projection.current.reconciliationDigest = "2".repeat(64);
      }
      if (field === "app") {
        projection.current.appId = "another-app";
      }
      if (field === "spec") {
        projection.current.appSpecDigest = "3".repeat(64);
      }
      if (field === "review") {
        projection.current.reviewDigest = "4".repeat(64);
      }
      const run = delivery(f.snapshot);
      await contextStorage.run(new ContextContainer(), async () => {
        await expect(
          continueGitHubPrDeliveryWithPorts(approval, f.ctx, readyAt, run.ports),
        ).rejects.toThrow();
      });
      expect(run.effects).toHaveLength(0);
    },
  );

  it.each([
    "call",
    "input",
    "owner",
    "worker",
    "generation",
    "stop",
    "session",
    "turn",
    "turn-sequence",
    "missing-capture",
    "legacy",
  ] as const)("refuses a foreign or changed %s binding", async (field) => {
    const f = capturedParent();
    let input = approval;
    if (field === "call") {
      f.ctx = { ...f.ctx, callId: "another-call" };
    }
    if (field === "input") {
      input = { ...approval, headSha: "5".repeat(40) };
    }
    if (field === "owner") {
      f.snapshot.owner.ownerKey = "foreign-owner";
    }
    if (field === "worker") {
      f.snapshot.owner.adapterSessionId = "foreign-worker";
    }
    if (field === "generation") {
      if (!("adapterGeneration" in f.snapshot.owner)) {
        throw new Error("Expected controlled hosted owner");
      }
      f.snapshot.owner.adapterGeneration += 1;
    }
    if (field === "stop") {
      if (!("cancellationRevision" in f.snapshot.owner)) {
        throw new Error("Expected controlled hosted owner");
      }
      f.snapshot.owner.cancellationRevision += 1;
    }
    if (field === "session") {
      f.ctx = { ...f.ctx, session: { ...f.ctx.session, id: "foreign-session" } };
    }
    if (field === "turn") {
      f.ctx = {
        ...f.ctx,
        session: { ...f.ctx.session, turn: { ...f.ctx.session.turn, id: "another-turn" } },
      };
    }
    if (field === "turn-sequence") {
      f.ctx = {
        ...f.ctx,
        session: {
          ...f.ctx.session,
          turn: { ...f.ctx.session.turn, sequence: f.ctx.session.turn.sequence + 1 },
        },
      };
    }
    if (field === "missing-capture") {
      const projection = f.snapshot.decision.githubDelivery;
      if (projection === undefined) {
        throw new Error("Missing controlled projection");
      }
      projection.calls = [];
    }
    if (field === "legacy") {
      delete f.snapshot.decision.githubDelivery;
    }
    const run = delivery(f.snapshot);
    await contextStorage.run(new ContextContainer(), async () => {
      await expect(
        continueGitHubPrDeliveryWithPorts(input, f.ctx, readyAt, run.ports),
      ).rejects.toThrow();
    });
    expect(run.effects).toHaveLength(0);
  });

  it("retains the known managed requirement when its later projection loses the marker", async () => {
    const f = capturedParent(approval, true);
    const projection = f.snapshot.decision.githubDelivery;
    if (projection === undefined) {
      throw new Error("Missing controlled projection");
    }
    projection.requirements = [];
    const run = delivery(f.snapshot, true);
    run.pass();
    await contextStorage.run(new ContextContainer(), async () => {
      expect(managedProductionDeliveryRequirements.get()).toEqual([]);
      const authority = await readGitHubPrDeliveryAuthority(
        approval,
        f.ctx,
        async () => await Promise.resolve(f.snapshot),
      );
      expect(authority.requirements).toContainEqual(managed);
      await expect(
        continueGitHubPrDeliveryWithPorts(approval, f.ctx, readyAt, run.ports),
      ).rejects.toThrow();
    });
    expect(run.effects).toHaveLength(0);
  });

  it.each(["head", "ready-cycle"] as const)("does not merge a moved live %s", async (field) => {
    const f = capturedParent();
    const run = delivery(f.snapshot, true);
    run.pass();
    if (field === "head") {
      run.moveHead();
    } else {
      run.moveReadyCycle();
    }
    await contextStorage.run(new ContextContainer(), async () => {
      const result = await continueGitHubPrDeliveryWithPorts(approval, f.ctx, readyAt, run.ports);
      expect(result.status).toBe(field === "head" ? "revision-changed" : "ready-cycle-changed");
    });
    expect(run.effects).toHaveLength(0);
  });

  it("propagates cancellation before any Ready or merge effect", async () => {
    const f = capturedParent();
    const controller = new AbortController();
    controller.abort();
    const run = delivery(f.snapshot);
    await contextStorage.run(new ContextContainer(), async () => {
      await expect(
        continueGitHubPrDeliveryWithPorts(
          approval,
          { ...f.ctx, abortSignal: controller.signal },
          undefined,
          run.ports,
        ),
      ).rejects.toThrow();
    });
    expect(run.effects).toHaveLength(0);
  });

  it("persists parent call facts before a fresh child can read the captured scope", async () => {
    const f = capturedParent();
    const original = f.snapshot.decision.githubDelivery;
    if (original === undefined) {
      throw new Error("Missing controlled projection");
    }
    f.snapshot.decision.githubDelivery = { ...original, calls: [] };
    await contextStorage.run(new ContextContainer(), async () => {
      installReviewedParent(approval, false);
      approveCurrentBuild();
      await captureGitHubPrDeliveryAuthority(approval, f.ctx, {
        readOwner: async () => await Promise.resolve(f.snapshot),
        persist: async () => {
          f.snapshot.decision.githubDelivery = currentGitHubPrDeliveryAuthorityProjection();
          await Promise.resolve();
        },
      });
    });
    await contextStorage.run(new ContextContainer(), async () => {
      const authority = await readGitHubPrDeliveryAuthority(
        approval,
        f.ctx,
        async () => await Promise.resolve(f.snapshot),
      );
      expect(authority.subject).toMatchObject({
        appId,
        appSpecDigest,
        proposalDigest: approval.proposalDigest,
      });
      expect(appBuilderWorkflowState.get().phase).toBe("empty");
    });
  });

  it("clears persisted delivery authority when a real parent hook observes an empty workflow", async () => {
    const f = capturedParent();
    const snapshot = await contextStorage.run(new ContextContainer(), async () => {
      installReviewedParent(approval, false);
      captureGitHubPrDeliveryCallScope(
        approval,
        f.ctx.callId,
        f.snapshot.owner,
        f.ctx.session.turn,
      );
      await recordApprovedBuildDecision(f.ctx, f.snapshot.decision);
      const before = diagnosticBuildDecisionState.get();
      expect(before?.githubDelivery?.current).toMatchObject({
        appId,
        appSpecDigest,
        proposalDigest: approval.proposalDigest,
      });
      appBuilderWorkflowState.update(() => ({
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "empty",
      }));
      const hookContext: HookContext = {
        session: f.ctx.session,
        getSandbox: unavailable,
        agent: { name: "controlled-builder" },
        channel: { kind: "eve" },
        cancel: unavailable,
      };
      const event: HookEvent<"action.result"> = {
        type: "action.result",
        meta: { id: "clear-reviewed-publication", at: "2026-11-10T06:00:00Z" },
        data: {
          turnId: f.ctx.session.turn.id,
          sequence: f.ctx.session.turn.sequence,
          stepIndex: 1,
          status: "completed",
          result: {
            kind: "tool-result",
            callId: "controlled-source-transition",
            toolName: "controlled-source-transition",
            output: { status: "cleared" },
          },
        },
      };
      const observe = continueApprovedBuild.events?.["action.result"];
      if (observe === undefined) {
        throw new Error("The parent action-result observer is unavailable");
      }
      await observe(event, hookContext);
      const decision = diagnosticBuildDecisionState.get();
      if (decision === null) {
        throw new Error("The parent did not retain its current authority projection");
      }
      return { owner: f.snapshot.owner, decision };
    });
    const run = delivery(snapshot, true);
    run.pass();
    await contextStorage.run(new ContextContainer(), async () => {
      await expect(
        continueGitHubPrDeliveryWithPorts(approval, f.ctx, readyAt, run.ports),
      ).rejects.toThrow();
    });
    expect(run.effects).toHaveLength(0);
  });

  it.each(["cancelled", "failed"] as const)(
    "persists actual %s turn evidence without confusing failure with Stop",
    async (outcome) => {
      const f = capturedParent();
      const localOwner = {
        kind: "local" as const,
        ownerKey: "owned-local-runtime",
        adapterSessionId: sessionId,
      };
      const otherCtx: WorkflowStepToolContext = {
        ...f.ctx,
        callId: "another-turn-delivery-call",
        session: { ...f.ctx.session, turn: { id: "unrelated-turn", sequence: 4 } },
      };
      const snapshot = await contextStorage.run(new ContextContainer(), async () => {
        installReviewedParent(approval, false);
        captureGitHubPrDeliveryCallScope(approval, f.ctx.callId, localOwner, f.ctx.session.turn);
        captureGitHubPrDeliveryCallScope(
          approval,
          otherCtx.callId,
          localOwner,
          otherCtx.session.turn,
        );
        await recordApprovedBuildDecision(f.ctx, f.snapshot.decision);
        const hookContext: HookContext = {
          session: f.ctx.session,
          getSandbox: unavailable,
          agent: { name: "controlled-builder" },
          channel: { kind: "eve" },
          cancel: unavailable,
        };
        if (outcome === "cancelled") {
          const observe = continueApprovedBuild.events?.["turn.cancelled"];
          if (observe === undefined) {
            throw new Error("The native cancellation observer is unavailable");
          }
          await observe(
            {
              type: "turn.cancelled",
              meta: { id: "native-turn-cancelled", at: "2026-11-10T06:02:00Z" },
              data: { turnId: f.ctx.session.turn.id, sequence: f.ctx.session.turn.sequence },
            },
            hookContext,
          );
        } else {
          const failedStep = continueApprovedBuild.events?.["step.failed"];
          const failedTurn = continueApprovedBuild.events?.["turn.failed"];
          if (failedStep === undefined || failedTurn === undefined) {
            throw new Error("The native failure observers are unavailable");
          }
          const failure = {
            code: "MODEL_CALL_FAILED",
            message: "Controlled model step failed",
            sequence: f.ctx.session.turn.sequence,
            turnId: f.ctx.session.turn.id,
          };
          await failedStep(
            {
              type: "step.failed",
              meta: { id: "native-step-failed", at: "2026-11-10T06:02:00Z" },
              data: { ...failure, stepIndex: 1 },
            },
            hookContext,
          );
          await failedTurn(
            {
              type: "turn.failed",
              meta: { id: "native-turn-failed", at: "2026-11-10T06:02:01Z" },
              data: failure,
            },
            hookContext,
          );
        }
        expect(appBuilderWorkflowState.get().phase).toBe("reviewed");
        const decision = diagnosticBuildDecisionState.get();
        if (decision === null) {
          throw new Error("The parent turn evidence was not persisted");
        }
        return { owner: localOwner, decision };
      });
      await contextStorage.run(new ContextContainer(), async () => {
        expect(f.ctx.abortSignal.aborted).toBe(false);
        const readOwner = async () => await Promise.resolve(snapshot);
        if (outcome === "cancelled") {
          const run = delivery(snapshot, true);
          run.pass();
          await expect(
            continueGitHubPrDeliveryWithPorts(approval, f.ctx, readyAt, run.ports),
          ).rejects.toThrow();
          expect(run.effects).toHaveLength(0);
        } else {
          const retained = await readGitHubPrDeliveryAuthority(approval, f.ctx, readOwner);
          expect(retained.subject).toMatchObject({
            appId,
            proposalDigest: approval.proposalDigest,
          });
        }
        const unrelated = await readGitHubPrDeliveryAuthority(approval, otherCtx, readOwner);
        expect(unrelated.subject).toMatchObject({ appId, proposalDigest: approval.proposalDigest });
      });
    },
  );

  it("rejects a changed parent owner while capturing scope without treating it as approval", async () => {
    await contextStorage.run(new ContextContainer(), async () => {
      installReviewedParent(approval, false);
      approveCurrentBuild();
      const f = capturedParent();
      let reads = 0;
      let persists = 0;
      await expect(
        captureGitHubPrDeliveryAuthority(approval, f.ctx, {
          readOwner: async () => {
            reads += 1;
            return await Promise.resolve({
              ...f.snapshot,
              owner: { ...f.snapshot.owner, adapterGeneration: reads },
            });
          },
          persist: async () => {
            persists += 1;
            await Promise.resolve();
          },
        }),
      ).rejects.toThrow();
      expect(persists).toBe(1);
    });
  });
});
