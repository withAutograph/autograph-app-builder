/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/no-unsafe-argument -- Installed SDK private runtime modules exercise real collection/reconciliation; only external World/storage/dispatch ports are controlled. */
/* oxlint-disable eslint/require-await -- Synthetic external ports preserve asynchronous production contracts. */
import { expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createSameOriginEveTransport } from "./same-origin-http";
import { HostedSessionBusyError, createHostedEveSessionService } from "./hosted-service";
import type { HostedEveTransport, HostedEngineSnapshot } from "./hosted-service";
import {
  createNativeDraftReviewedLineageRecovery,
  createNativeRecoveryBinding,
} from "./native-recovery-binding";
import { hostedEveOperationScopes } from "./hosted-auth";
import {
  InMemoryHostedEveStore,
  durableHostedSessionRecordSchema,
  hostedOperationRecordSchema,
  hostedSessionCheckpointDigest,
  hostedSessionCheckpointProgressDigest,
} from "./hosted-store";
import type { HostedEveStore } from "./hosted-store";
import { eveStartInputSchema, eveSendInputSchema, eveSessionResultSchema } from "../mcp/contracts";
import { resolveDraftReviewedWorkflow } from "../agent/draft-reviewed-lineage";
import { currentDraftCandidateSource } from "../agent/published-draft-repair";
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
    afterCutoffReview?: boolean;
    beforeCutoffReview?: boolean;
    fresh?: boolean;
    malformedBeforeCutoff?: "null" | "unknown-phase";
    missingCutoff?: boolean;
    omitPriorReview?: boolean;
    paginateAncestor?: boolean;
    pendingApproval?: boolean;
    priorFault?: string;
    priorOwnerReview?: boolean;
    status?: HostedEngineSnapshot["status"];
  } = {},
) => {
  const native = await nativeFixture({
    live: true,
    fresh: options.fresh,
    priorOwnerReview: options.priorOwnerReview,
    afterCutoffReview: options.afterCutoffReview,
    beforeCutoffReview: options.beforeCutoffReview,
    malformedBeforeCutoff: options.malformedBeforeCutoff,
    omitPriorReview: options.omitPriorReview,
    paginateAncestor: options.paginateAncestor,
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
  const authorityCheckpoint = { ...checkpoint, status: "waiting" as const };
  let cutoffSlot = 2;
  if (options.beforeCutoffReview === true || options.malformedBeforeCutoff !== undefined) {
    cutoffSlot = 3;
  }
  if (options.missingCutoff === true) {
    cutoffSlot = 9;
  }
  const source = durableHostedSessionRecordSchema.parse({
    version: 2,
    sessionId: "public-original",
    adapterSessionId: owner,
    adapterGeneration: 2,
    originAdapterSessionId: "physical-ancestor",
    parentSessionId: "public-authority",
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
      sourcePublicSessionId: "public-authority",
      sourceOwnerRunId: "physical-ancestor",
      sourceAdapterGeneration: 1,
      logicalSessionId: logical,
      originalAuthoritySessionId: "public-authority",
      parentCancellationRevision: 0,
      executionTransfer: {
        kind: "idle-checkpoint",
        sourceCheckpointDigest: hostedSessionCheckpointDigest(authorityCheckpoint),
      },
      ownerRunId: owner,
      provenance: {
        checkpointVersion: 1,
        kind: "committed-turn-output",
        resumePhase: "await-input",
        sourceEventId: `evnt_${String(cutoffSlot).padStart(26, "0")}`,
        sourceSlot: cutoffSlot,
        sourceStepId: "step-prior-cutoff",
      },
    },
  });
  const seed = hostedOperationRecordSchema.parse({
    clientRequestId: "original-start",
    createdAtEpochMs: 1000,
    kind: "start",
    operationId: "original-start",
    principal,
    requestDigest: `sha256:${"a".repeat(64)}`,
    state: "reserved",
    updatedAtEpochMs: 1000,
    version: 1,
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
    status: "waiting",
    resumability: "live",
    checkpoint: authorityCheckpoint,
    checkpointDigest: hostedSessionCheckpointDigest(authorityCheckpoint),
    checkpointProgressDigest: hostedSessionCheckpointProgressDigest(authorityCheckpoint),
  });
  await store.reserveOperation(principal, authoritySeed);
  await store.settleSucceeded({
    principal,
    operationId: authoritySeed.operationId,
    requestDigest: authoritySeed.requestDigest,
    nowEpochMs: 1000,
    session: authority,
    result: { sessionId: authority.sessionId, status: "waiting", cursor: 0, events: [] },
  });
  const previousBinding = source.nativeRecoveryBinding;
  if (previousBinding === undefined) {
    throw new Error("Missing previous recovery binding");
  }
  const {
    ownerRunId: _previousOwner,
    provenance: _previousProvenance,
    ...previousDescriptor
  } = previousBinding;
  void _previousOwner;
  void _previousProvenance;
  const previousOperation = hostedOperationRecordSchema.parse({
    ...seed,
    operationId: previousDescriptor.operationId,
    clientRequestId: "previous-recovery",
    resumeSessionId: authority.sessionId,
    nativeRecovery: previousDescriptor,
  });
  await store.reserveOperation(principal, previousOperation);
  await store.commitNativeRecoveryReceipt({
    principal,
    descriptor: previousDescriptor,
    recoveryBinding: previousBinding,
    nowEpochMs: 1000,
  });
  await store.settleSucceeded({
    principal,
    operationId: previousOperation.operationId,
    requestDigest: previousOperation.requestDigest,
    nowEpochMs: 1000,
    session: source,
    result: { sessionId: source.sessionId, status, cursor: 0, events: [] },
  });
  const recoveryStore: Pick<
    HostedEveStore,
    "getSession" | "getPrivateOperation" | "commitNativeRecoveryReceipt"
  > = {
    getSession: async (caller, sessionId) => {
      const record = await store.getSession(caller, sessionId);
      if (
        record !== null &&
        record.version === 2 &&
        sessionId === "public-authority" &&
        options.priorFault === "parent-cancelled"
      ) {
        return { ...record, cancellationRevision: 1 };
      }
      return record;
    },
    getPrivateOperation: async (caller, operationId) => {
      const record = await store.getPrivateOperation(caller, operationId);
      if (record === null || operationId !== "original-recovery") {
        return record;
      }
      if (options.priorFault === "missing-operation") {
        return null;
      }
      if (options.priorFault === "unsucceeded-operation") {
        return { ...record, state: "reserved" };
      }
      if (options.priorFault === "foreign-principal") {
        return { ...record, principal: { ...record.principal, ownerUserId: "foreign" } };
      }
      if (options.priorFault === "missing-receipt") {
        return { ...record, nativeRecoveryReceipt: undefined };
      }
      if (record.nativeRecoveryReceipt !== undefined) {
        if (options.priorFault === "changed-receipt") {
          return {
            ...record,
            nativeRecoveryReceipt: { ...record.nativeRecoveryReceipt, ownerRunId: "foreign" },
          };
        }
        if (options.priorFault === "changed-cutoff") {
          return {
            ...record,
            nativeRecoveryReceipt: {
              ...record.nativeRecoveryReceipt,
              provenance: { ...record.nativeRecoveryReceipt.provenance, sourceEventId: "foreign" },
            },
          };
        }
        if (options.priorFault === "logical-mismatch") {
          return {
            ...record,
            nativeRecoveryReceipt: { ...record.nativeRecoveryReceipt, logicalSessionId: "foreign" },
          };
        }
        if (options.priorFault === "authority-mismatch") {
          return {
            ...record,
            nativeRecoveryReceipt: {
              ...record.nativeRecoveryReceipt,
              originalAuthoritySessionId: "foreign",
            },
          };
        }
      }
      return record;
    },
    commitNativeRecoveryReceipt: store.commitNativeRecoveryReceipt.bind(store),
  };
  const canonical = createNativeRecoveryBinding({
    store: recoveryStore,
    assertOwner,
    now: () => 2000,
  });
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
  const ports = {
    ...native.ports,
    ...canonical,
    applicationStateRecovery: createNativeDraftReviewedLineageRecovery(
      canonical.authorize.bind(canonical),
    ),
  };
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
      expect(currentDraftCandidateSource(workflow, candidate)?.repository.repositoryId).toBe(
        native.candidate.repositoryId,
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
    resumeMode: "recover-idle",
    resumeSessionId: source.sessionId,
  });
  return {
    adapter,
    authorizationFailures,
    authorizedReads: () => authorizedReads,
    idle: () => {
      currentSnapshot = { events: [], status: "waiting" };
    },
    native,
    ports,
    request,
    revoke: () => {
      allowed = false;
    },
    sends,
    service,
    source,
    store,
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
    nativeRecoveryBinding: {
      executionTransfer: { kind: "idle-checkpoint" },
      logicalSessionId: logical,
      originalAuthoritySessionId: "public-authority",
      sourcePublicSessionId: f.source.sessionId,
    },
    parentSessionId: f.source.sessionId,
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
    clientRequestId: "continue-recovered-original-draft",
    message: "Continue the same draft",
    sessionId: child.sessionId,
  });
  await publicCall(f.service, "autograph_send", continuation);
  await publicCall(f.service, "autograph_send", continuation);
  expect(f.sends).toHaveLength(1);
  await expect(
    f.service.start({ ...f.request, clientRequestId: "competing-idle-recovery" }),
  ).rejects.toBeInstanceOf(HostedSessionBusyError);
  expect(await f.store.getSession(principal, child.sessionId)).toMatchObject({
    nativeRecoveryBinding: { logicalSessionId: logical, ownerRunId: "physical-child" },
    parentSessionId: f.source.sessionId,
  });
  expect(f.native.starts).toHaveLength(1);
});

