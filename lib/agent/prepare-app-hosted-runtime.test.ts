import {
  reportRuntimePreparationFailure,
  reportRuntimePreparationStarted,
} from "../provisioning/hosted-operator-consent-diagnostic";
import type { ToolInputRequest, ToolInputResponse, WorkflowToolContext } from "eve/tools";
import type {
  OperatorPublicResult,
  HostedOperatorError,
} from "../provisioning/hosted-operator-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareHostedRuntimeWithOperator } from "./prepare-app-hosted-runtime-step";
import type { prepareHostedRuntimeStep } from "./prepare-app-hosted-runtime-step";
import {
  continueHostedRuntimePreparation,
  evaluateHostedRuntimePreparationApproval,
  hostedRuntimeApprovalInputSchema,
  participantIdentityInputQuestion,
  realmIdentityInputQuestion,
} from "../../agent/tools/prepare-app-hosted-runtime";
import {
  HostedOperatorError as HostedOperatorErrorClass,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import type { PreparedRuntimeSelection } from "./prepared-runtime-selection";

const stepMocks = { step: vi.fn<typeof prepareHostedRuntimeStep>() };

const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context",
  cost: { class: "independent-service", description: "fixture", owner: "fixture" },
  deploymentBoundary: {
    app: {
      branch: "feature",
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: "prj_app",
    },
    authority: {
      audience: "https://builder.example/mcp",
      issuer: "https://builder.example/api/auth",
      ownerUserId: "owner",
      workspaceId: "workspace",
    },
    gateway: {
      branch: "feature",
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: { deploymentId: "dpl_operator", environment: "preview", projectId: "prj_operator" },
    teamId: "team_1",
    verification: {
      gatewayOrigin: "https://gateway.example",
      jwksUrl: "https://gateway.example/_platform/jwks.json",
      publicOrigin: "https://public.example",
    },
  },
  effects: [
    { description: "resources", id: "resources", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bind", id: "bind", kind: "bindings" },
    { description: "Bind owned Gateway Auth.", id: "gateway-bindings", kind: "gateway-bindings" },
  ],
  gatewayBindings: {
    authBrowserOrigin: "https://auth.example.test",
    builderCallbackOrigin: "https://builder.example.test",
    catalogAppIds: ["spend-review"],
    operatorOrigin: "https://operator.example",
    sourceWorkload: {
      audience: "https://vercel.com/fixture",
      environment: "preview",
      issuer: "https://oidc.vercel.com/fixture",
      ownerId: "team",
      projectId: "prj_gateway",
      subject: "observed-fixture",
    },
  },
  installer: { reference: "installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  publicGateway: { branch: "feature", origin: "https://public.example", projectId: "prj_gateway" },
  release: { artifactRef: "release", id: "v19", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "fixture" },
  selection: {
    appId: "spend-review",
    branch: "feature",
    environment: "preview",
    projectId: "prj_app",
    sessionId: "public-session",
  },
  version: 1,
});

const operationRef = "00000000-0000-4000-8000-000000000001";
const input = { ...plan.selection, operationRef, plan, planDigest: operatorPlanDigest(plan) };
const order: string[] = [];
const operator = {
  authIdentityInput: vi.fn(async () => {
    order.push("identity");
    return await Promise.resolve({
      browserUrl: "https://auth.example/link",
      expiresAt: "2027-01-01T00:00:00Z",
      operationRef,
      sessionId: "public-session",
    });
  }),
  request: vi.fn(async (): Promise<OperatorPublicResult> => {
    try {
      return await Promise.resolve({
        appId: "spend-review",
        authenticatedBehavior: "unassessed" as const,
        operationRef,
        status: "auth-schema-prepared" as const,
      });
    } finally {
      order.push("lease-released");
    }
  }),
  sessionId: "public-session",
};
const ctx = {
  abortSignal: new AbortController().signal,
  callId: "call",
  session: { id: "adapter-session" },
};
const retain = (selection: PreparedRuntimeSelection) => {
  order.push("selection");
  expect(selection).toEqual({
    appId: input.appId,
    branch: input.branch,
    operationRef,
    planDigest: input.planDigest,
    projectId: input.projectId,
    sessionId: "public-session",
  });
};
const contract = {
  createResourceMismatch: () => new HostedOperatorErrorClass("resource_mismatch"),
  digest: (value: typeof plan) => operatorPlanDigest(value),
  isOperatorError: (error: unknown): error is HostedOperatorError =>
    error instanceof HostedOperatorErrorClass,
  sameSelection: (left: typeof plan.selection, right: typeof plan.selection) =>
    sameOperatorSelection(left, right),
};
const participantPlan = hostedOperatorPlanSchema.parse({
  ...plan,
  stage: "auth-participants",
  gatewayBindings: undefined,
  normalActorProgram: {
    version: 1,
    appId: plan.selection.appId,
    origin: plan.deploymentBoundary?.verification.publicOrigin,
    actors: [
      {
        actorKey: "owner",
        email: "owner@example.test",
        name: "Owner",
        account: "capture-existing",
      },
    ],
    organizations: [],
    memberships: [],
    appAccess: [],
  },
  effects: [
    { id: "normal-accounts", kind: "normal-accounts", description: "Connect the approved account" },
  ],
});
const participantInput = {
  ...input,
  plan: participantPlan,
  planDigest: operatorPlanDigest(participantPlan),
};
const participantBlocked = {
  appId: input.appId,
  authenticatedBehavior: "unassessed" as const,
  operationRef,
  status: "blocked" as const,
  code: "auth_identity_required" as const,
};
const identityLink = {
  browserUrl: "https://auth.example/link",
  expiresAt: "2027-01-01T00:00:00Z",
  operationRef,
  sessionId: "public-session",
};
const workflowContext = (response: ToolInputResponse) => {
  const ask = vi.fn<WorkflowToolContext["ask"]>().mockResolvedValue(response);
  const context: WorkflowToolContext = {
    ...ctx,
    toolName: "prepare-app-hosted-runtime",
    session: {
      id: ctx.session.id,
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 0 },
    },
    ask,
    agents: {},
    agent: async () => await Promise.reject(new Error("No agent call is expected")),
    getToken: async () => await Promise.reject(new Error("No provider token is expected")),
    requireAuth: () => {
      throw new Error("No provider authorization is expected");
    },
  };
  return { context, ask };
};

describe("hosted runtime Auth identity handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stepMocks.step.mockReset();
    order.length = 0;
  });
  it("keeps the approval envelope strict while deferring the Node-backed plan parse", () => {
    const approvalInput = {
      appId: input.appId,
      branch: input.branch,
      environment: input.environment,
      operationRef: input.operationRef,
      plan: input.plan,
      planDigest: input.planDigest,
      projectId: input.projectId,
    };
    expect(hostedRuntimeApprovalInputSchema.parse(approvalInput)).toEqual(approvalInput);
    expect(
      hostedRuntimeApprovalInputSchema.safeParse({ ...approvalInput, unexpected: "field" }).success,
    ).toBe(false);
  });

  it("requests identity after execution finishes and the durable selection is retained", async () => {
    const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain, contract);
    expect(value.result.status).toBe("auth-schema-prepared");
    expect(value.identityInput?.browserUrl).toBe("https://auth.example/link");
    expect(order).toEqual(["lease-released", "selection", "identity"]);
    if (value.identityInput === null) {
      throw new Error("Missing actual identity input");
    }
    const ask = vi.fn(async (question: ToolInputRequest) => {
      order.push("public-input");
      expect(question.display).toBe("confirmation");
      expect(question.prompt).toContain(value.identityInput?.browserUrl ?? "missing");
      return await Promise.resolve({ optionId: "continue", status: "answered" as const });
    });
    await ask(realmIdentityInputQuestion(value.identityInput));
    expect(order).toEqual(["lease-released", "selection", "identity", "public-input"]);
    expect(operator.authIdentityInput).toHaveBeenCalledWith(
      { action: "auth-identity-input", operationRef, selection: plan.selection },
      ctx.abortSignal,
    );
  });

  it.each(["pending", "prepared", "blocked", "participants-prepared"] as const)(
    "does not request identity or resend execution for %s",
    async (status) => {
      operator.request.mockResolvedValueOnce({
        appId: input.appId,
        authenticatedBehavior: "unassessed",
        operationRef,
        status,
      });
      const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain, contract);
      expect(value.result.status).toBe(status);
      expect(operator.request).toHaveBeenCalledTimes(1);
      expect(operator.authIdentityInput).not.toHaveBeenCalled();
    },
  );

  it("retains bootstrap selection when readiness denies the link", async () => {
    operator.authIdentityInput.mockRejectedValueOnce(new Error("not ready"));
    const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain, contract);
    expect(value.result.status).toBe("blocked");
    expect(order).toEqual(["lease-released", "selection"]);
  });

  it.each(["dto", "error"])(
    "requests the approved participant sign-in link after real preflight denial %s",
    async (mode) => {
      if (mode === "dto") {
        operator.request.mockResolvedValueOnce(participantBlocked);
      } else {
        operator.request.mockRejectedValueOnce(
          new HostedOperatorErrorClass("auth_identity_required"),
        );
      }
      const value = await prepareHostedRuntimeWithOperator(
        participantInput,
        ctx,
        operator,
        vi.fn<(selection: PreparedRuntimeSelection) => void>(),
        contract,
      );
      expect(value.result).toMatchObject({ status: "blocked", code: "auth_identity_required" });
      expect(value.identityInput).toEqual(identityLink);
      expect(operator.authIdentityInput).toHaveBeenCalledWith(
        { action: "auth-identity-input", operationRef, selection: participantPlan.selection },
        ctx.abortSignal,
      );
      expect(operator.request).toHaveBeenCalledTimes(1);
    },
  );
  it("skips the legacy owner handoff when Auth bootstrap retains a participant program", async () => {
    const bootstrapWithProgram = hostedOperatorPlanSchema.parse({
      ...plan,
      normalActorProgram: participantPlan.normalActorProgram,
      stage: "auth-bootstrap",
      access: [],
      authSchema: {
        targetDigest: "c".repeat(64),
        artifactRef: "fixture-auth-plan",
        planDigest: "d".repeat(64),
        installer: { reference: "auth-worker", sha256: "e".repeat(64) },
      },
      bootstrap: {
        endpointId: "ep-fixture",
        maintenanceDatabase: "postgres",
        role: "maintenance_owner",
      },
      resourcesInstaller: { reference: "resource-worker", sha256: "f".repeat(64) },
      effects: [
        {
          description: "auth resources",
          id: "auth-resources",
          kind: "resources",
          resourceId: plan.authDatabase.resourceId,
        },
        {
          description: "app resources",
          id: "app-resources",
          kind: "resources",
          resourceId: plan.appDatabase.resourceId,
        },
        { description: "install Auth", id: "auth-install", kind: "install" },
        ...plan.effects.filter((effect) => effect.kind === "gateway-bindings"),
      ],
    });
    const value = await prepareHostedRuntimeWithOperator(
      {
        ...input,
        plan: bootstrapWithProgram,
        planDigest: operatorPlanDigest(bootstrapWithProgram),
      },
      ctx,
      operator,
      () => {},
      contract,
    );
    expect(value.result.status).toBe("auth-schema-prepared");
    expect(value.identityInput).toBeNull();
    expect(operator.authIdentityInput).not.toHaveBeenCalled();
  });
  it("keeps the legacy bootstrap question without resuming it as participant preparation", async () => {
    stepMocks.step.mockResolvedValueOnce({
      result: {
        appId: input.appId,
        authenticatedBehavior: "unassessed",
        operationRef,
        status: "auth-schema-prepared",
      },
      identityInput: identityLink,
    });
    const value = workflowContext({ status: "answered", optionId: "continue" });
    const result = await continueHostedRuntimePreparation(input, value.context, stepMocks.step);
    expect(result).toMatchObject({ status: "auth-schema-prepared", identityResponse: "answered" });
    expect(value.ask).toHaveBeenCalledWith(realmIdentityInputQuestion(identityLink));
    expect(stepMocks.step).toHaveBeenCalledTimes(1);
  });
  it("reports a real participant identity-link denial without requesting it again", async () => {
    operator.request.mockResolvedValueOnce(participantBlocked);
    operator.authIdentityInput.mockRejectedValueOnce(
      new HostedOperatorErrorClass("auth_identity_required"),
    );
    const value = await prepareHostedRuntimeWithOperator(
      participantInput,
      ctx,
      operator,
      () => {},
      contract,
    );
    expect(value.identityInput).toBeNull();
    expect(value.result).toMatchObject({ status: "blocked", code: "auth_identity_required" });
    expect(operator.authIdentityInput).toHaveBeenCalledTimes(1);
  });
  it("does not request participant sign-in for an unrelated authority denial", async () => {
    operator.request.mockRejectedValueOnce(new HostedOperatorErrorClass("authorization_required"));
    const value = await prepareHostedRuntimeWithOperator(
      participantInput,
      ctx,
      operator,
      () => {},
      contract,
    );
    expect(value.result).toMatchObject({ status: "blocked", code: "authorization_required" });
    expect(operator.authIdentityInput).not.toHaveBeenCalled();
  });
  it("resumes the same approved workflow input and call after the human answers normal sign-in", async () => {
    stepMocks.step
      .mockResolvedValueOnce({ result: participantBlocked, identityInput: identityLink })
      .mockResolvedValueOnce({
        result: {
          appId: input.appId,
          authenticatedBehavior: "unassessed",
          operationRef,
          status: "participants-prepared",
        },
        identityInput: null,
      });
    const value = workflowContext({ status: "answered", optionId: "continue" });
    const result = await continueHostedRuntimePreparation(
      participantInput,
      value.context,
      stepMocks.step,
    );
    expect(result).toMatchObject({ status: "participants-prepared", identityResponse: "answered" });
    expect(value.ask).toHaveBeenCalledWith(participantIdentityInputQuestion(identityLink));
    expect(stepMocks.step.mock.calls).toEqual([
      [participantInput, value.context],
      [participantInput, value.context],
    ]);
    expect(value.context.callId).toBe(ctx.callId);
  });
  it.each(["dismissed", "unavailable"] as const)(
    "keeps the actual blocked result when normal sign-in is %s",
    async (status) => {
      stepMocks.step.mockResolvedValueOnce({
        result: participantBlocked,
        identityInput: identityLink,
      });
      const value = workflowContext({ status });
      const result = await continueHostedRuntimePreparation(
        participantInput,
        value.context,
        stepMocks.step,
      );
      expect(result).toMatchObject({
        status: "blocked",
        code: "auth_identity_required",
        identityResponse: status,
      });
      expect(stepMocks.step).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps waiting for real capture rather than treating a human answer as identity evidence", async () => {
    stepMocks.step
      .mockResolvedValueOnce({ result: participantBlocked, identityInput: identityLink })
      .mockResolvedValueOnce({ result: participantBlocked, identityInput: identityLink });
    const value = workflowContext({ status: "answered", text: "I signed in" });
    value.ask
      .mockResolvedValueOnce({ status: "answered", text: "I signed in" })
      .mockResolvedValueOnce({ status: "dismissed" });
    const result = await continueHostedRuntimePreparation(
      participantInput,
      value.context,
      stepMocks.step,
    );
    expect(result).toMatchObject({
      status: "blocked",
      code: "auth_identity_required",
      identityResponse: "dismissed",
    });
    expect(stepMocks.step).toHaveBeenCalledTimes(2);
    expect(value.ask).toHaveBeenCalledTimes(2);
  });
  it("asks the user to complete the prepared Auth identity link", () => {
    const question = realmIdentityInputQuestion({
      browserUrl: "https://auth.example/link",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(question.display).toBe("confirmation");
    expect(question.prompt).toContain("https://auth.example/link");
    expect(question.prompt).toContain("2027-01-01T00:00:00Z");
  });
});

