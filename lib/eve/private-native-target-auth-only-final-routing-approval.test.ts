/* oxlint-disable eslint/require-await -- Authenticated history and owner fixtures are deliberately async. */
import { expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";

import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import type { NativeTargetAuthOnlyApproval } from "../provisioning/native-target-auth-only-dispatch";
import {
  nativeTargetAuthOnlyFinalRoutingPlanDigest,
  nativeTargetAuthOnlyFinalRoutingPlanSchema,
} from "../provisioning/native-target-auth-only-final-routing";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import type { PrivateNativeTargetApprovalObservation } from "./private-native-target-approval";
import {
  nativeTargetAuthOnlyFinalRoutingApprovalAction,
  nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
  nativeTargetAuthOnlyFinalRoutingApprovalTool,
  nativeTargetAuthOnlyFinalRoutingPlanInputSchema,
  readPrivateNativeTargetAuthOnlyFinalRoutingApproval,
} from "./private-native-target-auth-only-final-routing-approval";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-fixture",
  ownerUserId: "owner-fixture",
};
const owner = {
  authority,
  publicSessionId: "saved-session",
  adapterSessionId: "saved-adapter",
  adapterGeneration: 1,
};
const historyOwner = operatorOwnerContextSchema.parse({
  kind: "direct",
  authority,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: owner.publicSessionId,
  adapterSessionId: owner.adapterSessionId,
  adapterGeneration: owner.adapterGeneration,
});
const operationRef = "11111111-1111-4111-a111-111111111111";
const routingOperationRef = "22222222-2222-4222-a222-222222222222";
const deliveryPlanDigest = "d".repeat(64);
const routingPlan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse({
  version: 1,
  kind: "native-target-auth-only-final-routing",
  operationRef: routingOperationRef,
  deliveryOperationRef: operationRef,
  deliveryPlanDigest,
  target: {
    appId: "signup-pilot",
    sessionId: owner.publicSessionId,
    projectId: "app-project",
    branch: "pilot",
    environment: "preview",
    installationId: "install-fixture",
    scopeType: "team",
    scopeId: "team-fixture",
  },
  gateway: {
    projectId: "gateway-project",
    repoId: "gateway-repo",
    branch: "gateway-pilot",
    gitRef: "gateway-pilot",
    gitSha: "a".repeat(40),
    publicOrigin: "https://pilot.example",
  },
  source: {
    projectId: "gateway-project",
    ownerId: "team-fixture",
    environment: "preview",
    issuer: "https://oidc.vercel.com/team-fixture",
    audience: "https://vercel.com/team-fixture",
    publicOrigin: "https://pilot.example",
    subject: "owner:team-fixture:project:gateway:environment:preview",
  },
  bootstrap: {
    readyState: "READY",
    deploymentId: "dpl-bootstrap",
    origin: "https://bootstrap.vercel.app",
    operationRef,
    projectId: "gateway-project",
    branch: "gateway-pilot",
    repoId: "gateway-repo",
  },
  app: {
    readyState: "READY",
    deploymentId: "dpl-app",
    origin: "https://app.vercel.app",
    operationRef,
    projectId: "app-project",
    branch: "pilot",
    repoId: "app-repo",
  },
  projection: {
    operationRef,
    deliveryPlanDigest,
    gatewayProjectId: "gateway-project",
    physicalBranch: "gateway-pilot",
    rowId: "row-fixture",
    appDeploymentId: "dpl-app",
    priorSha256: "b".repeat(64),
    nextSha256: "c".repeat(64),
  },
});
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const routingPlanDigest = nativeTargetAuthOnlyFinalRoutingPlanDigest(bytes(routingPlan));
const toolInput = {
  appId: routingPlan.target.appId,
  operationRef,
  deliveryPlanDigest,
  routingOperationRef,
  routingPlanDigest,
};
const requested = (
  changes: {
    input?: typeof toolInput;
    toolName?: string;
    requestId?: string;
    callId?: string;
  } = {},
): MessageStreamEvent => ({
  type: "input.requested",
  meta: { at: "2026-11-06T12:00:00.000Z", id: "request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "routing-turn",
    requests: [
      {
        kind: "tool-approval",
        requestId: changes.requestId ?? "routing-request",
        prompt: "Apply the approved app routing and refresh the isolated gateway",
        action: {
          kind: "tool-call",
          callId: changes.callId ?? "original-call",
          toolName: changes.toolName ?? nativeTargetAuthOnlyFinalRoutingApprovalTool,
          input: changes.input ?? structuredClone(toolInput),
        },
      },
    ],
  },
});
const settled = (
  changes: {
    requestId?: string;
    principal?: string;
    outcome?: "approved" | "cancelled";
    at?: string;
  } = {},
): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at: changes.at ?? "2026-11-06T12:00:01.000Z", id: "settled-event" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "routing-turn",
    requestId: changes.requestId ?? "routing-request",
    responderPrincipalId: changes.principal ?? authority.ownerUserId,
    outcome: changes.outcome ?? "approved",
  },
});
const proof: NativeTargetAuthOnlyApproval = {
  requestId: "routing-request",
  callId: "original-call",
  planDigest: routingPlanDigest,
  sourceDigest: routingPlanDigest,
  publicSessionId: owner.publicSessionId,
  responderPrincipalId: authority.ownerUserId,
  outcome: "approved",
  observedAt: "2026-11-06T12:00:01.000Z",
};
const fixture = (events: MessageStreamEvent[] = [requested(), settled()], complete = true) => ({
  owner: structuredClone(owner),
  historyOwner: structuredClone(historyOwner),
  approvalInput: structuredClone(toolInput),
  routingPlanBytes: bytes(routingPlan),
  assertOwner: vi.fn(async () => undefined),
  readHistory: vi.fn(async (start: number, observe: (event: MessageStreamEvent) => void) => {
    for (const event of events) observe(event);
    return {
      complete,
      nextNativeIndex: start + events.length,
      nativeTailIndex: Math.max(0, start + events.length - 1),
    };
  }),
});

