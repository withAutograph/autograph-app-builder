/* oxlint-disable anti-slop/no-module-mocking -- Isolate existing planning I/O ports; execute the real fresh/reused producer and real pure projection. */
/* oxlint-disable anti-slop/no-chained-type-assertions -- Deliberately partial producer fixtures omit unrelated receipt/context internals; all effect ports are isolated. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- Producer fixtures model only consumed immutable fields; all effect ports are unavailable. */
/* oxlint-disable sonarjs/no-internal-api-use -- Exercise the installed Eve state only in tests. */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { prepareAppCreation } from "./prepare-app-creation";
import {
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
  readPrivateApplyAuthority,
  retainPrivateApplyDenials,
} from "./private-apply-authority";
import { inspectExistingAppRepair, existingAppRepairHistory } from "./existing-app-repair-planning";
import { privateComputeProjection } from "./private-compute-planning";
import type { preparePrivateComputePlanning } from "./private-compute-planning";
import { appBuilderWorkflowState } from "./workflow-state";
import { implementationFilesSchema } from "./apply-implementation-files";
import type { AppBuilderWorkflowState } from "./workflow-state";
import {
  PRIVATE_COMPUTE_CHECK_TASK,
  privateComputeProfileSchema,
} from "../sandbox/private-compute-profile";
import { BUILD_READY_APP_SPEC } from "../../evals/support/app-spec";

const ports = vi.hoisted(() => ({
  profile: vi.fn(),
  execute: vi.fn(),
  readBinary: vi.fn(),
  run: vi.fn(),
}));
const repairSandbox = { id: "workspace", readBinaryFile: ports.readBinary, run: ports.run };
vi.mock("./refresh-planning-source", () => ({
  refreshPlanningSource: () => Promise.resolve(repairSandbox),
}));
vi.mock("./target-dependency-preparation", () => ({
  prepareOrReuseDependencies: () =>
    Promise.resolve({ state: appBuilderWorkflowState.get(), sandbox: repairSandbox }),
}));
vi.mock("./private-compute-planning", async (importOriginal) => ({
  ...(await importOriginal<{
    privateComputeProjection: typeof privateComputeProjection;
    preparePrivateComputePlanning: typeof preparePrivateComputePlanning;
  }>()),
  preparePrivateComputePlanning: ports.profile,
}));
vi.mock("../repository/target-planning", () => ({
  targetExecutionBinding: () => ({
    fixture: true,
    dependencyCacheDigest: "cache",
    imageDigest: "image",
  }),
  fixtureTargetCommandExecutor: () => ({}),
  sandboxTargetCommandExecutor: () => ({}),
  executeTargetIdentityAndPlanning: async (input: {
    onIdentity: (identity: { appId: string; workspacePath: string }) => void | Promise<void>;
  }) => {
    await input.onIdentity({ appId: "example", workspacePath: "apps/example" });
    const result: unknown = await ports.execute(input);
    return result;
  },
}));
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");
const profile = () =>
  privateComputeProfileSchema.parse({
    version: 1,
    id: "private-checks-16gib-v1",
    vcpus: 8,
    memoryMiB: 16_384,
    lintWorkers: 1,
    target: { sandboxId: "workspace", workspaceDrive: "same-drive" },
    checkPolicy: {
      path: "apps/example/.config/mise/tasks/check",
      beforeSha256: "a".repeat(64),
      afterSha256: sha256(PRIVATE_COMPUTE_CHECK_TASK),
    },
    limits: {
      version: 1,
      teamId: "team_owned",
      projectId: "prj_owned",
      plan: "pro",
      maxVcpus: 8,
      limited: false,
      observedAt: "2026-11-03T12:00:00.000Z",
    },
  });
