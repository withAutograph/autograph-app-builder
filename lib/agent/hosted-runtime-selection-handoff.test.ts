import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import type { HostedRuntimeApprovalEnvelope } from "./prepare-app-hosted-runtime-step";
import { prepareHostedRuntimeWithOperator } from "./prepare-app-hosted-runtime-step";
import { preparedRuntimeReferences, preparedRuntimeSelections } from "./prepared-runtime-selection";
import { resolveHostedRuntimePreparationSelection } from "./hosted-runtime-selection-handoff";
import startAppPreview from "../../agent/tools/start_app_preview";
import retainHostedRuntimeSelectionHook from "../../agent/hooks/retain-hosted-runtime-selection";
import { appBuilderWorkflowState } from "./workflow-state";

const mocks = vi.hoisted(() => ({
  assertReferenceCurrent: vi.fn(),
  getOperatorClient: vi.fn(),
  loadApprovedReference: vi.fn(),
  startWorkingPreview: vi.fn(),
  stateStorage: { getStore: (): Map<string, unknown> | undefined => undefined },
}));
const stateStorage = new AsyncLocalStorage<Map<string, unknown>>();
mocks.stateStorage.getStore = () => stateStorage.getStore();

// SAFETY: Eve's context package is intentionally replaced with this ALS-backed
// state facade so this regression can distinguish the real step and owner contexts.
/* oxlint-disable anti-slop/no-module-mocking -- Boundary modules must be isolated to exercise distinct Eve context maps without provider calls. */
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- The ALS state facade deliberately stores opaque Eve state values, and mock factories mirror the untyped Eve boundary. */
vi.mock("eve/context", () => ({
  defineState: (name: string, initial: () => unknown) => ({
    get: () => {
      const store = mocks.stateStorage.getStore();
      if (store === undefined) {
        throw new Error("Eve state requires an active fixture context");
      }
      if (!store.has(name)) {
        store.set(name, initial());
      }
      return store.get(name);
    },
    update: (change: (current: unknown) => unknown) => {
      const store = mocks.stateStorage.getStore();
      if (store === undefined) {
        throw new Error("Eve state requires an active fixture context");
      }
      if (!store.has(name)) {
        store.set(name, initial());
      }
      store.set(name, change(store.get(name)));
    },
  }),
}));
vi.mock("eve/hooks", () => ({ defineHook: (value: unknown) => value }));
vi.mock("eve/tools", () => ({ defineTool: (value: unknown) => value }));
vi.mock("./hosted-runtime-approved-reference", () => ({
  assertHostedRuntimeApprovedReference: mocks.assertReferenceCurrent,
  loadHostedRuntimeApprovedReference: mocks.loadApprovedReference,
}));
vi.mock("../provisioning/hosted-operator-client", () => ({
  hostedOperatorClientForSession: mocks.getOperatorClient,
}));
vi.mock("../../lib/sandbox/working-preview-runtime", () => ({
  startWorkingPreview: mocks.startWorkingPreview,
}));