it("the public recovery restores a fresh-template owned publication and selects its latest private candidate", async () => {
  const f = await fixture({ fresh: true });
  const child = await publicCall(f.service, "autograph_start", f.request);
  const restored = restoredSchema.parse(f.native.starts[0]).checkpoint.serializedContext;
  expect(restored).toEqual({
    ...f.native.currentContext,
    [draftReviewedLineageContextKey]: { ...f.native.candidate, reviewedLineage: f.native.reviewed },
  });
  expect(f.native.currentContext[workflowKey].sourceReceipt.sourceKind).toBe("fresh-template");
  expect(f.native.currentContext[workflowKey].githubSource).toBeUndefined();
  expect(f.native.candidate.unpublished).toBe("actual unchanged edits");
  const retried = await publicCall(f.service, "autograph_start", f.request);
  expect(retried.sessionId).toBe(child.sessionId);
  expect(f.native.starts).toHaveLength(1);
  f.idle();
  await f.service.get({ sessionId: child.sessionId, cursor: 0, limit: 100 });
  const continuation = eveSendInputSchema.parse({
    clientRequestId: "continue-fresh-owned-draft",
    message: "Continue the same draft",
    sessionId: child.sessionId,
  });
  await publicCall(f.service, "autograph_send", continuation);
  await publicCall(f.service, "autograph_send", continuation);
  expect(f.sends).toHaveLength(1);
});