const fixture = (phase: "planned" | "identity_resolved", compute = profile()) =>
  // SAFETY: The real producer consumes these immutable state fields; unrelated receipt internals are opaque test sentinels and no provider or filesystem port is available.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the explicit consumed receipt fields are modeled; unavailable execution ports cannot perform effects.
  ({
    version: 17,
    phase,
    appSpec: {
      appId: "example",
      acceptedByCallId: "accepted",
      content: BUILD_READY_APP_SPEC,
      digest: "spec",
      artifactPath: "prototype/example/app-spec.md",
      artifactRevision: "artifact",
    },
    artifacts: [],
    sourceReceipt: { digest: "source" },
    workspace: {
      workspaceId: "workspace",
      workspacePath: "/workspace/repository",
      sourceSha: "source-sha",
      sourceTree: "source-tree",
      workspaceDigest: "workspace",
      eligibilityDigest: "eligible",
    },
    dependencyReceipt: { digest: "dependency" },
    identityReceipt: { digest: "identity" },
    preparedByCallId: "prepared",
    ...(phase === "planned"
      ? { proposal: { digest: "frozen-proposal", target: { privateCompute: compute } } }
      : {}),
  }) as unknown as AppBuilderWorkflowState;
// SAFETY: Planning I/O is mocked above; only the call and session identifiers are consumed by this producer test.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Context uses only these identifiers while execution ports are isolated.
const context = { callId: "plan", session: { id: "session", auth: {} } } as unknown as Parameters<
  typeof prepareAppCreation
>[1];
const run = <T>(operation: () => Promise<T>) =>
  contextStorage.run(new ContextContainer(), operation);
beforeEach(() => {
  vi.clearAllMocks();
  ports.profile.mockResolvedValue(profile());
  ports.execute.mockResolvedValue({
    contractDigest: "contract",
    proposal: { privateCompute: profile() },
  });
});

describe("normal private compute recipe projection", () => {
  it.each(["planned", "identity_resolved"] as const)(
    "returns the exact canonical upsert in the real %s producer",
    async (phase) => {
      await run(async () => {
        const current = fixture(phase);
        appBuilderWorkflowState.update(() => current);
        const before = JSON.stringify(current);
        const result = await prepareAppCreation({}, context);
        expect(result.reused).toBe(phase === "planned");
        expect(result.checkTaskSha256).toBe(sha256(PRIVATE_COMPUTE_CHECK_TASK));
        expect(implementationFilesSchema.parse(result.implementationFiles)).toEqual([
          {
            path: profile().checkPolicy.path,
            operation: "upsert",
            content: PRIVATE_COMPUTE_CHECK_TASK,
          },
        ]);
        expect(result.privateCompute).toEqual(profile());
        if (phase === "planned") {
          expect(JSON.stringify(appBuilderWorkflowState.get())).toBe(before);
        }
        expect(ports.execute).toHaveBeenCalledTimes(phase === "planned" ? 0 : 1);
      });
    },
  );
  it("preserves the real reused no-profile output without recipe fields", async () => {
    await run(async () => {
      const current = fixture("planned");
      if (!("proposal" in current)) {
        throw new Error("Fixture requires a frozen plan");
      }
      Reflect.deleteProperty(current.proposal.target, "privateCompute");
      appBuilderWorkflowState.update(() => current);
      ports.profile.mockImplementation(() => Promise.resolve());
      const result = await prepareAppCreation({}, context);
      expect(result.reused).toBe(true);
      expect(result).not.toHaveProperty("privateCompute");
      expect(result).not.toHaveProperty("implementationFiles");
      expect(result).not.toHaveProperty("checkTaskSha256");
    });
  });
  it("adds no recipe or approval for a plan without a selected profile", () => {
    expect(privateComputeProjection()).toEqual({});
  });
  it("rejects mismatched frozen after bytes without changing the profile", () => {
    const selected = profile();
    selected.checkPolicy.afterSha256 = "b".repeat(64);
    const before = JSON.stringify(selected);
    expect(() => privateComputeProjection(selected)).toThrow("installed reviewed recipe");
    expect(JSON.stringify(selected)).toBe(before);
  });
});

const appliedRepairFixture = () => {
  const planned = fixture("planned");
  if (!("proposal" in planned)) {
    throw new Error("fixture");
  }
  // SAFETY: The existing receipt fixture supplies all immutable fields consumed by the real repair producer.
  return {
    ...planned,
    phase: "applied",
    applyReceipt: {
      appSpecDigest: "spec",
      proposalDigest: planned.proposal.digest,
      workspaceDigest: "workspace",
      sourceReceiptDigest: "source",
      applyRoot: "/workspace/repository",
    },
  } as AppBuilderWorkflowState;
};
const approveRepairFixture = (state: AppBuilderWorkflowState) => {
  if (!("proposal" in state)) {
    throw new Error("fixture");
  }
  const scope = {
    appId: "example",
    appSpecDigest: "spec",
    proposalDigest: state.proposal.digest,
    sessionId: "session",
    workspaceId: "workspace",
  };
  requestPrivateApplyApproval(scope, "old-build");
  recordApprovedPrivateApply(scope, "old-build");
};
const repairFiles = [
  {
    path: "apps/example/.config/mise/config.toml",
    content: "# Enables discovery of generated app-scoped mise tasks.\n",
  },
];

