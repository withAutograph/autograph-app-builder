import { beforeEach, describe, expect, it, vi } from "vitest";

import validateAppCreation from "../../agent/tools/validate_app_creation";

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  execute: vi.fn(),
  review: vi.fn(),
  state: { current: {} as Record<string, unknown>, update: vi.fn() },
}));

vi.mock("./review-applied-product-source", () => ({ reviewAppliedProductSource: mocks.review }));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./workflow-state", () => ({
  APP_BUILDER_WORKFLOW_VERSION: 1,
  appBuilderWorkflowState: {
    get: () => mocks.state.current,
    update: mocks.state.update,
  },
}));
vi.mock("./product-behavior-state", () => ({
  clearProductBehaviorEvidence: mocks.clear,
  currentProductBehaviorEvidence: () => [],
}));
vi.mock("../repository/target-validation", () => ({
  createTargetValidationAttempt: () => ({ digest: "attempt" }),
  executeProposalBoundValidation: mocks.execute,
  fixtureValidationCommandExecutor: vi.fn(),
  sandboxValidationCommandExecutor: vi.fn(),
}));
vi.mock("../testing/test-capability", () => ({ hasTestCapability: () => false }));

const workflow = (phase: "validated" | "reviewed") => ({
  appSpec: { appId: "app", content: "## Acceptance walkthrough\n\nSave draft.", digest: "a" },
  applyReceipt: { applyRoot: "/workspace/repository", digest: "apply" },
  artifacts: [],
  dependencyReceipt: { dependencyLayout: {} },
  identityReceipt: {},
  phase,
  preparedByCallId: "prepare",
  proposal: {
    target: {
      operation: "iterate-existing-app",
      plan: { source: { workspacePath: "apps/app" } },
    },
  },
  sourceReceipt: {},
  validationReceipt: { commands: [] },
  version: 1,
  workspace: {},
});
const implementationFiles = [{ content: "updated", path: "apps/app/page.tsx" }];

describe("behavior evidence invalidation during validation repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.update.mockImplementation((change) => {
      mocks.state.current = change(mocks.state.current);
    });
    mocks.execute.mockResolvedValue({ ok: true, receipt: { commands: [] } });
    mocks.review.mockResolvedValue({ findings: [], reviewCompleted: true, status: "failed" });
  });

  it("automatically returns source findings after technical validation without a review-tool call", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({}),
    } as never);
    expect(mocks.execute).toHaveBeenCalledBefore(mocks.review);
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(mocks.state.current.phase).toBe("validated");
    expect(result).toMatchObject({
      productAcceptance: { productStatus: "failed" },
      sourceAssessment: { status: "failed" },
      technicalStatus: "passed",
    });
  });
  it("does not invoke the source judge when repository commands fail", async () => {
    mocks.state.current = { ...workflow("validated"), phase: "applied" };
    mocks.execute.mockResolvedValue({ ok: false, receipt: { reason: "command failed" } });
    await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({}),
    } as never);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("assesses reused validation without rerunning technical commands or claiming runtime success", async () => {
    mocks.state.current = workflow("validated");
    mocks.review.mockResolvedValue({ findings: [], reviewCompleted: true, status: "passed" });
    const result = await validateAppCreation.execute({ implementationFiles: [] }, {
      callId: "validate",
      getSandbox: () => Promise.resolve({}),
    } as never);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.review).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      productAcceptance: { productStatus: "unassessed" },
      reused: true,
    });
  });

  it.each(["validated", "reviewed"] as const)(
    "does not ignore repair files in %s phase",
    async (phase) => {
      mocks.state.current = workflow(phase);
      const writeTextFile = vi.fn();
      const result = await validateAppCreation.execute({ implementationFiles }, {
        callId: "repair",
        getSandbox: () => Promise.resolve({ writeTextFile }),
      } as never);
      expect(mocks.clear).toHaveBeenCalledBefore(writeTextFile);
      expect(writeTextFile).toHaveBeenCalledOnce();
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ reused: false, status: "validated" });
    },
  );

  it("clears evidence before a failed repair write", async () => {
    mocks.state.current = workflow("validated");
    const writeTextFile = vi.fn().mockRejectedValue(new Error("write failed"));
    await expect(
      validateAppCreation.execute({ implementationFiles }, {
        callId: "repair",
        getSandbox: () => Promise.resolve({ writeTextFile }),
      } as never),
    ).rejects.toThrow("write failed");
    expect(mocks.clear).toHaveBeenCalledBefore(writeTextFile);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("rejects a platform-owned repair before changing validation state or files", async () => {
    mocks.state.current = workflow("validated");
    const writeTextFile = vi.fn();
    await expect(
      validateAppCreation.execute(
        {
          implementationFiles: [
            { content: "out of scope", path: "packages/platform/src/change.ts" },
          ],
        },
        {
          callId: "repair",
          getSandbox: () => Promise.resolve({ writeTextFile }),
        } as never,
      ),
    ).rejects.toThrow("Existing-app implementation files must stay inside the app workspace.");
    expect(mocks.state.current.phase).toBe("validated");
    expect(mocks.state.update).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });
  it.each(["validated", "reviewed"] as const)(
    "keeps failed partial repair pending from %s and reruns validation",
    async (phase) => {
      mocks.state.current = workflow(phase);
      const writeTextFile = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("second write failed"));
      const context = {
        callId: "repair",
        getSandbox: () => Promise.resolve({ writeTextFile }),
      } as never;
      await expect(
        validateAppCreation.execute(
          {
            implementationFiles: [
              { content: "changed", path: "apps/app/page.tsx" },
              { content: "next", path: "apps/app/actions.ts" },
            ],
          },
          context,
        ),
      ).rejects.toThrow("second write failed");
      expect(mocks.state.current.phase).toBe("validation_pending");
      expect(mocks.state.current).not.toHaveProperty("validationReceipt");
      expect(mocks.state.current).not.toHaveProperty("validationFailure");
      expect(mocks.state.update).toHaveBeenCalledBefore(writeTextFile);
      expect(mocks.clear).toHaveBeenCalledBefore(writeTextFile);
      expect(mocks.execute).not.toHaveBeenCalled();
      const result = await validateAppCreation.execute({ implementationFiles: [] }, context);
      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ reused: false, status: "validated" });
    },
  );
});