it("restores the owned fresh review across a previously committed idle recovery", async () => {
  const f = await fixture({ fresh: true, priorOwnerReview: true, paginateAncestor: true });
  const prior = await f.store.getPrivateOperation(principal, "original-recovery");
  expect(prior).toMatchObject({
    nativeRecoveryReceipt: {
      executionTransfer: { kind: "idle-checkpoint" },
      ownerRunId: owner,
      provenance: { sourceSlot: 2, sourceStepId: "step-prior-cutoff" },
    },
    state: "succeeded",
  });
  const predecessor = await f.native.world.events.list({ runId: "physical-ancestor" });
  expect(predecessor.data).toHaveLength(1);
  expect(predecessor.hasMore).toBe(true);
  const child = await publicCall(f.service, "autograph_start", f.request);
  const restored = restoredSchema.parse(f.native.starts[0]).checkpoint.serializedContext;
  expect(restored[draftReviewedLineageContextKey]).toEqual({
    ...f.native.candidate,
    reviewedLineage: f.native.reviewed,
  });
  expect(restored[workflowKey]).toEqual(f.native.currentContext[workflowKey]);
  expect(await f.store.getSession(principal, child.sessionId)).toMatchObject({
    parentSessionId: f.source.sessionId,
  });
  expect(f.native.starts).toHaveLength(1);
  expect(await publicCall(f.service, "autograph_start", f.request)).toEqual(child);
  expect(f.native.starts).toHaveLength(1);
  f.idle();
  await f.service.get({ sessionId: child.sessionId, cursor: 0, limit: 100 });
  const continuation = eveSendInputSchema.parse({
    clientRequestId: "continue-prior-owned-draft",
    message: "Continue the same draft",
    sessionId: child.sessionId,
  });
  await publicCall(f.service, "autograph_send", continuation);
  await publicCall(f.service, "autograph_send", continuation);
  expect(f.sends).toHaveLength(1);
});

