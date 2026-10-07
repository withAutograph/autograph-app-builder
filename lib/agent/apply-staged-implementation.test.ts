import { completionGuidance } from "./completion-guidance";
import type * as ImplementationModule from "./apply-implementation-files";
import { beforeEach, describe, expect, it, vi } from "vitest";
import applyAppCreation from "../../agent/tools/apply_app_creation";

const mocks = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
  execute: vi.fn(),
  wrap: vi.fn(),
}));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));

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
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 1,
  appBuilderWorkflowState: { get: () => mocks.current },
  updateExactWorkflow: vi.fn(),
}));
vi.mock("./apply-implementation-files", async (original) => ({
  ...(await original<typeof ImplementationModule>()),
  withImplementationFiles: mocks.wrap,
}));
vi.mock("../repository/target-apply", () => ({
  executeProposalBoundApply: mocks.execute,
  fixtureApplyCommandExecutor: vi.fn(),
  inspectFixtureApplyOverlay: vi.fn(),
  sandboxApplyCommandExecutor: vi.fn(),
}));
vi.mock("../testing/test-capability", () => ({ hasTestCapability: () => false }));
const approval = async (context: Parameters<typeof applyAppCreation.execute>[1]) => {
  const policy = applyAppCreation.approval;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Narrow Eve's declared function-or-configuration approval API, not external data.
  if (typeof policy !== "function") {
    throw new TypeError("Expected the authored approval policy");
  }
  return await policy(context as never);
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
  it("stages full UI through command failure and supplies it with the partial repair", async () => {
    mocks.current = state("repair");
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "apply", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("user-approval");
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
    expect(await approval(context)).toBe("approved");
    await applyAppCreation.execute({ implementationFiles: [action] }, context);
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
