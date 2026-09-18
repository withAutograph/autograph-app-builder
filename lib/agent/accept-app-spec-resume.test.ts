import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import acceptAppSpec from "../../agent/tools/accept_app_spec";
import { BUILD_READY_APP_SPEC } from "../../evals/support/app-spec";
import { normalizeBuildReadyAppSpec } from "./app-spec-validation";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

const mocks = vi.hoisted(() => ({ prepare: vi.fn() }));
const responsePrompt = z.object({
  productAcceptance: z.object({ implementationPrompt: z.string() }),
});
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T) => value }));
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
vi.mock("./prepare-app-creation", () => ({ prepareAppCreation: mocks.prepare }));

const legacyContent = BUILD_READY_APP_SPEC.replace(
  '"status": "build-ready"',
  '"status": "build-ready", "owner": "operations", "schema": { "kind": "none" }, "additionalPublicRoutes": [], "optionalCapabilities": { "hostedResources": [], "integrations": [] }',
);
const artifact = {
  appId: "inventory",
  content: legacyContent,
  digest: sha256(legacyContent),
  mediaType: "text/markdown" as const,
  path: "prototype/inventory/app-spec.md",
  recordedByCallId: "recorded",
  revision: "a".repeat(64),
  sessionId: "session",
};
const accepted = {
  acceptedByCallId: "accepted",
  appId: artifact.appId,
  artifactPath: artifact.path,
  artifactRevision: artifact.revision,
  content: legacyContent,
  digest: artifact.digest,
};
const getSandbox = vi.fn();
// SAFETY: acceptance uses only these context fields; preparation is mocked and must not request a sandbox during reuse.
const context = {
  callId: "retry-acceptance",
  getSandbox,
  getSkill: vi.fn(),
  session: { id: artifact.sessionId },
} as unknown as Parameters<typeof acceptAppSpec.execute>[1];

const seed = (phase: AppBuilderWorkflowState["phase"], prepared = true) => {
  const fixture = {
    appSpec: accepted,
    artifacts: [artifact],
    dependencyReceipt: { digest: "dependency" },
    identityReceipt: { digest: "identity" },
    phase,
    preparedByCallId: "prepared",
    sourceReceipt: { digest: "source" },
    version: APP_BUILDER_WORKFLOW_VERSION,
    workspace: { workspaceDigest: "workspace" },
  };
  if (prepared) {
    Object.assign(fixture, {
      applyReceipt: { digest: "apply" },
      proposal: { digest: "prepared-creation" },
      reviewReceipt: { digest: "review" },
      validationAttempt: { digest: "validation-attempt" },
      validationReceipt: { digest: "validation" },
    });
  }
  // SAFETY: this fixture supplies the acceptance fields; unrelated receipt internals are opaque sentinels whose identity must remain unchanged.
  const state = fixture as AppBuilderWorkflowState;
  appBuilderWorkflowState.update(() => state);
  return state;
};

describe("accepted AppSpec resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockResolvedValue(null);
  });

  it.each([
    "planned",
    "apply_failed",
    "applied",
    "validation_pending",
    "validation_failed",
    "validated",
    "reviewed",
    "publication_pending",
    "published_local",
  ] as const)("reuses the exact legacy snapshot and receipts in %s", async (phase) => {
    const before = seed(phase);
    expect(sha256(normalizeBuildReadyAppSpec(legacyContent))).not.toBe(accepted.digest);
    const result = await acceptAppSpec.execute(
      {
        appId: artifact.appId,
        expectedArtifactDigest: artifact.digest,
        expectedArtifactRevision: artifact.revision,
      },
      context,
    );
    expect(result).toMatchObject({
      ...accepted,
      productAcceptance: {
        appSpecDigest: accepted.digest,
        walkthrough: "User accepted this AppSpec.",
      },
      reused: true,
    });
    expect(responsePrompt.parse(result).productAcceptance.implementationPrompt).toContain(
      "User accepted this AppSpec.",
    );
    expect(appBuilderWorkflowState.get()).toBe(before);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it.each(["app_spec_accepted", "dependencies_prepared", "identity_resolved"] as const)(
    "continues incomplete %s preparation with the original digest",
    async (phase) => {
      const before = seed(phase, false);
      expect(await acceptAppSpec.execute({ appId: artifact.appId }, context)).toMatchObject({
        ...accepted,
        productAcceptance: { appSpecDigest: accepted.digest },
        reused: true,
      });
      expect(appBuilderWorkflowState.get()).toBe(before);
      expect(mocks.prepare).toHaveBeenCalledOnce();
    },
  );

  it("normalizes a newly recorded revision instead of reusing an older acceptance", async () => {
    const state = seed("planned");
    if (!("artifacts" in state)) {
      throw new Error("Expected a prepared workspace.");
    }
    const content = legacyContent.replace("Confirmed outcome.", "A revised product outcome.");
    const revised = { ...artifact, content, digest: sha256(content), revision: "b".repeat(64) };
    appBuilderWorkflowState.update(() => ({ ...state, artifacts: [revised] }));
    const result = await acceptAppSpec.execute({ appId: artifact.appId }, context);
    expect(result).toMatchObject({
      artifactRevision: revised.revision,
      content: normalizeBuildReadyAppSpec(content),
      digest: sha256(normalizeBuildReadyAppSpec(content)),
      productAcceptance: {
        appSpecDigest: sha256(normalizeBuildReadyAppSpec(content)),
        walkthrough: "User accepted this AppSpec.",
      },
      reused: false,
    });
    expect(responsePrompt.parse(result).productAcceptance.implementationPrompt).toContain(
      "User accepted this AppSpec.",
    );
    expect(appBuilderWorkflowState.get().phase).toBe("app_spec_accepted");
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });

  it("rejects stale requested artifact evidence before reusing the snapshot", async () => {
    const before = seed("planned");
    await expect(
      acceptAppSpec.execute(
        {
          appId: artifact.appId,
          expectedArtifactDigest: "0".repeat(64),
        },
        context,
      ),
    ).rejects.toThrow("Create a product design");
    expect(appBuilderWorkflowState.get()).toBe(before);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
