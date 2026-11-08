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
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "original-owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "original-workspace",
};
const auth = {
  attributes: {
    "mcp:audience": principal.audience,
    "mcp:scopes": principal.scopes,
    "mcp:workspace-id": principal.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: principal.issuer,
  principalId: principal.ownerUserId,
  principalType: "user",
  subject: principal.ownerUserId,
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
    activeTurn: options.activeTurn,
    afterCutoffReview: options.afterCutoffReview,
    beforeCutoffReview: options.beforeCutoffReview,
    fresh: options.fresh,
    live: true,
    malformedBeforeCutoff: options.malformedBeforeCutoff,
    omitPriorReview: options.omitPriorReview,
    paginateAncestor: options.paginateAncestor,
    pendingApproval: options.pendingApproval,
    priorOwnerReview: options.priorOwnerReview,
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
    adapterGeneration: 2,
    adapterSessionId: owner,
    checkpoint,
    checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
    checkpointProgressDigest: hostedSessionCheckpointProgressDigest(checkpoint),
    createdAtEpochMs: 1000,
    lastProgressAtEpochMs: 1000,
    nativeRecoveryBinding: {
      executionTransfer: {
        kind: "idle-checkpoint",
        sourceCheckpointDigest: hostedSessionCheckpointDigest(authorityCheckpoint),
      },
      logicalSessionId: logical,
      operationId: "original-recovery",
      originalAuthoritySessionId: "public-authority",
      ownerRunId: owner,
      parentCancellationRevision: 0,
      provenance: {
        checkpointVersion: 1,
        kind: "committed-turn-output",
        resumePhase: "await-input",
        sourceEventId: `evnt_${String(cutoffSlot).padStart(26, "0")}`,
        sourceSlot: cutoffSlot,
        sourceStepId: "step-prior-cutoff",
      },
      sourceAdapterGeneration: 1,
      sourceOwnerRunId: "physical-ancestor",
      sourcePublicSessionId: "public-authority",
      version: 1,
    },
    originAdapterSessionId: "physical-ancestor",
    parentSessionId: "public-authority",
    principal,
    resumability: "live",
    sessionId: "public-original",
    stage: "planning",
    status,
    title: "Original app",
    updatedAtEpochMs: 1000,
    version: 2,
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
    clientRequestId: "authority-start",
    operationId: "authority-start",
  });
  const authoritySource = { ...source };
  Reflect.deleteProperty(authoritySource, "nativeRecoveryBinding");
  Reflect.deleteProperty(authoritySource, "parentSessionId");
  const authority = durableHostedSessionRecordSchema.parse({
    ...authoritySource,
    adapterGeneration: 1,
    adapterSessionId: logical,
    checkpoint: authorityCheckpoint,
    checkpointDigest: hostedSessionCheckpointDigest(authorityCheckpoint),
    checkpointProgressDigest: hostedSessionCheckpointProgressDigest(authorityCheckpoint),
    originAdapterSessionId: logical,
    resumability: "live",
    sessionId: "public-authority",
    status: "waiting",
  });
  await store.reserveOperation(principal, authoritySeed);
  await store.settleSucceeded({
    nowEpochMs: 1000,
    operationId: authoritySeed.operationId,
    principal,
    requestDigest: authoritySeed.requestDigest,
    result: { cursor: 0, events: [], sessionId: authority.sessionId, status: "waiting" },
    session: authority,
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
    clientRequestId: "previous-recovery",
    nativeRecovery: previousDescriptor,
    operationId: previousDescriptor.operationId,
    resumeSessionId: authority.sessionId,
  });
  await store.reserveOperation(principal, previousOperation);
  await store.commitNativeRecoveryReceipt({
    descriptor: previousDescriptor,
    nowEpochMs: 1000,
    principal,
    recoveryBinding: previousBinding,
  });
  await store.settleSucceeded({
    nowEpochMs: 1000,
    operationId: previousOperation.operationId,
    principal,
    requestDigest: previousOperation.requestDigest,
    result: { cursor: 0, events: [], sessionId: source.sessionId, status },
    session: source,
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
    assertOwner,
    now: () => 2000,
    store: recoveryStore,
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
    fetchImplementation: async (_address, init) => {
      const payload = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(z.string().parse(init?.body)));
      return await runtime.handleTerminalRecoveryRequest(
        { auth, forwarded: true, payload, ports },
        async () => native.deps,
      );
    },
    workloadIdentity: { token: async () => "controlled-workload-token" },
  });
  let currentSnapshot = snapshot;
  const sends: string[] = [];
  const adapter: HostedEveTransport = {
    activateRecovery: nativeTransport.activateRecovery,
    cancel: async () => {
      throw new Error("Unexpected native cancellation outside recovery protocol");
    },
    get: async () => currentSnapshot,
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
            text: "Original draft is available",
            turnId: "restored-turn",
            type: "assistant.message",
          },
        ],
        nativeDeliveryState: {
          turns: [
            {
              boundary: "turn.completed",
              boundaryDeliveryIds: ["ordinary-continuation"],
              deliveryIds: ["ordinary-continuation"],
              turnId: "restored-turn",
            },
          ],
          version: 1,
        },
        status: "waiting",
      };
      return currentSnapshot;
    },
    start: nativeTransport.start,
  };
  const service = createHostedEveSessionService({
    assertNativeRecoveryOwner: assertOwner,
    assertSendDeliveryOwner: assertOwner,
    now: () => 2000,
    principal,
    store,
    transport: adapter,
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
        params: { arguments: args, name },
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
  await f.service.get({ cursor: 0, limit: 100, sessionId: child.sessionId });
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
  await f.service.get({ cursor: 0, limit: 100, sessionId: child.sessionId });
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
  const f = await fixture({ fresh: true, paginateAncestor: true, priorOwnerReview: true });
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
  await f.service.get({ cursor: 0, limit: 100, sessionId: child.sessionId });
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
  const f = await fixture({ afterCutoffReview: true, fresh: true, priorOwnerReview: true });
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
      beforeCutoffReview: kind === "superseding-review",
      fresh: true,
      malformedBeforeCutoff,
      omitPriorReview: kind === "missing-review",
      priorOwnerReview: true,
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
  const f = await fixture({ fresh: true, priorFault, priorOwnerReview: true });
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
  const f = await fixture({ fresh: true, missingCutoff: true, priorOwnerReview: true });
  await expect(f.service.start(f.request)).rejects.toThrow();
  expect(f.native.starts).toHaveLength(0);
});

it("refuses when owner membership is revoked during a predecessor page read", async () => {
  const f = await fixture({ fresh: true, paginateAncestor: true, priorOwnerReview: true });
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
    assertNativeRecoveryOwner: async () => {
      throw new Error("Foreign owner must not reach private recovery");
    },
    principal: { ...principal, ownerUserId: "foreign-owner" },
    store: f.store,
    transport: f.adapter,
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
          nowEpochMs: 2000,
          principal,
          sessionId: f.source.sessionId,
        });
      }
      return value;
    };
    await expect(f.service.start(f.request)).rejects.toThrow();
    expect(recoveredLineage).toBe(true);
    expect(f.native.starts).toHaveLength(0);
  },
);