it("reports execute-stage failure without changing the public blocked result or exposing the error", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const privateMessage = "private-token and provider URL";
  operator.request.mockRejectedValueOnce(new TypeError(privateMessage));
  try {
    const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain, {
      ...contract,
      onFailure: (stage, caught) => {
        reportRuntimePreparationFailure(ctx.session.id, stage, caught);
      },
    });
    expect(value.result).toMatchObject({ status: "blocked", code: "operator_unavailable" });
    expect(logs).toHaveBeenCalledWith(
      "[builder:hosted-neon-consent]",
      expect.objectContaining({
        boundary: "builder",
        preparationFailure: { stage: "operator_execute", errorClass: "type_error" },
      }),
    );
    expect(JSON.stringify(logs.mock.calls)).not.toContain(privateMessage);
  } finally {
    logs.mockRestore();
  }
});

it("reports actual approval evaluator entry and preserves its denied response", async () => {
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = new HostedOperatorErrorClass("resource_mismatch");
  try {
    const readPrior = async () => await Promise.reject(error);
    const value = await evaluateHostedRuntimePreparationApproval(
      {
        ...ctx,
        toolInput: input,
        session: {
          ...ctx.session,
          auth: { current: null, initiator: null },
          turn: { id: "test-turn", sequence: 1 },
        },
        approvedTools: new Set(),
        toolName: "prepare-app-hosted-runtime",
        getSandbox: async () => await Promise.reject(new Error("No Sandbox in diagnostic fixture")),
      },
      readPrior,
      {
        onStarted: () => {
          reportRuntimePreparationStarted(ctx.session.id, "approval_evaluation");
        },
        onFailure: (caught) => {
          reportRuntimePreparationFailure(ctx.session.id, "approval_evaluation", caught);
        },
      },
    );
    expect(value).toMatchObject({ type: "denied" });
    expect(logs).toHaveBeenCalledWith(
      "[builder:hosted-neon-consent]",
      expect.objectContaining({ preparationStage: "approval_evaluation", outcome: "started" }),
    );
    expect(logs).toHaveBeenCalledWith(
      "[builder:hosted-neon-consent]",
      expect.objectContaining({
        preparationFailure: {
          stage: "approval_evaluation",
          errorClass: "operator_error",
          code: "resource_mismatch",
        },
      }),
    );
  } finally {
    logs.mockRestore();
  }
});

