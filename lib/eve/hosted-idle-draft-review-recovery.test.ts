/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Installed SDK private runtime modules exercise real collection/reconciliation; only external World/storage/dispatch ports are controlled. */
/* oxlint-disable eslint/require-await -- Synthetic external ports preserve asynchronous production contracts. */
import { expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createSameOriginEveTransport } from "./same-origin-http";
import { HostedSessionBusyError, createHostedEveSessionService } from "./hosted-service";
import type { HostedEveTransport, HostedEngineSnapshot } from "./hosted-service";
import { createNativeRecoveryBinding } from "./native-recovery-binding";
import { hostedEveOperationScopes } from "./hosted-auth";
import {
  InMemoryHostedEveStore,
  durableHostedSessionRecordSchema,
  hostedOperationRecordSchema,
  hostedSessionCheckpointDigest,
  hostedSessionCheckpointProgressDigest,
} from "./hosted-store";
import { eveStartInputSchema, eveSendInputSchema, eveSessionResultSchema } from "../mcp/contracts";
import { resolveDraftReviewedWorkflow } from "../agent/draft-reviewed-lineage";
import { draftReviewedLineageContextKey } from "./native-recovery-draft-reviewed-lineage";
import {
  load,
  logical,
  nativeFixture,
  owner,
  workflowKey,
} from "./test-support/draft-reviewed-recovery";

import { createAutographMcpHandler } from "../mcp/request-handler";