it("accepts digest-only routing intent and rejects caller-supplied plan fields", () => {
  expect(nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.parse(toolInput)).toEqual(toolInput);
  expect(
    nativeTargetAuthOnlyFinalRoutingPlanInputSchema.parse({
      appId: toolInput.appId,
      operationRef,
      deliveryPlanDigest,
    }),
  ).toEqual({ appId: toolInput.appId, operationRef, deliveryPlanDigest });
  expect(
    nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.safeParse({
      ...toolInput,
      routingPlan,
    }).success,
  ).toBe(false);
  expect(nativeTargetAuthOnlyFinalRoutingPlanInputSchema.safeParse(toolInput).success).toBe(false);
});

it("reads the exact separate routing approval without confusing the provider team with the user", async () => {
  const f = fixture();
  expect(routingPlan.target.scopeId).not.toBe(owner.authority.ownerUserId);
  await expect(readPrivateNativeTargetAuthOnlyFinalRoutingApproval(f)).resolves.toEqual(proof);
  expect(f.assertOwner).toHaveBeenCalledTimes(2);
});

it.each([
  "delivery-tool",
  "entry-tool",
  "app",
  "parent-operation",
  "delivery-digest",
  "routing-operation",
  "routing-digest",
  "unmatched-settlement",
  "extra-input",
] as const)("does not treat %s as approval for this routing effect", async (kind) => {
  const changed = structuredClone(toolInput);
  if (kind === "app") changed.appId = "another-app";
  if (kind === "parent-operation") changed.operationRef = "33333333-3333-4333-a333-333333333333";
  if (kind === "delivery-digest") changed.deliveryPlanDigest = "e".repeat(64);
  if (kind === "routing-operation")
    changed.routingOperationRef = "33333333-3333-4333-a333-333333333333";
  if (kind === "routing-digest") changed.routingPlanDigest = "e".repeat(64);
  if (kind === "extra-input") Object.assign(changed, { bypassApproval: true });
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval(
      fixture([
        requested({
          input: changed,
          ...(kind === "delivery-tool"
            ? { toolName: "prepare-app-native-target-auth-only-delivery" }
            : {}),
          ...(kind === "entry-tool"
            ? { toolName: "prepare-app-native-target-auth-only-entry" }
            : {}),
        }),
        settled({ ...(kind === "unmatched-settlement" ? { requestId: "another-request" } : {}) }),
      ]),
    ),
  ).resolves.toBeNull();
});