const appId = "spend-review";
const operationRef = "11111111-1111-4111-8111-111111111111";
const publicSessionId = "owned-public-session";
const adapterSessionId = "owned-adapter-session";
const selection = {
  appId,
  branch: "preview",
  environment: "preview" as const,
  projectId: "prj_fixture",
  sessionId: publicSessionId,
};
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  contextId: "fixture-context",
  cost: { class: "shared-recovery-group", description: "Fixture", owner: "Fixture owner" },
  delivery: { branch: selection.branch, projectId: selection.projectId, repoId: "repo-app" },
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority,
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: {
      deploymentId: "dpl_operator",
      environment: "preview",
      projectId: "prj_operator",
    },
    teamId: "team_fixture",
    verification: {
      gatewayOrigin: "https://gateway-preview.example.test",
      jwksUrl: "https://gateway-preview.example.test/_platform/jwks.json",
      publicOrigin: "https://apps-preview.example.test",
    },
  },
  effects: [
    { description: "Verify selected resources", id: "resources", kind: "resources" },
    { description: "Install checked release", id: "install", kind: "install" },
    { description: "Grant approved access", id: "access", kind: "access" },
    { description: "Bind runtime credentials", id: "bind", kind: "bindings" },
    { description: "Deliver native app", id: "delivery", kind: "delivery" },
    { description: "Deliver native Gateway", id: "gateway-delivery", kind: "gateway-delivery" },
  ],
  gatewayDelivery: {
    branch: selection.branch,
    projectId: "prj_gateway",
    repoId: "repo-gateway",
  },
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_fixture",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});
const planDigest = operatorPlanDigest(plan);
const approvedInput = {
  appId,
  branch: selection.branch,
  environment: selection.environment,
  operationRef,
  plan,
  planDigest,
  projectId: selection.projectId,
} satisfies HostedRuntimeApprovalEnvelope;
const output = (overrides: Record<string, unknown> = {}) => ({
  appId,
  authenticatedBehavior: "unassessed" as const,
  operationRef,
  planDigest,
  status: "prepared" as const,
  ...overrides,
});
const approvedSnapshot = {
  adapterGeneration: 3,
  adapterSessionId,
  cancellationRevision: 0,
  sessionId: publicSessionId,
};
const ownerCtx = {
  abortSignal: new AbortController().signal,
  session: { auth: { current: null, initiator: null }, id: adapterSessionId },
};

const nativeBindings = () => {
  const ref = operationRef;
  return {
    environment: {},
    nativePreview: {
      app: {
        branch: selection.branch,
        deploymentId: "dpl_actual_app",
        operationRef: ref,
        origin: "https://immutable-app.example.test",
        projectId: selection.projectId,
        readyState: "READY",
        repoId: "repo-app",
      },
      expiresAt: plan.retention.expiresAt,
      gateway: {
        branch: selection.branch,
        deploymentId: "dpl_actual_gateway",
        operationRef: ref,
        origin: "https://immutable-gateway.example.test",
        projectId: "prj_gateway",
        readyState: "READY",
        repoId: "repo-gateway",
      },
      operationRef: ref,
      planDigest,
      publicOrigin: "https://apps-preview.example.test",
      verifiedAt: "2026-10-09T12:00:00.000Z",
    },
    operationRef: ref,
    plan,
    proof: {
      actors: 1,
      artifactHash: plan.release.sha256,
      authenticatedBehavior: "unassessed" as const,
      manifestSha256: plan.release.sha256,
      releaseId: plan.release.id,
      tenants: 1,
    },
  };
};

const inContext = async <T>(run: (store: Map<string, unknown>) => T | Promise<T>) => {
  const store = new Map<string, unknown>();
  return await stateStorage.run(store, async () => await run(store));
};
const retainedReference = () => ({ appId, operationRef, planDigest });
const runPreparationStep = async (observed: boolean) =>
  await inContext(async (stepState) => {
    const operator = {
      authIdentityInput: vi.fn(),
      request: vi.fn().mockResolvedValue(output()),
      sessionId: publicSessionId,
    };
    const result = await prepareHostedRuntimeWithOperator(
      approvedInput,
      {
        abortSignal: new AbortController().signal,
        callId: observed ? "observed-call" : "immediate-call",
        session: { id: adapterSessionId },
      },
      operator,
      (value) => {
        preparedRuntimeSelections.update((current) => ({ ...current, [appId]: value }));
      },
      {
        createResourceMismatch: () => new HostedOperatorError("resource_mismatch"),
        digest: operatorPlanDigest,
        isOperatorError: (error): error is InstanceType<typeof HostedOperatorError> =>
          error instanceof HostedOperatorError,
        sameSelection: sameOperatorSelection,
      },
      ...(observed ? [output()] : []),
    );
    expect(result.result).toMatchObject({ appId, operationRef, planDigest, status: "prepared" });
    expect(preparedRuntimeSelections.get()[appId]).toMatchObject({
      appId,
      operationRef,
      planDigest,
    });
    expect(stepState).not.toBeUndefined();
    expect(operator.request).toHaveBeenCalledTimes(observed ? 0 : 1);
    return {
      output: structuredClone(result.result),
      stepState,
    };
  });

