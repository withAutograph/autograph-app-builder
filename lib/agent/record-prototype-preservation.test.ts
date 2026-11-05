/* oxlint-disable anti-slop/no-module-mocking -- Actual recording/acceptance tools and reducers run against faithful in-memory harness globals and persistence ports; no database or sandbox effects are allowed. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import recordArtifact from "../../agent/tools/record_prototype_artifact";
import acceptAppSpec from "../../agent/tools/accept_app_spec";
import { BUILD_READY_APP_SPEC } from "../../evals/support/app-spec";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { recordPrototypeArtifactRevision } from "./prototype-artifacts";
import type { DurablePrototypeChunkStore } from "./prototype-artifacts-v2";

const ports = vi.hoisted(() => ({
  prepare: vi.fn(),
  projection: vi.fn(),
  store: vi.fn<() => DurablePrototypeChunkStore>(),
}));
vi.mock("eve/tools", () => ({ defineTool: <T>(tool: T) => tool }));
vi.mock("eve/context", () => ({
  defineState: (_name: string, initial: () => AppBuilderWorkflowState) => {
    let state = initial();
    return {
      get: () => state,
      update: (change: (current: AppBuilderWorkflowState) => AppBuilderWorkflowState) => {
        state = change(state);
      },
    };
  },
}));
// Boundary ports isolate real tool/state transitions from database and sandbox effects.
vi.mock("./approved-build-continuation-runtime", () => ({
  emitCurrentBuildWorkflowProjection: ports.projection,
}));
vi.mock("./prepare-app-creation", () => ({ prepareAppCreation: ports.prepare }));
vi.mock("./hosted-prototype-chunk-store", () => ({
  createHostedPrototypeChunkStore: () => ports.store(),
}));
vi.mock("./postgres-prototype-chunks", () => ({
  assertPrototypeChunkSchemaReady: () => Promise.resolve(),
}));
vi.mock("../mcp/hosted-route", () => ({ openHostedPostgresDatabase: () => ({}) }));

const specArtifact = recordPrototypeArtifactRevision({
  artifacts: [],
  content: BUILD_READY_APP_SPEC,
  mediaType: "text/markdown",
  path: "prototype/inventory/app-spec.md",
  callId: "spec-recorded",
  sessionId: "session",
}).artifact;

const accepted = {
  acceptedByCallId: "accepted",
  appId: "inventory",
  artifactPath: specArtifact.path,
  artifactRevision: specArtifact.revision,
  content: specArtifact.content,
  digest: specArtifact.digest,
};
// SAFETY: real recording/acceptance reads these context fields; sandbox/planning effects are isolated ports.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The actual tools only consume the specified context; all sandbox effects remain forbidden ports.
const context = {
  callId: "record-notes",
  session: { id: "session", auth: {} },
  getSandbox: vi.fn(),
  getSkill: vi.fn(),
} as unknown as Parameters<typeof recordArtifact.execute>[1];
const seed = (phase: AppBuilderWorkflowState["phase"] = "reviewed") => {
  const fixture = {
    appSpec: accepted,
    artifacts: recordPrototypeArtifactRevision({
      artifacts: recordPrototypeArtifactRevision({
        artifacts: [specArtifact],
        content: "<!doctype html><main>Accepted prototype</main>",
        mediaType: "text/html",
        path: "prototype/inventory/index.html",
        callId: "prototype-recorded",
        sessionId: "session",
      }).artifacts,
      content: "Accepted design decisions.",
      mediaType: "text/markdown",
      path: "prototype/inventory/decisions.md",
      callId: "decisions-recorded",
      sessionId: "session",
    }).artifacts,
    phase,
    preparedByCallId: "prepared",
    version: APP_BUILDER_WORKFLOW_VERSION,
    workspace: { workspaceDigest: "workspace" },
    sourceReceipt: { digest: "source" },
    dependencyReceipt: { digest: "dependencies" },
    identityReceipt: { digest: "identity" },
    proposal: { digest: "proposal" },
    applyReceipt: { digest: "apply" },
    validationReceipt: { digest: "validation" },
    reviewReceipt: { digest: "review" },
    validationAttempt: { digest: "attempt" },
  };
  // SAFETY: opaque receipt internals are not executed; their identities must survive artifact recording.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Receipt fields are opaque identity sentinels, never executed.
  const state = fixture as AppBuilderWorkflowState;
  appBuilderWorkflowState.update(() => state);
  return state;
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  const chunks = new Map<string, string>();
  ports.store.mockReturnValue({
    put: (input) => {
      chunks.set(
        JSON.stringify([input.path, input.transferDigest, input.chunkIndex]),
        input.content,
      );
      return Promise.resolve(sha256(input.content));
    },
    get: (input) =>
      Promise.resolve(
        chunks.get(JSON.stringify([input.path, input.transferDigest, input.chunkIndex])),
      ),
  });
});

for (const hosted of [false, true]) {
  describe(
    hosted ? "durable accepted artifact recording" : "v1 accepted artifact recording",
    () => {
      it("records operational notes without discarding the reviewed workflow or receipts", async () => {
        vi.stubEnv("EVE_HOSTED_ADAPTER", hosted ? "1" : "0");
        const before = seed();
        await recordArtifact.execute(
          {
            path: "prototype/inventory/decisions.md",
            mediaType: "text/markdown",
            content: "Preview preparation needs an operator diagnosis.",
          },
          context,
        );
        const after = appBuilderWorkflowState.get();
        expect(after).toEqual({
          ...before,
          artifacts: after.phase === "empty" ? [] : after.artifacts,
        });
        expect(after.phase).toBe("reviewed");
        expect("appSpec" in after && after.appSpec).toBe(accepted);
        expect(
          after.phase !== "empty" &&
            after.artifacts.some((artifact) => artifact.path.endsWith("/decisions.md")),
        ).toBe(true);
        expect(ports.prepare).not.toHaveBeenCalled();
      });
      it("keeps a changed app-spec draft separate from accepted work until explicit acceptance", async () => {
        vi.stubEnv("EVE_HOSTED_ADAPTER", hosted ? "1" : "0");
        const before = seed();
        const changed = BUILD_READY_APP_SPEC.replace(
          "Confirmed outcome.",
          "A revised outcome selected later.",
        );
        await recordArtifact.execute(
          { path: specArtifact.path, mediaType: "text/markdown", content: changed },
          context,
        );
        const after = appBuilderWorkflowState.get();
        expect(after.phase).toBe("reviewed");
        expect("appSpec" in after && after.appSpec).toBe(accepted);
        expect(after).toEqual({
          ...before,
          artifacts: after.phase === "empty" ? [] : after.artifacts,
        });
        expect(ports.prepare).not.toHaveBeenCalled();
        if (after.phase === "empty") {
          throw new Error("missing workspace");
        }
        const draft = after.artifacts.find((artifact) => artifact.path === specArtifact.path);
        expect(draft?.digest).toBe(sha256(changed));
        if (draft === undefined) {
          throw new Error("missing draft");
        }
        await acceptAppSpec.execute(
          {
            appId: "inventory",
            expectedArtifactDigest: draft.digest,
            expectedArtifactRevision: draft.revision,
          },
          context,
        );
        const selected = appBuilderWorkflowState.get();
        expect("appSpec" in selected && selected.appSpec.digest).toBe(draft.digest);
        expect(selected.phase).toBe("app_spec_accepted");
        expect(ports.prepare).toHaveBeenCalledTimes(1);
      });
      it("leaves an unchanged accepted artifact and prepared work reusable", async () => {
        vi.stubEnv("EVE_HOSTED_ADAPTER", hosted ? "1" : "0");
        const before = seed();
        const recorded = await recordArtifact.execute(
          { path: specArtifact.path, mediaType: "text/markdown", content: specArtifact.content },
          context,
        );
        expect(recorded).toMatchObject({ reused: true });
        expect(appBuilderWorkflowState.get()).toBe(before);
        const acceptance = await acceptAppSpec.execute(
          {
            appId: "inventory",
            expectedArtifactDigest: specArtifact.digest,
            expectedArtifactRevision: specArtifact.revision,
          },
          context,
        );
        expect(acceptance).toMatchObject({ reused: true });
        expect(appBuilderWorkflowState.get()).toBe(before);
        expect(ports.prepare).not.toHaveBeenCalled();
      });
    },
  );
}
it("keeps validation-pending and publication mutation fences ahead of artifact storage", async () => {
  for (const phase of ["validation_pending", "publication_pending"] as const) {
    const before = seed(phase);
    // oxlint-disable-next-line eslint/no-await-in-loop -- The singleton workflow must be reseeded and checked serially.
    await expect(
      recordArtifact.execute(
        {
          path: "prototype/inventory/decisions.md",
          mediaType: "text/markdown",
          content: "New notes",
        },
        context,
      ),
    ).rejects.toThrow();
    expect(appBuilderWorkflowState.get()).toBe(before);
  }
});