it("ignores a conflicting predecessor review after the committed native cutoff", async () => {
  const f = await fixture({ fresh: true, priorOwnerReview: true, afterCutoffReview: true });
  const predecessor = await f.native.world.events.list({ runId: "physical-ancestor" });
  expect(predecessor.data).toHaveLength(3);
  await publicCall(f.service, "autograph_start", f.request);
  const restored = restoredSchema.parse(f.native.starts[0]).checkpoint.serializedContext;
  expect(restored[draftReviewedLineageContextKey]).toEqual({
    ...f.native.candidate,
    reviewedLineage: f.native.reviewed,
  });
});

it.each(["missing-review", "superseding-review", "malformed-review", "unknown-phase"] as const)(
  "does not manufacture predecessor lineage with %s",
  async (kind) => {
    let malformedBeforeCutoff: "null" | "unknown-phase" | undefined;
    if (kind === "malformed-review") {
      malformedBeforeCutoff = "null";
    }
    if (kind === "unknown-phase") {
      malformedBeforeCutoff = "unknown-phase";
    }
    const f = await fixture({
      fresh: true,
      priorOwnerReview: true,
      omitPriorReview: kind === "missing-review",
      beforeCutoffReview: kind === "superseding-review",
      malformedBeforeCutoff,
    });
    let visited = false;
    const visit = f.ports.visitRecoveryPredecessors.bind(f.ports);
    f.ports.visitRecoveryPredecessors = async (call, visitWindow) => {
      visited = true;
      await visit(call, visitWindow);
    };
    await publicCall(f.service, "autograph_start", f.request);
    const restored = restoredSchema.parse(f.native.starts[0]).checkpoint.serializedContext;
    expect(visited).toBe(true);
    expect(restored[draftReviewedLineageContextKey]).toEqual(f.native.candidate);
    expect(
      currentDraftCandidateSource(f.native.currentContext[workflowKey], f.native.candidate),
    ).toBeUndefined();
  },
);

it.each([
  "missing-operation",
  "unsucceeded-operation",
  "foreign-principal",
  "missing-receipt",
  "changed-receipt",
  "changed-cutoff",
  "logical-mismatch",
  "authority-mismatch",
  "parent-cancelled",
] as const)("refuses ancestor history with %s without a new native owner", async (priorFault) => {
  const f = await fixture({ fresh: true, priorOwnerReview: true, priorFault });
  let visited = false;
  const visit = f.ports.visitRecoveryPredecessors.bind(f.ports);
  f.ports.visitRecoveryPredecessors = async (call, visitWindow) => {
    visited = true;
    await visit(call, visitWindow);
  };
  await expect(f.service.start(f.request)).rejects.toThrow();
  expect(visited).toBe(true);
  expect(f.native.starts).toHaveLength(0);
});

it("refuses a committed predecessor cutoff that cannot be verified in native history", async () => {
  const f = await fixture({ fresh: true, priorOwnerReview: true, missingCutoff: true });
  await expect(f.service.start(f.request)).rejects.toThrow();
  expect(f.native.starts).toHaveLength(0);
});

it("refuses when owner membership is revoked during a predecessor page read", async () => {
  const f = await fixture({ fresh: true, priorOwnerReview: true, paginateAncestor: true });
  const list = f.native.world.events.list.bind(f.native.world.events);
  let ancestorPages = 0;
  f.native.world.events.list = async (request) => {
    const page = await list(request);
    if (request.runId === "physical-ancestor") {
      ancestorPages += 1;
      if (ancestorPages === 2) {
        f.revoke();
      }
    }
    return page;
  };
  await expect(f.service.start(f.request)).rejects.toThrow();
  expect(ancestorPages).toBeGreaterThanOrEqual(2);
  expect(f.native.starts).toHaveLength(0);
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
    const recover = f.ports.applicationStateRecovery.recover.bind(f.ports.applicationStateRecovery);
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