const actionResult = (toolOutput: unknown) => ({
  data: {
    result: {
      kind: "tool-result",
      output: toolOutput,
      toolName: "prepare-app-hosted-runtime",
    },
    status: "completed",
  },
});
const hookHandler = () => {
  const hook: unknown = retainHostedRuntimeSelectionHook;
  // SAFETY: the production hook declares the action.result handler; this test invokes that registered event directly.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the event shape is declared by the imported hook.
  return (hook as { events: { "action.result": (event: unknown) => void } }).events[
    "action.result"
  ];
};
const previewToolContext = (getSandbox: ReturnType<typeof vi.fn>) => ({
  abortSignal: new AbortController().signal,
  callId: "preview-call",
  getSandbox,
  session: { auth: ownerCtx.session.auth, id: adapterSessionId },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadApprovedReference.mockResolvedValue({
    input: approvedInput,
    snapshot: approvedSnapshot,
  });
  mocks.assertReferenceCurrent.mockImplementation(() => Promise.resolve());
  mocks.getOperatorClient.mockResolvedValue({
    bindings: vi.fn().mockResolvedValue(nativeBindings()),
    sessionId: publicSessionId,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("hosted runtime selection handoff across Eve contexts", () => {
  it.each(["immediate", "observed"] as const)(
    "rebinds the %s step result in its owner context before native Preview",
    async (mode) => {
      const { output: toolOutput, stepState } = await runPreparationStep(mode === "observed");
      const ownerState = new Map<string, unknown>();
      expect(stepState).not.toBe(ownerState);

      let serializedOwnerState = "";
      stateStorage.run(ownerState, () => {
        expect(preparedRuntimeSelections.get()).toEqual({});
        const handler = hookHandler();
        handler(actionResult(toolOutput));
        expect(preparedRuntimeReferences.get()).toEqual({ [appId]: retainedReference() });
        expect(preparedRuntimeSelections.get()).toEqual({});
        serializedOwnerState = JSON.stringify({
          references: preparedRuntimeReferences.get(),
          selections: preparedRuntimeSelections.get(),
        });
      });

      // SAFETY: this is the exact JSON serialization of the owner state created just above.
      const restored = z
        .object({
          references: z.record(z.string(), z.unknown()),
          selections: z.record(z.string(), z.unknown()),
        })
        .parse(JSON.parse(serializedOwnerState));
      await inContext(async () => {
        // SAFETY: restored references/selections came from their corresponding owner state definitions.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: JSON was parsed against the shape created above.
        preparedRuntimeReferences.update(() => restored.references as never);
        // SAFETY: restored selection state is the serialized value emitted by the selection state definition.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: state is restored into its matching definition.
        preparedRuntimeSelections.update(() => restored.selections as never);
        appBuilderWorkflowState.update(
          // SAFETY: minimal state fixture provides fields read by the real Preview tool.
          () =>
            // SAFETY: native preview reads only these accepted app identity fields.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: state is a minimal relevant fixture.
            ({
              appSpec: { appId },
              identityReceipt: { identity: { appId, baseRoutes: ["/spend-review"] } },
              phase: "app_spec_accepted",
            }) as never,
        );
        const getSandbox = vi.fn(() => {
          throw new Error("Native Preview must not use a Sandbox");
        });
        const preview: unknown = await startAppPreview.execute(
          {
            appId,
            command: { args: [], executable: "node" },
            landingPath: "/",
            port: 3000,
            workingDirectory: ".",
          },
          // SAFETY: fixture context includes the session, cancellation signal, and Sandbox spy used by Preview.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: this fixture supplies every context field consumed by the real tool path.
          previewToolContext(getSandbox) as never,
        );
        expect(preview).toMatchObject({
          workingPreview: {
            appId,
            status: "ready",
            url: "https://apps-preview.example.test/spend-review",
          },
        });
        expect(getSandbox).not.toHaveBeenCalled();
        expect(mocks.startWorkingPreview).not.toHaveBeenCalled();
        expect(mocks.loadApprovedReference).toHaveBeenCalledWith(
          { appId, operationRef },
          // oxlint-disable-next-line typescript/no-unsafe-assignment -- SAFETY: Vitest's matcher is an opaque call assertion.
          expect.objectContaining({ session: expect.objectContaining({ id: adapterSessionId }) }),
        );
        expect(mocks.assertReferenceCurrent).toHaveBeenCalledWith(
          approvedSnapshot,
          expect.anything(),
        );
        expect(preparedRuntimeSelections.get()[appId]).toMatchObject({
          appId,
          operationRef,
          planDigest,
          projectId: selection.projectId,
          sessionId: publicSessionId,
        });
        expect(preparedRuntimeReferences.get()).toEqual({});
      });
    },
  );

  it.each([
    ["missing", { appId, status: "prepared" }],
    ["malformed", { ...output(), planDigest: "private-not-a-digest" }],
  ] as const)("blocks Sandbox fallback for %s protected reference", async (_name, malformed) => {
    await inContext(async () => {
      preparedRuntimeReferences.update(() => ({
        other: { ...retainedReference(), appId: "other" },
      }));
      hookHandler()(actionResult(malformed));
      expect(preparedRuntimeReferences.get()).toMatchObject({
        other: { appId: "other" },
        [appId]: null,
      });
      expect(preparedRuntimeSelections.get()).toEqual({});
      appBuilderWorkflowState.update(
        // SAFETY: minimal state fixture provides fields read by the real Preview tool.
        () =>
          // SAFETY: native preview reads only these accepted app identity fields.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: state is a minimal relevant fixture.
          ({
            appSpec: { appId },
            identityReceipt: { identity: { appId, baseRoutes: ["/spend-review"] } },
            phase: "app_spec_accepted",
          }) as never,
      );
      const getSandbox = vi.fn();
      await expect(
        startAppPreview.execute(
          {
            appId,
            command: { args: [], executable: "node" },
            landingPath: "/",
            port: 3000,
            workingDirectory: ".",
          },
          // SAFETY: fixture context includes the session, cancellation signal, and Sandbox spy used by Preview.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: this fixture supplies every context field consumed by the real tool path.
          previewToolContext(getSandbox) as never,
        ),
      ).rejects.toThrow(HostedOperatorError);
      expect(getSandbox).not.toHaveBeenCalled();
      expect(mocks.startWorkingPreview).not.toHaveBeenCalled();
      expect(preparedRuntimeReferences.get()).toMatchObject({
        other: { appId: "other" },
        [appId]: null,
      });
    });
  });

  it("ignores unrelated, failed, and blocked results without changing other app references", async () => {
    await inContext(() => {
      const other = { appId: "other", operationRef, planDigest };
      preparedRuntimeReferences.update(() => ({ other }));
      const handler = hookHandler();
      handler(actionResult(output({ status: "blocked" })));
      handler({
        data: {
          result: { kind: "tool-result", output: output(), toolName: "get-app-hosted-runtime" },
          status: "completed",
        },
      });
      handler({
        data: {
          result: { kind: "tool-result", output: output(), toolName: "prepare-app-hosted-runtime" },
          status: "failed",
        },
      });
      expect(preparedRuntimeReferences.get()).toEqual({ other });
      expect(preparedRuntimeSelections.get()).toEqual({});
    });
  });

  it.each([
    ["wrong app plan", { ...approvedInput, appId: "another-app" }, approvedSnapshot, "assert"],
    [
      "mismatched digest",
      { ...approvedInput, planDigest: "c".repeat(64) },
      approvedSnapshot,
      "assert",
    ],
    [
      "wrong owner",
      approvedInput,
      { ...approvedSnapshot, adapterSessionId: "other-adapter" },
      "assert",
    ],
    ["cancelled reader", approvedInput, approvedSnapshot, "cancelled"],
    ["rebound reference", approvedInput, approvedSnapshot, "rebound"],
  ] as const)(
    "does not commit a full selection after %s",
    async (_name, loadedInput, snapshot, failure) => {
      await inContext(async () => {
        hookHandler()(actionResult(output()));
        mocks.loadApprovedReference.mockReturnValueOnce(
          Promise.resolve({ input: loadedInput, snapshot }),
        );
        if (failure === "cancelled") {
          mocks.assertReferenceCurrent.mockRejectedValueOnce(
            new HostedOperatorError("authorization_required"),
          );
        } else if (failure === "rebound") {
          mocks.assertReferenceCurrent.mockImplementationOnce(() => {
            preparedRuntimeReferences.update((current) => ({
              ...current,
              [appId]: {
                ...retainedReference(),
                operationRef: "22222222-2222-4222-8222-222222222222",
              },
            }));
          });
        }
        await expect(
          resolveHostedRuntimePreparationSelection({
            appId,
            sessionAuth: ownerCtx.session.auth,
            sessionId: adapterSessionId,
          }),
        ).rejects.toThrow();
        expect(preparedRuntimeSelections.get()).toEqual({});
        expect(preparedRuntimeReferences.get()[appId]).toBeDefined();
        expect(mocks.getOperatorClient).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps a pending reference through Stop and recovers it from the next approved result", async () => {
    await inContext(async () => {
      hookHandler()(actionResult(output()));
      const controller = new AbortController();
      controller.abort();
      await expect(
        resolveHostedRuntimePreparationSelection({
          appId,
          sessionAuth: ownerCtx.session.auth,
          sessionId: adapterSessionId,
          signal: controller.signal,
        }),
      ).rejects.toThrow();
      expect(preparedRuntimeSelections.get()).toEqual({});
      expect(preparedRuntimeReferences.get()[appId]).toEqual(retainedReference());
      expect(mocks.loadApprovedReference).not.toHaveBeenCalled();

      hookHandler()(actionResult(output({ operationRef: "22222222-2222-4222-8222-222222222222" })));
      expect(preparedRuntimeReferences.get()[appId]).toEqual({
        ...retainedReference(),
        operationRef: "22222222-2222-4222-8222-222222222222",
      });
      mocks.loadApprovedReference.mockResolvedValueOnce({
        input: {
          ...approvedInput,
          operationRef: "22222222-2222-4222-8222-222222222222",
        },
        snapshot: approvedSnapshot,
      });
      const recovered = await resolveHostedRuntimePreparationSelection({
        appId,
        sessionAuth: ownerCtx.session.auth,
        sessionId: adapterSessionId,
      });
      expect(recovered).toMatchObject({
        appId,
        operationRef: "22222222-2222-4222-8222-222222222222",
        planDigest,
      });
      expect(preparedRuntimeReferences.get()).toEqual({});
      expect(preparedRuntimeSelections.get()[appId]).toEqual(recovered);
    });
  });

  it("uses a legacy full selection only when no owner handoff reference exists", async () => {
    await inContext(async () => {
      const legacy = {
        appId,
        branch: selection.branch,
        operationRef,
        planDigest,
        projectId: selection.projectId,
        sessionId: publicSessionId,
      };
      preparedRuntimeSelections.update(() => ({ [appId]: legacy }));
      expect(
        await resolveHostedRuntimePreparationSelection({
          appId,
          sessionAuth: ownerCtx.session.auth,
          sessionId: adapterSessionId,
        }),
      ).toEqual(legacy);
      expect(mocks.loadApprovedReference).not.toHaveBeenCalled();
      expect(mocks.assertReferenceCurrent).not.toHaveBeenCalled();
    });
  });
});