describe("explicit same-app private repair through the real planning producer", () => {
  it("produces fresh ordinary plans, preserves old receipts and same profile, and reuses only unchanged prepared preimages", async () => {
    await run(async () => {
      const old = appliedRepairFixture();
      appBuilderWorkflowState.update(() => old);
      approveRepairFixture(old);
      ports.readBinary.mockResolvedValue(null);
      ports.execute.mockResolvedValue({
        contractDigest: "contract",
        proposal: {
          privateCompute: profile(),
          operation: "iterate-existing-app",
          iteration: {
            changes: [
              {
                path: repairFiles[0].path,
                after: {
                  content: repairFiles[0].content,
                  digest: sha256(repairFiles[0].content),
                  mode: "644",
                },
              },
            ],
          },
        },
      });
      const before = JSON.stringify(old);
      const result = await prepareAppCreation({ existingAppChanges: repairFiles }, context);
      expect(result.reused).toBe(false);
      const next = appBuilderWorkflowState.get();
      expect(next.phase).toBe("planned");
      if (!("proposal" in next) || !("proposal" in old)) {
        throw new Error("fixture");
      }
      expect(next.proposal.digest).not.toBe(old.proposal.digest);
      expect(next.appSpec).toEqual(old.appSpec);
      expect(next.workspace).toEqual(old.workspace);
      expect(next.proposal.target.privateCompute).toEqual(old.proposal.target.privateCompute);
      expect(existingAppRepairHistory.get()[0]?.previousWorkflow).toEqual(JSON.parse(before));
      expect(
        requestPrivateApplyApproval(
          {
            appId: "example",
            appSpecDigest: "spec",
            proposalDigest: next.proposal.digest,
            sessionId: "session",
            workspaceId: "workspace",
          },
          "new-build",
        ),
      ).toBe("user-approval");
      const { discardPendingPrivateApplyApproval } = await import("./private-apply-authority");
      discardPendingPrivateApplyApproval("new-build");
      // Relocated source and refreshed diagnostic metadata do not change the selected app or workspace.
      appBuilderWorkflowState.update(() => ({
        ...next,
        appSpec: { ...next.appSpec, uiRevision: "recorded-ui-revision" },
        workspace: {
          ...next.workspace,
          sourcePath: "/owned-relocated-source",
          eligibilityDigest: sha256("refreshed-eligibility-metadata"),
        },
      }));
      const repeated = await prepareAppCreation({ existingAppChanges: repairFiles }, context);
      expect(repeated.reused).toBe(true);
      expect(ports.execute).toHaveBeenCalledTimes(1);
      ports.readBinary.mockResolvedValue(Buffer.from("drift"));
      const replanned = await prepareAppCreation(
        { existingAppChanges: repairFiles },
        { ...context, callId: "repair-new-preimage" },
      );
      expect(replanned.reused).toBe(false);
      expect(ports.execute).toHaveBeenCalledTimes(2);
      expect(appBuilderWorkflowState.get()).not.toEqual(next);
    });
  });
  it("replans the same repair intent after a permission-only change", async () => {
    await run(async () => {
      const old = appliedRepairFixture();
      appBuilderWorkflowState.update(() => old);
      approveRepairFixture(old);
      ports.readBinary.mockResolvedValue(Buffer.from("current source"));
      ports.run.mockResolvedValue({ exitCode: 0, stdout: "777" });
      ports.execute.mockResolvedValue({
        contractDigest: "contract",
        proposal: {
          privateCompute: profile(),
          operation: "iterate-existing-app",
          iteration: {
            changes: [
              {
                path: repairFiles[0].path,
                before: { digest: sha256("current source"), mode: "755" },
                after: {
                  content: repairFiles[0].content,
                  digest: sha256(repairFiles[0].content),
                  mode: "755",
                },
              },
            ],
          },
        },
      });
      await prepareAppCreation({ existingAppChanges: repairFiles }, context);
      const result = await prepareAppCreation(
        { existingAppChanges: repairFiles },
        { ...context, callId: "replan-permissions-changed" },
      );
      expect(result.reused).toBe(false);
      expect(ports.execute).toHaveBeenCalledTimes(2);
    });
  });

  it.each(["validation_pending", "apply_failed", "publication_pending"])(
    "does not supersede %s",
    async (phase) => {
      await run(async () => {
        // SAFETY: Only the phase is changed to exercise refusal before any receipt or I/O use.
        const old = { ...appliedRepairFixture(), phase } as AppBuilderWorkflowState;
        appBuilderWorkflowState.update(() => old);
        approveRepairFixture(old);
        await expect(
          prepareAppCreation({ existingAppChanges: repairFiles }, context),
        ).rejects.toThrow();
        expect(ports.execute).not.toHaveBeenCalled();
        expect(appBuilderWorkflowState.get()).toEqual(old);
      });
    },
  );
  it("denies pending approvals, foreign workspace and policy deletion before planning", async () => {
    await run(async () => {
      const old = appliedRepairFixture();
      appBuilderWorkflowState.update(() => old);
      approveRepairFixture(old);
      requestPrivateApplyApproval(
        {
          appId: "example",
          appSpecDigest: "spec",
          proposalDigest: "pending",
          sessionId: "session",
          workspaceId: "workspace",
        },
        "pending",
      );
      await expect(
        prepareAppCreation({ existingAppChanges: repairFiles }, context),
      ).rejects.toThrow("pending");
      const { discardPendingPrivateApplyApproval } = await import("./private-apply-authority");
      discardPendingPrivateApplyApproval("pending");
      await expect(
        prepareAppCreation(
          { existingAppChanges: [{ operation: "delete", path: profile().checkPolicy.path }] },
          context,
        ),
      ).rejects.toThrow("exact reviewed");
      await expect(
        prepareAppCreation(
          { existingAppChanges: [{ path: "apps/foreign/page.tsx", content: "x" }] },
          context,
        ),
      ).rejects.toThrow("path");
      expect(ports.execute).not.toHaveBeenCalled();
      expect(appBuilderWorkflowState.get()).toEqual(old);
    });
  });
});