const runtime = await load("execution/session/terminal-recovery.js");
const principal = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "original-owner",
  workspaceId: "original-workspace",
  scopes: Object.values(hostedEveOperationScopes),
};
const auth = {
  authenticator: "mcp-oauth-jwks",
  issuer: principal.issuer,
  principalType: "user",
  principalId: principal.ownerUserId,
  subject: principal.ownerUserId,
  attributes: {
    "mcp:audience": principal.audience,
    "mcp:scopes": principal.scopes,
    "mcp:workspace-id": principal.workspaceId,
  },
};
const restoredSchema = z.object({
  checkpoint: z.object({ serializedContext: z.record(z.string(), z.unknown()) }),
});
const fixture = async (
  options: {
    activeTurn?: boolean;
    pendingApproval?: boolean;
    status?: HostedEngineSnapshot["status"];
  } = {},
) => {
  const native = await nativeFixture({
    live: true,
    activeTurn: options.activeTurn,
    pendingApproval: options.pendingApproval,
  });
  const store = new InMemoryHostedEveStore();
  let allowed = true;
  const assertOwner = async () => {
    if (!allowed) {
      throw new Error("owner membership revoked");
    }
  };
  const status = options.status ?? "waiting";
  const snapshot: HostedEngineSnapshot = { events: [], status };
  const checkpoint = { capturedAtEpochMs: 1000, events: [], status, version: 1 as const };
  const source = durableHostedSessionRecordSchema.parse({
    version: 2,
    sessionId: "public-original",
    adapterSessionId: owner,
    adapterGeneration: 2,
    originAdapterSessionId: "physical-ancestor",
    parentSessionId: "public-ancestor",
    principal,
    status,
    stage: "planning",
    resumability: "live",
    title: "Original app",
    createdAtEpochMs: 1000,
    updatedAtEpochMs: 1000,
    lastProgressAtEpochMs: 1000,
    checkpoint,
    checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
    checkpointProgressDigest: hostedSessionCheckpointProgressDigest(checkpoint),
    nativeRecoveryBinding: {
      version: 1,
      operationId: "original-recovery",
      sourcePublicSessionId: "public-ancestor",
      sourceOwnerRunId: "physical-ancestor",
      sourceAdapterGeneration: 1,
      logicalSessionId: logical,
      originalAuthoritySessionId: "public-authority",
      parentCancellationRevision: 0,
      ownerRunId: owner,
      provenance: {
        kind: "committed-turn-output",
        sourceStepId: "original-step",
        sourceEventId: "original-event",
        sourceSlot: 1,
        checkpointVersion: 1,
      },
    },
  });
  const seed = hostedOperationRecordSchema.parse({
    version: 1,
    kind: "start",
    operationId: "original-start",
    clientRequestId: "original-start",
    principal,
    state: "reserved",
    requestDigest: `sha256:${"a".repeat(64)}`,
    createdAtEpochMs: 1000,
    updatedAtEpochMs: 1000,
  });
  await store.reserveOperation(principal, seed);
  await store.settleSucceeded({
    principal,
    operationId: seed.operationId,
    requestDigest: seed.requestDigest,
    nowEpochMs: 1000,
    session: source,
    result: { sessionId: source.sessionId, status, cursor: 0, events: [] },
  });
  const authoritySeed = hostedOperationRecordSchema.parse({
    ...seed,
    operationId: "authority-start",
    clientRequestId: "authority-start",
  });
  const authoritySource = { ...source };
  Reflect.deleteProperty(authoritySource, "nativeRecoveryBinding");
  Reflect.deleteProperty(authoritySource, "parentSessionId");
  const authority = durableHostedSessionRecordSchema.parse({
    ...authoritySource,
    sessionId: "public-authority",
    adapterSessionId: logical,
    adapterGeneration: 1,
    originAdapterSessionId: logical,
  });
  await store.reserveOperation(principal, authoritySeed);
  await store.settleSucceeded({
    principal,
    operationId: authoritySeed.operationId,
    requestDigest: authoritySeed.requestDigest,
    nowEpochMs: 1000,
    session: authority,
    result: { sessionId: authority.sessionId, status, cursor: 0, events: [] },
  });
  const canonical = createNativeRecoveryBinding({ store, assertOwner, now: () => 2000 });
  const authorizationFailures: string[] = [];
  let authorizedReads = 0;
  const authorize = canonical.authorize.bind(canonical);
  canonical.authorize = async (call) => {
    try {
      await authorize(call);
      authorizedReads += 1;
    } catch (error) {
      authorizationFailures.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const ports = { ...native.ports, ...canonical };
  const nativeTransport = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example" },
    workloadIdentity: { token: async () => "controlled-workload-token" },
    fetchImplementation: async (_address, init) => {
      const payload = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(z.string().parse(init?.body)));
      return await runtime.handleTerminalRecoveryRequest(
        { payload, auth, forwarded: true, ports },
        async () => native.deps,
      );
    },
  });
  let currentSnapshot = snapshot;
  const sends: string[] = [];
  const adapter: HostedEveTransport = {
    start: nativeTransport.start,
    activateRecovery: nativeTransport.activateRecovery,
    get: async () => currentSnapshot,
    cancel: async () => {
      throw new Error("Unexpected native cancellation outside recovery protocol");
    },
    respond: async () => {
      throw new Error("Unexpected approval prompt during idle recovery");
    },
    send: async (request) => {
      const restored = restoredSchema.parse(native.starts[0]).checkpoint.serializedContext;
      const expectedCandidate = { ...native.candidate, reviewedLineage: native.reviewed };
      const candidate = z
        .custom<typeof expectedCandidate>((value) => isDeepStrictEqual(value, expectedCandidate))
        .parse(restored[draftReviewedLineageContextKey]);
      const workflow = z
        .custom<(typeof native.currentContext)[typeof workflowKey]>((value) =>
          isDeepStrictEqual(value, native.currentContext[workflowKey]),
        )
        .parse(restored[workflowKey]);
      expect(resolveDraftReviewedWorkflow(workflow, candidate)?.reviewReceipt.digest).toBe(
        native.reviewed.reviewReceipt.digest,
      );
      expect(candidate).toEqual({ ...native.candidate, reviewedLineage: native.reviewed });
      sends.push(request.operationId);
      await request.onAccepted?.("ordinary-continuation");
      currentSnapshot = {
        events: [
          {
            index: 0,
            type: "assistant.message",
            text: "Original draft is available",
            turnId: "restored-turn",
          },
        ],
        status: "waiting",
        nativeDeliveryState: {
          version: 1,
          turns: [
            {
              boundary: "turn.completed",
              boundaryDeliveryIds: ["ordinary-continuation"],
              deliveryIds: ["ordinary-continuation"],
              turnId: "restored-turn",
            },
          ],
        },
      };
      return currentSnapshot;
    },
  };
  const service = createHostedEveSessionService({
    store,
    transport: adapter,
    principal,
    assertNativeRecoveryOwner: assertOwner,
    assertSendDeliveryOwner: assertOwner,
    now: () => 2000,
  });
  const request = eveStartInputSchema.parse({
    clientRequestId: "recover-original-idle-checkpoint",
    resumeSessionId: source.sessionId,
    resumeMode: "recover-idle",
  });
  return {
    native,
    store,
    source,
    service,
    request,
    ports,
    adapter,
    sends,
    authorizationFailures,
    authorizedReads: () => authorizedReads,
    revoke: () => {
      allowed = false;
    },
    idle: () => {
      currentSnapshot = { events: [], status: "waiting" };
    },
  };
};

