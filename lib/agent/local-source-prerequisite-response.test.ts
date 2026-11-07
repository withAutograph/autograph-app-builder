/* oxlint-disable anti-slop/no-module-mocking, sonarjs/no-internal-api-use -- Controlled source/read ports exercise the real workflow error boundary without provider operations. */
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolContext } from "eve/tools";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { appBuilderWorkflowState } from "./workflow-state";
import { LocalPlanningSourcePrerequisiteError } from "../repository/local-planning-source-prerequisite";
import { refreshLocalPlanningSource } from "./refresh-local-planning-source";
import { currentLocalSourcePrerequisite } from "./local-source-prerequisite-state";
import { localSourcePrerequisiteResponse } from "./local-source-prerequisite-response";

const mocks = vi.hoisted(() => ({
  captureDigest: vi.fn(() => "9".repeat(64)),
  dispose: vi.fn(),
  history: vi.fn<() => Promise<void>>().mockResolvedValue(),
  project: vi.fn<() => Promise<void>>().mockResolvedValue(),
  reconcile: vi.fn(),
}));
vi.mock("./local-source-transport-history", () => ({
  readCompletedLocalSourceTransport: mocks.history,
}));
vi.mock("../repository/development-source", () => ({
  canAutoSelectDevelopmentSource: () => true,
  developmentSourceReceipt: async () => ({
    sourcePath: "/owned-current-source",
    sourceSha: "9".repeat(40),
  }),
}));
vi.mock("./local-planning-source-base", () => ({
  localPlanningSourceBase: () => ({
    sourceSha: "c".repeat(40),
    workspaceDigest: "d".repeat(64),
    workspaceId: "owned-workspace",
  }),
}));
vi.mock("../repository/local-planning-source", () => ({
  captureLocalPlanningSource: async () => ({
    dispose: mocks.dispose,
    generation: { workspaceDigest: mocks.captureDigest() },
  }),
  reconcileLocalPlanningSource: mocks.reconcile,
}));
vi.mock("./source-bound-sandbox", () => ({
  getSourceBoundSandbox: async () => ({ id: "owned-workspace" }),
}));
vi.mock("./approved-build-continuation-runtime", () => ({
  emitCurrentBuildWorkflowProjection: mocks.project,
}));

// SAFETY: The fixture models only fields read before the injected typed baseline failure; no source/provision/approval effect can run.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Bounded source-boundary fixture.
const state = {
  appSpec: { appId: "supplier-spend", digest: "a".repeat(64) },
  phase: "validation_failed",
  proposal: { digest: "e".repeat(64), workspaceDigest: "d".repeat(64) },
  sourceReceipt: {
    digest: "b".repeat(64),
    sourceKind: "existing-repository",
    sourceSha: "c".repeat(40),
  },
  workspace: {
    workspaceDigest: "d".repeat(64),
    workspaceId: "owned-workspace",
    workspacePath: "/workspace/repository",
  },
} as unknown as AppBuilderWorkflowState;
// SAFETY: Projection persistence is a no-effect spy; the actual source guard consumes only this tool identity and cancellation.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Bounded ToolContext fixture.
const ctx = {
  abortSignal: new AbortController().signal,
  callId: "actual-plan-failure",
  getSandbox: vi.fn(),
  session: { auth: {}, id: "same-session" },
} as unknown as ToolContext;
beforeEach(() => {
  vi.clearAllMocks();
});
it("keeps the selected workspace without reading native transport history when local source is unchanged", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    appBuilderWorkflowState.update(() => state);
    mocks.captureDigest.mockReturnValueOnce("d".repeat(64));
    await expect(refreshLocalPlanningSource(ctx)).resolves.toBeUndefined();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(appBuilderWorkflowState.get()).toEqual(state);
  });
});
it("commits a typed blocked observation as a normal tool result while retaining the old workflow", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    appBuilderWorkflowState.update(() => state);
    const before = JSON.stringify(state);
    const error = new LocalPlanningSourcePrerequisiteError("c".repeat(40), "d".repeat(64));
    mocks.reconcile.mockRejectedValueOnce(error);
    await expect(refreshLocalPlanningSource(ctx)).rejects.toBe(error);
    expect(mocks.history).toHaveBeenCalledOnce();
    expect(mocks.history.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reconcile.mock.invocationCallOrder[0] ?? 0,
    );
    const result = await localSourcePrerequisiteResponse(error, ctx);
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("local_source_baseline_required");
    expect(currentLocalSourcePrerequisite(state, ctx.session.id)).toEqual(
      result.sourcePrerequisite,
    );
    expect(JSON.stringify(appBuilderWorkflowState.get())).toBe(before);
    expect(mocks.project).toHaveBeenCalledWith(ctx);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
it("does not classify matching diagnostic prose as a typed source prerequisite", async () => {
  await contextStorage.run(new ContextContainer(), async () => {
    appBuilderWorkflowState.update(() => state);
    const error = new Error(
      "The retained original source Git bytes do not match the saved planning baseline.",
    );
    mocks.reconcile.mockRejectedValueOnce(error);
    await expect(refreshLocalPlanningSource(ctx)).rejects.toBe(error);
    await expect(localSourcePrerequisiteResponse(error, ctx)).rejects.toBe(error);
    expect(currentLocalSourcePrerequisite(state, ctx.session.id)).toBeUndefined();
    expect(mocks.project).not.toHaveBeenCalled();
  });
});