it.each([
  "bytes",
  "owner",
  "session",
  "adapter-session",
  "adapter-generation",
  "app",
  "plan-session",
  "parent-operation",
  "routing-operation",
  "delivery-digest",
  "provider-scope",
  "gateway-source",
  "gateway-origin",
  "bootstrap",
  "app-receipt",
  "projection-operation",
  "projection-digest",
  "projection-app",
  "projection-gateway",
  "same-operation",
] as const)("rejects mismatched retained %s before reading history", async (kind) => {
  const f = fixture();
  const changed = structuredClone(routingPlan);
  if (kind === "owner") f.owner.authority.ownerUserId = "foreign";
  if (kind === "session") f.owner.publicSessionId = "foreign";
  if (kind === "adapter-session") f.owner.adapterSessionId = "foreign";
  if (kind === "adapter-generation") f.owner.adapterGeneration = 2;
  if (kind === "app") changed.target.appId = "another-app";
  if (kind === "plan-session") changed.target.sessionId = "another-session";
  if (kind === "parent-operation")
    changed.deliveryOperationRef = "33333333-3333-4333-a333-333333333333";
  if (kind === "routing-operation") changed.operationRef = "33333333-3333-4333-a333-333333333333";
  if (kind === "delivery-digest") changed.deliveryPlanDigest = "e".repeat(64);
  if (kind === "provider-scope") changed.source.ownerId = "foreign-team";
  if (kind === "gateway-source") changed.source.projectId = "foreign-gateway";
  if (kind === "gateway-origin") changed.source.publicOrigin = "https://foreign.example";
  if (kind === "bootstrap") changed.bootstrap.projectId = "foreign-gateway";
  if (kind === "app-receipt") changed.app.projectId = "another-project";
  if (kind === "projection-operation") changed.projection.operationRef = routingOperationRef;
  if (kind === "projection-digest") changed.projection.deliveryPlanDigest = "e".repeat(64);
  if (kind === "projection-app") changed.projection.appDeploymentId = "dpl-another";
  if (kind === "projection-gateway") changed.projection.gatewayProjectId = "another-gateway";
  if (kind === "same-operation") {
    changed.operationRef = operationRef;
    f.approvalInput.routingOperationRef = operationRef;
  }
  f.routingPlanBytes = bytes(changed);
  f.approvalInput.routingPlanDigest = nativeTargetAuthOnlyFinalRoutingPlanDigest(
    f.routingPlanBytes,
  );
  if (kind === "bytes") f.routingPlanBytes = Buffer.concat([f.routingPlanBytes, Buffer.from(" ")]);
  await expect(readPrivateNativeTargetAuthOnlyFinalRoutingApproval(f)).rejects.toThrow();
  expect(f.readHistory).not.toHaveBeenCalled();
});

it("rejects a foreign responder and ambiguous approved requests", async () => {
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval(
      fixture([requested(), settled({ principal: "foreign" })]),
    ),
  ).rejects.toThrow();
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval(
      fixture([
        requested(),
        settled(),
        requested({ requestId: "second", callId: "second-call" }),
        settled({ requestId: "second" }),
      ]),
    ),
  ).rejects.toThrow();
});

it("preserves cancellation after a later settlement and a newly approved retry", async () => {
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval(
      fixture([
        requested(),
        settled({ outcome: "cancelled" }),
        settled({ at: "2026-11-06T12:00:02.000Z" }),
        requested({ requestId: "retry", callId: "retry-call" }),
        settled({ requestId: "retry" }),
      ]),
    ),
  ).resolves.toEqual({ ...proof, outcome: "cancelled" });
});

