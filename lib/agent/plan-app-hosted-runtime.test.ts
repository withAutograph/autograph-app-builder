/* oxlint-disable anti-slop/no-module-mocking -- The tool test isolates its Eve state and hosted operator ports without contacting the provider. */
import { describe, expect, it, vi } from "vitest";
import planAppHostedRuntime from "../../agent/tools/plan-app-hosted-runtime";

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  select: vi.fn(),
}));
vi.mock("./workflow-state", () => ({
  appBuilderWorkflowState: {
    get: () => ({
      phase: "prepared",
      githubSource: { digest: "selected-source" },
      sourceReceipt: { sourceKind: "existing-repository" },
      workspace: { workspacePath: "/workspace/repository" },
    }),
  },
}));
vi.mock("./acceptance-runtime-root", () => ({
  resolveAcceptanceRuntimeRoot: ({ fallbackRoot }: { fallbackRoot: string }) => fallbackRoot,
}));
vi.mock("../provisioning/hosted-operator-client", () => ({
  hostedOperatorClientForSession: () => ({
    resolvePreviewTarget: mocks.select,
    planContinuity: mocks.plan,
  }),
}));

describe("hosted continuity planning", () => {
  it("uses the verified target and selected checkout when the existing app has no app-spec marker", async () => {
    const target = { appId: "inventory", projectId: "selected-project", branch: "feature" };
    const planned = { status: "planned", plan: { intentId: "continuity" } };
    mocks.select.mockResolvedValue(target);
    mocks.plan.mockResolvedValue(planned);
    const { signal } = new AbortController();
    const context = {
      abortSignal: signal,
      callId: "continuity-call",
      getSandbox: vi.fn().mockResolvedValue({
        id: "selected-sandbox",
        readTextFile: () => Promise.resolve(null),
      }),
      getToken: vi.fn(),
      requireAuth: (): never => {
        throw new Error("Unexpected auth request");
      },
      session: {
        auth: { current: null, initiator: null },
        id: "session",
        turn: { id: "turn", sequence: 0 },
      },
      toolName: "plan-app-hosted-runtime",
    };
    const input = { appId: target.appId, environment: "preview", operation: "continuity" } as const;
    await expect(
      planAppHostedRuntime.execute({ ...input, projectId: "other-project" }, context),
    ).resolves.toMatchObject({ code: "resource_mismatch", status: "blocked" });
    expect(mocks.plan).not.toHaveBeenCalled();
    await expect(planAppHostedRuntime.execute(input, context)).resolves.toEqual(planned);
    expect(mocks.plan).toHaveBeenCalledWith(
      target,
      { root: "/workspace/repository", sandboxId: "selected-sandbox" },
      "continuity-call",
      signal,
      undefined,
    );
  });
});