const publicCall = async (
  service: ReturnType<typeof createHostedEveSessionService>,
  name: string,
  args: z.infer<typeof eveStartInputSchema> | z.infer<typeof eveSendInputSchema>,
) => {
  const response = await createAutographMcpHandler(service)(
    new Request(principal.audience, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const data =
    body
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6) ?? body;
  return z
    .object({
      result: z.object({
        isError: z.literal(false).optional(),
        structuredContent: eveSessionResultSchema,
      }),
    })
    .parse(JSON.parse(data)).result.structuredContent;
};

it("the public idle recovery path restores verified original review and latest candidate, commits lineage and dispatches continuation once", async () => {
  const f = await fixture();
  const child = await publicCall(f.service, "autograph_start", f.request);
  expect(child.sessionId).not.toBe(f.source.sessionId);
  const saved = await f.store.getSession(principal, child.sessionId);
  expect(saved).toMatchObject({
    parentSessionId: f.source.sessionId,
    nativeRecoveryBinding: {
      sourcePublicSessionId: f.source.sessionId,
      originalAuthoritySessionId: "public-authority",
      logicalSessionId: logical,
      executionTransfer: { kind: "idle-checkpoint" },
    },
  });
  const restored = restoredSchema.parse(f.native.starts[0]).checkpoint.serializedContext;
  expect(restored).toEqual({
    ...f.native.currentContext,
    [draftReviewedLineageContextKey]: { ...f.native.candidate, reviewedLineage: f.native.reviewed },
  });
  expect(f.native.activations()).toBe(1);
  const retried = await publicCall(f.service, "autograph_start", f.request);
  expect(retried.sessionId).toBe(child.sessionId);
  expect(f.native.starts).toHaveLength(1);
  f.idle();
  await f.service.get({ sessionId: child.sessionId, cursor: 0, limit: 100 });
  const continuation = eveSendInputSchema.parse({
    sessionId: child.sessionId,
    clientRequestId: "continue-recovered-original-draft",
    message: "Continue the same draft",
  });
  await publicCall(f.service, "autograph_send", continuation);
  await publicCall(f.service, "autograph_send", continuation);
  expect(f.sends).toHaveLength(1);
  await expect(
    f.service.start({ ...f.request, clientRequestId: "competing-idle-recovery" }),
  ).rejects.toBeInstanceOf(HostedSessionBusyError);
  expect(await f.store.getSession(principal, child.sessionId)).toMatchObject({
    parentSessionId: f.source.sessionId,
    nativeRecoveryBinding: { ownerRunId: "physical-child", logicalSessionId: logical },
  });
  expect(f.native.starts).toHaveLength(1);
});

it.each(["working", "input_required", "cancelled"] as const)(
  "public recovery refuses %s source without invoking native recovery",
  async (status) => {
    const f = await fixture({ status });
    await expect(f.service.start(f.request)).rejects.toThrow();
    expect(f.native.starts).toHaveLength(0);
    expect(f.native.stopReceipts.size).toBe(0);
  },
);

it.each(["active-turn", "pending-approval", "effect-conflict"] as const)(
  "actual native admission refuses %s before transferring or dispatching",
  async (variant) => {
    const f = await fixture({
      activeTurn: variant === "active-turn",
      pendingApproval: variant === "pending-approval",
    });
    f.native.setEffectConflict(variant === "effect-conflict");
    await expect(f.service.start(f.request)).rejects.toThrow();
    expect(f.native.starts).toHaveLength(0);
    expect(f.native.stopReceipts.size).toBe(0);
    expect(f.authorizedReads()).toBeGreaterThan(0);
    expect(f.authorizationFailures).toEqual([]);
  },
);

it("canonical owner authorization refuses a foreign principal before native history or dispatch", async () => {
  const f = await fixture();
  const foreign = createHostedEveSessionService({
    store: f.store,
    transport: f.adapter,
    principal: { ...principal, ownerUserId: "foreign-owner" },
    assertNativeRecoveryOwner: async () => {
      throw new Error("Foreign owner must not reach private recovery");
    },
  });
  await expect(foreign.start(f.request)).rejects.toThrow();
  expect(f.native.starts).toHaveLength(0);
  expect(f.native.stopReceipts.size).toBe(0);
});

it.each(["revoked", "cancelled"] as const)(
  "fresh %s owner state fences native dispatch after reconstruction",
  async (variant) => {
    const f = await fixture();
    let recoveredLineage = false;
    const recover = f.ports.applicationStateRecovery.recover;
    f.ports.applicationStateRecovery.recover = async (input) => {
      const value = await recover(input);
      expect(value).toEqual(f.native.reviewed);
      recoveredLineage = true;
      if (variant === "revoked") {
        f.revoke();
      } else {
        await f.store.recordCancellationIntent({
          principal,
          sessionId: f.source.sessionId,
          nowEpochMs: 2000,
        });
      }
      return value;
    };
    await expect(f.service.start(f.request)).rejects.toThrow();
    expect(recoveredLineage).toBe(true);
    expect(f.native.starts).toHaveLength(0);
  },
);