it("refuses cancelled and concurrently changed repair bindings before recording a new proposal", async () => {
  await run(async () => {
    const old = appliedRepairFixture();
    appBuilderWorkflowState.update(() => old);
    approveRepairFixture(old);
    const controller = new AbortController();
    ports.execute.mockImplementation(async () => {
      controller.abort();
      await Promise.resolve();
      return { contractDigest: "contract", proposal: { privateCompute: profile() } };
    });
    await expect(
      prepareAppCreation(
        { existingAppChanges: repairFiles },
        { ...context, abortSignal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(appBuilderWorkflowState.get()).toEqual(old);
    expect(existingAppRepairHistory.get()).toEqual([]);
  });
});

it("rejects a missing current compute profile on a retained prepared repair", async () => {
  await run(async () => {
    const old = appliedRepairFixture();
    appBuilderWorkflowState.update(() => old);
    approveRepairFixture(old);
    ports.execute.mockResolvedValue({
      contractDigest: "contract",
      proposal: {
        privateCompute: profile(),
        operation: "iterate-existing-app",
        iteration: { changes: [] },
      },
    });
    await prepareAppCreation({ existingAppChanges: repairFiles }, context);
    const prepared = appBuilderWorkflowState.get();
    if (!("proposal" in prepared)) {
      throw new Error("fixture");
    }
    const changed = {
      ...prepared,
      proposal: { ...prepared.proposal, target: { ...prepared.proposal.target } },
    };
    Reflect.deleteProperty(changed.proposal.target, "privateCompute");
    appBuilderWorkflowState.update(() => changed);
    await expect(prepareAppCreation({ existingAppChanges: repairFiles }, context)).rejects.toThrow(
      "binding changed",
    );
    expect(ports.execute).toHaveBeenCalledTimes(1);
  });
});

it("does not reuse the same repair intent after its applied file has drifted", async () => {
  await run(async () => {
    const old = appliedRepairFixture();
    appBuilderWorkflowState.update(() => old);
    approveRepairFixture(old);
    ports.execute.mockResolvedValue({
      contractDigest: "contract",
      proposal: {
        privateCompute: profile(),
        operation: "iterate-existing-app",
        iteration: { changes: [] },
      },
    });
    await prepareAppCreation({ existingAppChanges: repairFiles }, context);
    const planned = appBuilderWorkflowState.get();
    if (!("proposal" in planned) || !("applyReceipt" in old)) {
      throw new Error("fixture");
    }
    const applied = {
      ...planned,
      phase: "applied",
      applyReceipt: { ...old.applyReceipt, proposalDigest: planned.proposal.digest },
    };
    // SAFETY: Preserve all applied receipt fields and replace only its newly approved proposal identity.
    appBuilderWorkflowState.update(() => applied as AppBuilderWorkflowState);
    approveRepairFixture(appBuilderWorkflowState.get());
    const result = await prepareAppCreation(
      { existingAppChanges: repairFiles },
      { ...context, callId: "second-repair" },
    );
    expect(result.reused).toBe(false);
    expect(ports.execute).toHaveBeenCalledTimes(2);
    const next = appBuilderWorkflowState.get();
    if (!("proposal" in next)) {
      throw new Error("fixture");
    }
    expect(next.proposal.digest).not.toBe(planned.proposal.digest);
    expect(existingAppRepairHistory.get()).toHaveLength(2);
  });
});

const unappliedIterationFixture = () => {
  const state = fixture("planned");
  if (!("proposal" in state)) {
    throw new Error("fixture");
  }
  // SAFETY: The existing typed fixture supplies immutable fields consumed by planning; external execution is unavailable.
  return {
    ...state,
    proposal: {
      ...state.proposal,
      plannedByCallId: "compute-only-replan",
      target: {
        ...state.proposal.target,
        operation: "iterate-existing-app",
        iteration: { changes: [], digest: "iteration" },
      },
    },
  } as unknown as AppBuilderWorkflowState;
};

describe("unapproved existing-app plan amendment", () => {
  it("replans after compute-only planning without borrowing history or an old grant", async () => {
    await run(async () => {
      const old = appliedRepairFixture();
      approveRepairFixture(old);
      const current = unappliedIterationFixture();
      if (!("proposal" in current)) {
        throw new Error("fixture");
      }
      current.proposal.digest = "new-compute-only-plan";
      appBuilderWorkflowState.update(() => current);
      requestPrivateApplyApproval(
        {
          appId: "example",
          appSpecDigest: "spec",
          proposalDigest: "denied-plan",
          sessionId: "session",
          workspaceId: "workspace",
        },
        "denied-build",
      );
      retainPrivateApplyDenials({
        expected: readPrivateApplyAuthority(),
        proofs: [
          {
            sessionId: "session",
            callId: "denied-build",
            requestId: "framework-request",
            outcome: "denied-not-run",
            eventIds: ["request", "resolution", "not-run"],
            evidenceDigest: sha256("verified-native-negative-proof"),
          },
        ],
      });
      const authority = readPrivateApplyAuthority();
      ports.execute.mockResolvedValue({
        contractDigest: "contract",
        proposal: {
          privateCompute: profile(),
          operation: "iterate-existing-app",
          iteration: { changes: [] },
        },
      });
      const result = await prepareAppCreation({ existingAppChanges: repairFiles }, context);
      expect(result.reused).toBe(false);
      expect(ports.execute).toHaveBeenCalledOnce();
      expect(readPrivateApplyAuthority()).toEqual(authority);
      expect(existingAppRepairHistory.get()).toEqual([]);
      const next = appBuilderWorkflowState.get();
      if (!("proposal" in next)) {
        throw new Error("fixture");
      }
      expect(next.proposal.digest).not.toBe(current.proposal.digest);
      expect(
        requestPrivateApplyApproval(
          {
            appId: "example",
            appSpecDigest: "spec",
            proposalDigest: next.proposal.digest,
            sessionId: "session",
            workspaceId: "workspace",
          },
          "fresh-build",
        ),
      ).toBe("user-approval");
      recordApprovedPrivateApply(
        {
          appId: "example",
          appSpecDigest: "spec",
          proposalDigest: next.proposal.digest,
          sessionId: "session",
          workspaceId: "workspace",
        },
        "fresh-build",
      );
      expect(readPrivateApplyAuthority().terminalDecisions).toEqual(authority.terminalDecisions);
      expect(readPrivateApplyAuthority().grant?.proposalDigest).toBe(next.proposal.digest);
    });
  });

  it("blocks a matching approved/possibly executing proposal before planning", async () => {
    await run(async () => {
      const current = unappliedIterationFixture();
      appBuilderWorkflowState.update(() => current);
      approveRepairFixture(current);
      await expect(
        prepareAppCreation({ existingAppChanges: repairFiles }, context),
      ).rejects.toThrow("approved private operation");
      expect(ports.execute).not.toHaveBeenCalled();
      expect(appBuilderWorkflowState.get()).toEqual(current);
    });
  });

  it("blocks any pending approval and foreign workspaces without borrowing a grant", async () => {
    await run(async () => {
      const current = unappliedIterationFixture();
      appBuilderWorkflowState.update(() => current);
      requestPrivateApplyApproval(
        {
          appId: "foreign",
          appSpecDigest: "foreign",
          proposalDigest: "foreign",
          sessionId: "foreign",
          workspaceId: "foreign",
        },
        "pending",
      );
      await expect(
        prepareAppCreation({ existingAppChanges: repairFiles }, context),
      ).rejects.toThrow("pending");
      expect(ports.execute).not.toHaveBeenCalled();
    });
    await run(async () => {
      const current = unappliedIterationFixture();
      appBuilderWorkflowState.update(() => current);
      await expect(
        inspectExistingAppRepair({
          current,
          changes: repairFiles,
          // SAFETY: The fake Sandbox has only the consumed ID and read-only observation ports.
          sandbox: { ...repairSandbox, id: "foreign" } as unknown as Parameters<
            typeof inspectExistingAppRepair
          >[0]["sandbox"],
          ctx: context,
        }),
      ).rejects.toThrow("authority or workspace changed");
    });
  });

  it("plans amendments from the live source without checking superseded preimages", async () => {
    await run(async () => {
      const current = unappliedIterationFixture();
      if (!("proposal" in current) || !("iteration" in current.proposal.target)) {
        throw new Error("fixture");
      }
      current.proposal.target.iteration.changes = [
        {
          path: "apps/example/.config/mise/config.toml",
          before: { digest: sha256("before"), mode: "644" },
          after: { content: "after", digest: sha256("after"), mode: "644" },
        },
      ];
      appBuilderWorkflowState.update(() => current);
      ports.readBinary.mockResolvedValue(Buffer.from("drift"));
      ports.execute.mockResolvedValue({
        contractDigest: "fresh-contract",
        proposal: {
          privateCompute: profile(),
          operation: "iterate-existing-app",
          iteration: { changes: [] },
        },
      });
      const result = await prepareAppCreation(
        { existingAppChanges: repairFiles },
        { ...context, callId: "fresh-amendment" },
      );
      expect(result.reused).toBe(false);
      expect(ports.execute).toHaveBeenCalledOnce();
      expect(ports.readBinary).not.toHaveBeenCalled();
      expect(ports.run).not.toHaveBeenCalled();
    });
  });
});

it("does not classify foreign-session repair history as an unapplied plan", async () => {
  await run(async () => {
    const current = unappliedIterationFixture();
    if (!("proposal" in current)) {
      throw new Error("fixture");
    }
    appBuilderWorkflowState.update(() => current);
    existingAppRepairHistory.update(() => [
      {
        requestDigest: "prior-request",
        proposalDigest: current.proposal.digest,
        sessionId: "foreign-session",
        previousWorkflow: current,
        // SAFETY: appliedRepairFixture constructs exactly the applied phase and its immutable receipt fields.
        approvedBase: appliedRepairFixture() as Extract<
          AppBuilderWorkflowState,
          { phase: "applied" }
        >,
      },
    ]);
    await expect(prepareAppCreation({ existingAppChanges: repairFiles }, context)).rejects.toThrow(
      "another session",
    );
    expect(ports.execute).not.toHaveBeenCalled();
    expect(appBuilderWorkflowState.get()).toEqual(current);
  });
});
