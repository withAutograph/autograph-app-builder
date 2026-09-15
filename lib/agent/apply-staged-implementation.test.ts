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
  it("stages full UI before rejection and supplies it with the partial repair to executor", async () => {
    mocks.current = state("repair");
    const getSandbox = vi.fn().mockResolvedValue({});
    const context = { callId: "apply", getSandbox, session: { id: "session" } } as never;
    expect(await approval(context)).toBe("user-approval");
    await expect(
      applyAppCreation.execute({ implementationFiles: [page] }, context),
    ).rejects.toThrow("no Server Action");
    expect(getSandbox).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(await approval(context)).toBe("approved");
    await applyAppCreation.execute({ implementationFiles: [action] }, context);
    expect(mocks.wrap.mock.calls[0][1]).toEqual([page, action]);
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
});