it("reuses the retained original approval even when a retry has a different call", async () => {
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
      ...fixture([
        requested(),
        settled(),
        requested({ requestId: "retry", callId: "retry-call" }),
        settled({ requestId: "retry" }),
      ]),
      retainedApproval: proof,
    }),
  ).resolves.toEqual(proof);
});

it("observes later cancellation of the retained original approval", async () => {
  const observedAt = "2026-11-06T12:00:02.000Z";
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
      ...fixture([requested(), settled(), settled({ outcome: "cancelled", at: observedAt })]),
      retainedApproval: proof,
    }),
  ).resolves.toEqual({ ...proof, outcome: "cancelled", observedAt });
});

it.each(["missing", "request", "time", "digest", "source", "session", "responder"] as const)(
  "does not replace or transplant a retained approval with mismatched %s",
  async (kind) => {
    const retained = { ...proof };
    if (kind === "request") retained.requestId = "another-request";
    if (kind === "time") retained.observedAt = "2026-11-06T12:00:02.000Z";
    if (kind === "digest") retained.planDigest = "e".repeat(64);
    if (kind === "source") retained.sourceDigest = deliveryPlanDigest;
    if (kind === "session") retained.publicSessionId = "another-session";
    if (kind === "responder") retained.responderPrincipalId = "another-owner";
    await expect(
      readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
        ...fixture(kind === "missing" ? [] : undefined),
        retainedApproval: retained,
      }),
    ).rejects.toThrow();
  },
);

it.each(["approved", "cancelled"] as const)(
  "resumes a partial %s tail without changing its request, call, or timestamp",
  async (outcome) => {
    let saved: PrivateNativeTargetApprovalObservation | undefined;
    const save = async (next: PrivateNativeTargetApprovalObservation) => {
      saved = structuredClone(next);
    };
    await expect(
      readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
        ...fixture([requested(), settled({ outcome })], false),
        observation: { save },
      }),
    ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
    expect(saved?.native.capture.request).toEqual({
      action: nativeTargetAuthOnlyFinalRoutingApprovalAction,
      planRef: routingOperationRef,
      planDigest: routingPlanDigest,
      idempotencyKey: toolInput.appId,
    });
    const resumed = fixture([]);
    await expect(
      readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
        ...resumed,
        observation: { state: saved, save },
      }),
    ).resolves.toEqual({ ...proof, outcome });
    expect(resumed.readHistory).toHaveBeenCalledWith(2, expect.any(Function));
  },
);

it("does not carry an incomplete positive grant into a recovered adapter", async () => {
  let saved: PrivateNativeTargetApprovalObservation | undefined;
  const save = async (next: PrivateNativeTargetApprovalObservation) => {
    saved = structuredClone(next);
  };
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
      ...fixture(undefined, false),
      observation: { save },
    }),
  ).rejects.toBeInstanceOf(HostedSessionReadTimeoutError);
  const resumed = fixture([]);
  resumed.owner.adapterSessionId = resumed.historyOwner.adapterSessionId = "recovered-adapter";
  resumed.owner.adapterGeneration = resumed.historyOwner.adapterGeneration = 2;
  await expect(
    readPrivateNativeTargetAuthOnlyFinalRoutingApproval({
      ...resumed,
      observation: { state: saved, save },
    }),
  ).resolves.toBeNull();
  expect(resumed.readHistory).toHaveBeenCalledWith(0, expect.any(Function));
});

it("withholds approval after owner loss and snapshots mutable caller inputs before awaiting", async () => {
  const lost = fixture();
  lost.assertOwner
    .mockImplementationOnce(async () => undefined)
    .mockRejectedValueOnce(new Error("revoked"));
  await expect(readPrivateNativeTargetAuthOnlyFinalRoutingApproval(lost)).rejects.toThrow(
    "revoked",
  );
  const frozen = fixture();
  frozen.assertOwner.mockImplementationOnce(async () => {
    frozen.routingPlanBytes.fill(32);
    frozen.approvalInput.routingPlanDigest = "f".repeat(64);
    frozen.owner.authority.ownerUserId = "foreign";
  });
  await expect(readPrivateNativeTargetAuthOnlyFinalRoutingApproval(frozen)).resolves.toEqual(proof);
});
