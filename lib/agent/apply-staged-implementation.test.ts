import { completionGuidance } from "./completion-guidance";
import { updateExactWorkflow } from "./workflow-state";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApprovalPolicy } from "eve/tools/approval";
import applyAppCreation from "../../agent/tools/apply_app_creation";

const mocks = vi.hoisted(() => {
  const current: Record<string, unknown> = {};
  return {
    current,
    execute: vi.fn(),
    wrap: vi.fn(),
  };
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled eve/tools dependency used by this test.
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled eve/context dependency used by this test.
vi.mock("eve/context", () => ({
  defineState: (_name: string, initial: () => unknown) => {
    let state = initial();
    return {
      get: () => state,
      update: (change: (current: unknown) => unknown) => {
        state = change(state);
      },
    };
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./workflow-state dependency used by this test.
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 1,
  appBuilderWorkflowState: { get: () => mocks.current },
  updateExactWorkflow: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./apply-implementation-files dependency used by this test.
vi.mock("./apply-implementation-files", async (original) => ({
  ...(await original()),
  withImplementationFiles: mocks.wrap,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../repository/target-apply dependency used by this test.
vi.mock("../repository/target-apply", () => ({
  executeProposalBoundApply: mocks.execute,
  fixtureApplyCommandExecutor: vi.fn(),
  inspectFixtureApplyOverlay: vi.fn(),
  sandboxApplyCommandExecutor: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ../testing/test-capability dependency used by this test.
vi.mock("../testing/test-capability", () => ({ hasTestCapability: () => false }));
type AuthoredApprovalPolicy = Extract<
  NonNullable<typeof applyAppCreation.approval>,
  ApprovalPolicy<never>
>;
const approval = async (context: Parameters<AuthoredApprovalPolicy>[0]) => {
  const policy = applyAppCreation.approval;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow Eve's declared function-or-configuration approval API, not external data.
  if (typeof policy !== "function") {
    throw new TypeError("Expected the authored approval policy");
  }
  return await policy(context);
};
const state = (proposalDigest: string, phase = "planned") => ({
  appSpec: { content: "## Acceptance walkthrough\nSave draft.", digest: "spec" },
  applyReceipt: { changes: [] },
  dependencyReceipt: {},
  identityReceipt: {},
  phase,
  proposal: {
    digest: proposalDigest,
    target: { contract: { appId: "app" }, plan: { source: { schema: { kind: "kernel" } } } },
  },
  sourceReceipt: {},
  workspace: { workspaceId: "private-workspace" },
});
const page = {
  content: "export default function Page() { return <main>Workspace</main>; }",
  path: "apps/app/app/page.tsx",
};
const action = {
  content: '"use server"; export async function save() {}',
  path: "apps/app/app/actions.ts",
};

describe("apply tool staged repair integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({ ok: true, receipt: { changes: [] } });
  });
  it.each([true, false])(
    "retains the publication marker after accepted apply (success: %s)",
    async (success) => {
      mocks.current = {
        ...state(`publication-apply-${success}`),
        publishedGitHubDraftProposalDigest: "verified-publication",
        githubDraftProposal: { proposal: { digest: "old-sealed-proposal" } },
      };
      vi.mocked(updateExactWorkflow).mockImplementationOnce(({ expected, transition }) => {
        mocks.current = { ...transition(expected) };
      });
      const context = {
        callId: `publication-apply-${success}`,
        getSandbox: vi.fn().mockResolvedValue({}),
        session: { id: "session" },
      } as never;
      expect(await approval(context)).toBe("user-approval");
      if (success) {
        await applyAppCreation.execute({ implementationFiles: [page] }, context);
      } else {
        mocks.execute.mockResolvedValueOnce({
          ok: false,
          receipt: {
            command: { exitCode: 1, name: "create" },
            output: { stderr: "controlled apply failure" },
          },
        });
        await expect(
          applyAppCreation.execute({ implementationFiles: [page] }, context),
        ).rejects.toThrow("controlled apply failure");
      }
      expect(mocks.current).toMatchObject({
        phase: success ? "applied" : "apply_failed",
        publishedGitHubDraftProposalDigest: "verified-publication",
      });
      expect(mocks.current).not.toHaveProperty("githubDraftProposal");
    },
  );

  it("accepts optional Build summaries beyond the card's presentation budget", () => {
    const schema = applyAppCreation.inputSchema;
    if (!(schema instanceof z.ZodType)) {
      throw new Error("Expected the authored Apply input schema.");
    }
    const productSummary = "Summarize the approved app scope. ".repeat(30).trim();
    expect(schema.parse({ productSummary })).toMatchObject({ productSummary });
    expect(schema.parse({ productSummary: "   " })).toMatchObject({ productSummary: "" });
  });

  it("asks once for an ordinary Build and retains staged UI through the approved repair", async () => {
    mocks.current = state("repair");
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "apply", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("user-approval");
    expect(getSandbox).not.toHaveBeenCalled();
    mocks.execute.mockResolvedValueOnce({
      ok: false,
      receipt: {
        command: { exitCode: 1, name: "create" },
        output: { stderr: "fixture command failure" },
      },
    });
    await expect(
      applyAppCreation.execute({ implementationFiles: [page] }, context),
    ).rejects.toThrow("fixture command failure");
    expect(getSandbox).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledOnce();
    const repairContext = { callId: "repair", getSandbox, session: { id: "session" } } as never;
    expect(await approval(repairContext)).toBe("approved");
    await applyAppCreation.execute({ implementationFiles: [action] }, repairContext);
    expect(mocks.wrap.mock.calls[1][1]).toEqual([page, action]);
    expect(mocks.execute).toHaveBeenCalledTimes(2);
  });
  it("applies an approved partial submission with advisory architecture diagnostics", async () => {
    mocks.current = state("advisory");
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "apply", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("user-approval");
    await expect(
      applyAppCreation.execute({ implementationFiles: [page] }, context),
    ).resolves.toMatchObject({
      architectureDiagnostics: [expect.stringContaining("No Server Action")],
      status: "applied",
    });
    expect(mocks.wrap.mock.calls[0][1]).toEqual([page]);
    expect(mocks.execute).toHaveBeenCalledOnce();
  });
  it("already-applied reuse does not request sandbox or stage unused input", async () => {
    mocks.current = state("reuse", "applied");
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "apply", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("user-approval");
    expect(await applyAppCreation.execute({ implementationFiles: [page] }, context)).toMatchObject({
      reused: true,
    });
    expect(getSandbox).not.toHaveBeenCalled();
    mocks.current = state("reuse");
    expect(await approval(context)).toBe("approved");
    await applyAppCreation.execute({ implementationFiles: [action] }, context);
    expect(mocks.wrap.mock.calls[0][1]).toEqual([action]);
  });
  it("returns model-readable prerequisites for ui_accepted without creating build approval or touching source", async () => {
    mocks.current = { phase: "ui_accepted" };
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "no-proposal", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("not-applicable");
    expect(await applyAppCreation.execute({ implementationFiles: [page] }, context)).toMatchObject({
      guidance: completionGuidance({ phase: "ui_accepted" }),
      status: "implementation_plan_required",
      workflowPhase: "ui_accepted",
    });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not apply a proposal that appears after a read-only policy decision", async () => {
    mocks.current = { phase: "ui_accepted" };
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "phase-race", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("not-applicable");
    mocks.current = state("new-after-policy");
    expect(await applyAppCreation.execute({ implementationFiles: [page] }, context)).toMatchObject({
      status: "build_approval_required",
    });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(
      await approval({
        callId: "new-approved-call",
        getSandbox,
        session: { id: "session" },
      } as never),
    ).toBe("user-approval");
  });
  it("requests approval when the private plan selects a compute resize", async () => {
    const current = state("compute-resize");
    const privateCompute = "private-checks-16gib-v1";
    mocks.current = {
      ...current,
      proposal: {
        ...current.proposal,
        target: { ...current.proposal.target, privateCompute: { id: privateCompute } },
      },
    };
    expect(
      await approval({
        callId: "compute-resize",
        session: { id: "session" },
        toolInput: { privateCompute },
      } as never),
    ).toBe("user-approval");
  });
  it("does not apply a scope swapped after an approval policy decision", async () => {
    mocks.current = state("approved-before-swap");
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "scope-race", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("user-approval");
    mocks.current = state("swapped-after-policy");
    expect(await applyAppCreation.execute({ implementationFiles: [page] }, context)).toMatchObject({
      status: "build_approval_required",
    });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("invalidates older pending approval when the same call becomes a read-only prerequisite", async () => {
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = {
      callId: "same-call-old-pending",
      getSandbox,
      session: { id: "session" },
    } as never;
    mocks.current = state("same-call-proposal");
    expect(await approval(context)).toBe("user-approval");
    mocks.current = { phase: "ui_accepted" };
    expect(await approval(context)).toBe("not-applicable");
    mocks.current = state("same-call-proposal");
    expect(await applyAppCreation.execute({ implementationFiles: [page] }, context)).toMatchObject({
      status: "build_approval_required",
    });
    expect(getSandbox).not.toHaveBeenCalled();
    expect(mocks.wrap).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