describe("confirmed Gateway build failure recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it.each(["returned", "thrown"])(
    "requests normal replanning only after a %s confirmed failure",
    async (mode) => {
      if (mode === "returned") {
        operator.request.mockResolvedValueOnce({
          appId: input.appId,
          authenticatedBehavior: "unassessed",
          operationRef,
          status: "blocked",
          code: "gateway_delivery_failed",
        });
      } else {
        operator.request.mockRejectedValueOnce(
          new HostedOperatorErrorClass("gateway_delivery_failed"),
        );
      }
      const frozen = structuredClone(participantInput);
      const value = await prepareHostedRuntimeWithOperator(
        participantInput,
        ctx,
        operator,
        retain,
        contract,
      );
      expect(value.identityInput).toBeNull();
      expect(value.result).toMatchObject({
        status: "blocked",
        code: "gateway_delivery_failed",
        nextAction: {
          tool: "plan-app-hosted-runtime",
          approval: "normal-plan-approval",
          input: {
            appId: input.appId,
            branch: input.branch,
            projectId: input.projectId,
            environment: "preview",
            operation: "prepare",
            normalActorProgram: participantInput.plan.normalActorProgram,
          },
        },
      });
      expect(participantInput).toEqual(frozen);
      expect(operator.request).toHaveBeenCalledOnce();
      expect(operator.request).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "execute",
          operationRef: input.operationRef,
          planDigest: participantInput.planDigest,
        }),
        ctx.abortSignal,
      );
      expect(operator.authIdentityInput).not.toHaveBeenCalled();
    },
  );
  it.each(["reconciliation_required", "operator_unavailable", "operation_in_progress"] as const)(
    "preserves %s without suggesting successor planning",
    async (code) => {
      const blocked = {
        appId: input.appId,
        authenticatedBehavior: "unassessed" as const,
        operationRef,
        status: "blocked" as const,
        code,
      };
      operator.request.mockResolvedValueOnce(blocked);
      const value = await prepareHostedRuntimeWithOperator(input, ctx, operator, retain, contract);
      expect(value.result).toEqual(blocked);
      expect(value.result).not.toHaveProperty("nextAction");
      expect(operator.request).toHaveBeenCalledOnce();
    },
  );
});
