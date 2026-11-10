/* oxlint-disable typescript/no-unsafe-type-assertion -- Preserve the existing test fixtures and asserted runtime boundaries. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import acceptAppSpec from "../../agent/tools/accept_app_spec";
import { BUILD_READY_APP_SPEC } from "../../evals/support/app-spec";
import { normalizeBuildReadyAppSpec } from "./app-spec-validation";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState, sha256 } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { AppAccessIntent } from "./app-access-intent";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), projection: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Acceptance state reuse is isolated from the private transport persistence port; projection routing has separate actual-profile tests.
vi.mock("./approved-build-continuation-runtime", () => ({
  emitCurrentBuildWorkflowProjection: mocks.projection,
}));
const responsePrompt = z.object({
  productAcceptance: z.object({ implementationPrompt: z.string() }),
});
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled eve/tools dependency used by this test.
vi.mock("eve/tools", () => ({ defineTool: <T>(value: T) => value }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled eve/context dependency used by this test.
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
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep the controlled ./prepare-app-creation dependency used by this test.
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
const declaredRoutes = ["/inventory-workspace/:path*", "/inventory-workspace", "/reports/:id"];
const plannedTarget = () => ({ plan: { topology: { routes: [...declaredRoutes] } } });
const unexpectedContextOperation = () => {
  throw new Error("Unexpected tool context operation");
};
const getSandbox = vi.fn(unexpectedContextOperation);
const context = {
  abortSignal: new AbortController().signal,
  callId: "retry-acceptance",
  getSandbox,
  getSkill: vi.fn(),
  getToken: unexpectedContextOperation,
  requireAuth: unexpectedContextOperation,
  session: {
    auth: { current: null, initiator: null },
    id: artifact.sessionId,
    turn: { id: "retry-acceptance-turn", sequence: 0 },
  },
  toolName: "accept_app_spec",
};

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
      proposal: { digest: "prepared-creation", target: plannedTarget() },
      reviewReceipt: { digest: "review" },
      validationAttempt: { digest: "validation-attempt" },
      validationReceipt: { digest: "validation" },
    });
  }
  // SAFETY: this fixture supplies the acceptance fields; unrelated receipt internals are opaque sentinels whose identity must remain unchanged.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Preserve the existing test fixture or assertion boundary.
  const state = fixture as AppBuilderWorkflowState;
  appBuilderWorkflowState.update(() => state);
  return state;
};

describe("accepted AppSpec resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockResolvedValue(null);
  });

  it("records explicitly requested signup as product intent without granting access", async () => {
    seed("planned");
    const access: AppAccessIntent = {
      mode: "self-signup",
      eligibility: "approved-email",
      allowedEmails: ["Pilot@example.test"],
      appRoles: ["member"],
    };
    const result = await acceptAppSpec.execute({ appId: artifact.appId, access }, context);
    expect(result).toMatchObject({
      access: { ...access, allowedEmails: ["pilot@example.test"] },
      reused: false,
    });
    const state = appBuilderWorkflowState.get();
    expect(state.phase).toBe("app_spec_accepted");
    expect("appSpec" in state && state.appSpec.access).toEqual({
      ...access,
      allowedEmails: ["pilot@example.test"],
    });
    expect(state).not.toHaveProperty("applyReceipt");
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("retains the existing signup choice on a normal product revision", async () => {
    const before = seed("planned");
    const access: AppAccessIntent = {
      mode: "self-signup",
      eligibility: "public",
      appRoles: ["member"],
    };
    const revised = {
      ...artifact,
      content: `${legacyContent}\nA revised user workflow.`,
      revision: "b".repeat(64),
    };
    appBuilderWorkflowState.update(
      () =>
        // SAFETY: The seeded workflow retains all phase-required fields; this fixture changes only its accepted access and artifact.
        ({
          ...before,
          appSpec: { ...accepted, access },
          artifacts: [revised],
        }) as AppBuilderWorkflowState,
    );
    expect(await acceptAppSpec.execute({ appId: artifact.appId }, context)).toMatchObject({
      access,
      artifactRevision: revised.revision,
      reused: false,
    });
  });

  it("records an explicit switch back to private rather than silently retaining signup", async () => {
    const before = seed("planned");
    appBuilderWorkflowState.update(
      () =>
        // SAFETY: The seeded workflow retains its phase-required fields while the fixture selects an explicit signup policy.
        ({
          ...before,
          appSpec: {
            ...accepted,
            access: { mode: "self-signup", eligibility: "public", appRoles: ["member"] },
          },
        }) as AppBuilderWorkflowState,
    );
    expect(
      await acceptAppSpec.execute({ appId: artifact.appId, access: { mode: "private" } }, context),
    ).toMatchObject({
      access: { mode: "private" },
      reused: false,
    });
  });

  it("rejects an ambiguous email eligibility list before accepting signup intent", async () => {
    const before = seed("planned");
    await expect(
      acceptAppSpec.execute(
        {
          appId: artifact.appId,
          access: {
            mode: "self-signup",
            eligibility: "approved-email",
            allowedEmails: ["pilot@example.test", "PILOT@example.test"],
            appRoles: ["member"],
          },
        },
        context,
      ),
    ).rejects.toThrow("must be unique");
    expect(appBuilderWorkflowState.get()).toBe(before);
  });

  it("keeps private setup unchanged when a signup request mixes public and restricted eligibility", async () => {
    const before = seed("planned");
    await expect(
      acceptAppSpec.execute(
        {
          appId: artifact.appId,
          access: {
            mode: "self-signup",
            eligibility: "public",
            allowedEmails: ["pilot@example.test"],
            appRoles: ["member"],
          },
        },
        context,
      ),
    ).rejects.toThrow("cannot also declare");
    expect(appBuilderWorkflowState.get()).toBe(before);
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
    expect(sha256(normalizeBuildReadyAppSpec(legacyContent))).toBe(accepted.digest);
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
      implementationRouting: { routes: declaredRoutes },
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

  it("includes automatically planned routes in a new design handoff and retains them on resume", async () => {
    const before = seed("prepared", false);
    Reflect.deleteProperty(before, "appSpec");
    mocks.prepare.mockImplementationOnce(() => {
      const current = appBuilderWorkflowState.get();
      // SAFETY: The fixture supplies the saved plan consumed by the handoff; planning execution remains the isolated port above.
      appBuilderWorkflowState.update(
        () =>
          ({
            ...current,
            phase: "planned",
            proposal: { digest: "prepared-creation", target: plannedTarget() },
          }) as AppBuilderWorkflowState,
      );
    });
    const first = await acceptAppSpec.execute({ appId: artifact.appId }, context);
    expect(first).toMatchObject({
      appId: artifact.appId,
      implementationRouting: { routes: declaredRoutes },
      reused: false,
    });
    const planned = appBuilderWorkflowState.get();
    if (!("proposal" in planned) || !("artifacts" in before)) {
      throw new Error("Expected the accepted design and saved plan.");
    }
    expect(planned.artifacts).toBe(before.artifacts);
    expect(planned.workspace).toBe(before.workspace);
    expect(planned.sourceReceipt).toBe(before.sourceReceipt);
    expect(planned.appSpec.appId).toBe(artifact.appId);
    expect(planned.appSpec.artifactRevision).toBe(artifact.revision);
    expect(planned.proposal.target.plan.topology.routes).toEqual(declaredRoutes);
    expect(await acceptAppSpec.execute({ appId: artifact.appId }, context)).toMatchObject({
      implementationRouting: { routes: declaredRoutes },
      reused: true,
    });
    expect(appBuilderWorkflowState.get()).toBe(planned);
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(getSandbox).not.toHaveBeenCalled();
  });

  it("plans an explicit framework upgrade for an unchanged already accepted product spec", async () => {
    const before = seed("planned");
    mocks.prepare.mockImplementationOnce(() => {
      expect(appBuilderWorkflowState.get()).toMatchObject({
        phase: "app_spec_accepted",
        appSpec: { frameworkUpgrade: "latest", digest: accepted.digest },
      });
      const current = appBuilderWorkflowState.get();
      appBuilderWorkflowState.update(
        () =>
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- The workflow fixture retains only fields observed by this acceptance scenario.; Preserve the existing type assertion at this boundary.
          ({
            ...current,
            phase: "planned",
            proposal: {
              digest: "upgrade-plan",
              target: {
                frameworkUpgrade: {
                  scope: "workspace",
                  versions: {
                    next: "16.4.3",
                    react: "19.3.1",
                    reactDom: "19.3.1",
                    typesReact: "19.3.0",
                    typesReactDom: "19.3.0",
                  },
                },
              },
            },
          }) as unknown as AppBuilderWorkflowState,
      );
    });
    const result = await acceptAppSpec.execute(
      { appId: artifact.appId, frameworkUpgrade: "latest" },
      context,
    );
    expect(result).toMatchObject({
      frameworkUpgradePlan: {
        scope: "workspace",
        sharedPaths: ["package.json", "bun.lock"],
        versions: { next: "16.4.3" },
      },
    });
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(appBuilderWorkflowState.get()).not.toBe(before);
    const planned = appBuilderWorkflowState.get();
    await acceptAppSpec.execute({ appId: artifact.appId, frameworkUpgrade: "latest" }, context);
    expect(appBuilderWorkflowState.get()).toBe(planned);
    expect(mocks.prepare).toHaveBeenCalledOnce();
  });
  it("accepts a newly recorded raw revision instead of reusing an older acceptance", async () => {
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
