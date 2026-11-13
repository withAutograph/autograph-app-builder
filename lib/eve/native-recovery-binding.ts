import { authorizeRepeatablePrivateApplyCalls } from "./native-recovery-repeatable-apply";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { authorizeRepeatableDraftReconciliationCalls } from "./native-recovery-repeatable-draft-reconciliation";
import { observePrivateApplyRecoveryCandidate } from "./native-recovery-apply-observation";
import { verifySettledGitHubDelivery } from "./native-recovery-github-delivery-witness";
import {
  draftReviewedLineageContextKey,
  draftReviewedWorkflowContextKey,
  maySearchPreviousDraftReviews,
  recoverPreviousDraftReview,
  recoverDraftReviewedLineage,
  samePersistedDraftReview,
} from "./native-recovery-draft-reviewed-lineage";
import { openHostedPostgresDatabase } from "../db/hosted-postgres";
import type { AppBuilderWorkflowState } from "../agent/workflow-state";
import {
  exactForwardedSessionAuthority,
  sourceHandoffIdForSessionAuth,
} from "../hosted/session-authority";
import { assertHostedBuildDecisionOwner } from "./approved-build-owner";
import { requireHostedOperationScope, tenantKeyFor } from "./hosted-auth";
import {
  assertNativeRecoveryReceipt,
  nativeRecoveryBindingSchema,
  nativeSourceObservationSchema,
  nativeRecoveryDescriptorSchema,
  sameNativeRecoveryDescriptor,
} from "./native-recovery-contract";
import type {
  NativeRecoveryBinding,
  NativeRecoveryDescriptor,
  NativeSourceObservation,
} from "./native-recovery-contract";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";
import {
  assertNativeRecoverySourceBinding,
  assertRecoveredBuildContinuationChild,
  toDurableHostedSessionRecord,
} from "./hosted-store";
import type { HostedEveStore, HostedOperationRecord, HostedSessionRecord } from "./hosted-store";
import type { HostedPrincipal } from "./hosted-auth";

interface RecoveryCall {
  auth: unknown;
  descriptor: NativeRecoveryDescriptor;
}

const workflowPhases: Record<AppBuilderWorkflowState["phase"], true> = {
  empty: true,
  prepared: true,
  ui_previewed: true,
  ui_accepted: true,
  app_spec_accepted: true,
  dependencies_prepared: true,
  identity_resolved: true,
  planned: true,
  apply_failed: true,
  applied: true,
  validation_pending: true,
  validation_failed: true,
  validated: true,
  reviewed: true,
  publication_pending: true,
  publication_failed: true,
  published_local: true,
  branch_publication_pending: true,
  branch_publication_failed: true,
  published_branch_worktree: true,
  fresh_bootstrap_pending: true,
  fresh_bootstrap_failed: true,
  published_fresh_bootstrap: true,
};

interface RecoveryPredecessorWindow {
  ownerRunId: string;
  logicalSessionId: string;
  cutoff: NativeRecoveryBinding["provenance"];
  authorizeRead: () => Promise<void>;
}

interface HistoricalReviewCheckpoint {
  runIndex: number;
  origin: { eventId: string; stepId: string; slot: number };
  value: unknown;
}

interface RecoveryPredecessorEdge {
  childSessionId: string;
  binding: NativeRecoveryBinding;
}

interface RecoveryHolderCall extends RecoveryCall {
  holderOwnerRunId: string;
  holderDescriptor: NativeRecoveryDescriptor;
}

interface RecoveryHolderClosureCall extends RecoveryHolderCall {
  holderHookId: string;
}

interface RecoveryHolderClosureAuthorization {
  kind: "immutable-loser";
  winnerOwnerRunId: string;
}

interface RecoveryHolderFacts {
  operationFound: boolean | null;
  descriptorMatches: boolean | null;
  sourceBound: boolean | null;
  operationSucceeded: boolean | null;
  operationReserved: boolean | null;
  operationSubmissionUnknown: boolean | null;
  operationRejected: boolean | null;
  sourceCancelled: boolean | null;
  sourceCancellationMatches: boolean | null;
  receiptPresent: boolean | null;
  receiptOwnerMatches: boolean | null;
  committedChildMatches: boolean | null;
}

const holderCancellationMatches = (
  source: HostedSessionRecord,
  descriptor: NativeRecoveryDescriptor,
): boolean | null =>
  source.version === 2
    ? (source.cancellationRevision ?? 0) === descriptor.parentCancellationRevision
    : null;

const assertUncancelledRecoveryWinner = (child: HostedSessionRecord): void => {
  const winner = toDurableHostedSessionRecord(child);
  if (
    child.status === "cancelled" ||
    (winner.cancellationRevision ?? 0) !== (winner.resumedCancellationRevision ?? 0)
  ) {
    throw new Error("Recovery holder winner was cancelled.");
  }
};

/** The accepted trusted forwarder is the only source of public tenant authority. */
const principalFor = (call: RecoveryCall): HostedPrincipal => {
  const { principal } = exactForwardedSessionAuthority({
    current: call.auth,
    initiator: call.auth,
  });
  requireHostedOperationScope(principal, "start");
  return principal;
};

const samePrincipal = (left: HostedPrincipal, right: HostedPrincipal): boolean =>
  JSON.stringify([
    left.issuer,
    left.audience,
    left.workspaceId,
    left.ownerUserId,
    [...left.scopes].toSorted(),
  ]) ===
  JSON.stringify([
    right.issuer,
    right.audience,
    right.workspaceId,
    right.ownerUserId,
    [...right.scopes].toSorted(),
  ]);

type NativeRecoveryActivationStage =
  | "source_authorization"
  | "committed_operation"
  | "child_lookup_principal"
  | "child_receipt_authority"
  | "child_cancellation"
  | "authorized";

/** Fixed labels only: never log recovery inputs, identities, records, or thrown errors. */
const reportNativeRecoveryActivation = (stage: NativeRecoveryActivationStage): void => {
  try {
    console.info(
      JSON.stringify({
        event: "builder.native_recovery_activation",
        outcome: stage === "authorized" ? "authorized" : "failed",
        stage,
      }),
    );
  } catch {
    // Observation cannot change recovery authorization or activation.
  }
};

/** The native collector calls this before reading any private history. */
// eslint-disable-next-line eslint/func-style -- Preserve a named factory for the private channel composition boundary.
export function createNativeRecoveryBinding(input: {
  store: Pick<HostedEveStore, "getPrivateOperation" | "getSession" | "commitNativeRecoveryReceipt">;
  now?: () => number;
  assertOwner?: typeof assertHostedBuildDecisionOwner;
}) {
  const authorize = async (
    call: RecoveryCall,
  ): Promise<{
    principal: HostedPrincipal;
    operation: HostedOperationRecord;
    source: NonNullable<Awaited<ReturnType<HostedEveStore["getSession"]>>>;
  }> => {
    const descriptor = nativeRecoveryDescriptorSchema.parse(call.descriptor);
    const principal = principalFor(call);
    const handoffId = sourceHandoffIdForSessionAuth({ current: call.auth, initiator: call.auth });
    if (handoffId !== descriptor.sourceHandoffId) {
      throw new Error("Recovery handoff authority changed.");
    }
    const [operation, source] = await Promise.all([
      input.store.getPrivateOperation?.(principal, descriptor.operationId),
      input.store.getSession(principal, descriptor.sourcePublicSessionId),
    ]);
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- All five identity checks are required before private I/O.
      operation === null ||
      operation === undefined ||
      source === null ||
      !samePrincipal(operation.principal, principal) ||
      !samePrincipal(source.principal, principal)
    ) {
      throw new Error("Native recovery owner is unavailable.");
    }
    assertNativeRecoverySourceBinding(operation, source, descriptor);
    await (input.assertOwner ?? assertHostedBuildDecisionOwner)(
      toDurableHostedSessionRecord(source),
    );
    return { operation, principal, source };
  };

  const authorizeUncommittedRecovery = async (call: RecoveryCall) => {
    const current = await authorize(call);
    if (
      current.operation.state === "succeeded" ||
      current.operation.nativeRecoveryReceipt !== undefined
    ) {
      throw new Error("Current recovery already has a canonical owner.");
    }
    return current;
  };

  // Resolve the exact committed public recovery chain afresh for each private read.
  // A prior native run is authority only through its canonical succeeded child/receipt.
  const resolvePredecessorPath = async (
    call: RecoveryCall,
    path: readonly RecoveryPredecessorEdge[],
  ): Promise<HostedSessionRecord> => {
    const initial = await authorizeUncommittedRecovery(call);
    let child: HostedSessionRecord = initial.source;
    for (const edge of path) {
      if (child.version !== 2) {
        throw new Error("Recovery predecessor child changed.");
      }
      if (
        child.sessionId !== edge.childSessionId ||
        child.nativeRecoveryBinding === undefined ||
        !isDeepStrictEqual(child.nativeRecoveryBinding, edge.binding) ||
        child.parentSessionId === undefined
      ) {
        throw new Error("Recovery predecessor child changed.");
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each edge depends on the verified child of the preceding edge.
      const [parent, operation] = await Promise.all([
        input.store.getSession(initial.principal, child.parentSessionId),
        input.store.getPrivateOperation?.(initial.principal, edge.binding.operationId),
      ]);
      if (parent === null || operation === null || operation === undefined) {
        throw new Error("Recovery predecessor authority is unavailable.");
      }
      if (
        !samePrincipal(parent.principal, initial.principal) ||
        !samePrincipal(operation.principal, initial.principal)
      ) {
        throw new Error("Recovery predecessor authority is unavailable.");
      }
      assertRecoveredBuildContinuationChild(
        call.descriptor.originalAuthoritySessionId,
        call.descriptor.logicalSessionId,
        parent,
        child,
        operation,
      );
      child = parent;
    }
    await authorizeUncommittedRecovery(call);
    return child;
  };

  return {
    /** Visit only committed, owner-authorized predecessor windows, newest first. */
    async visitRecoveryPredecessors(
      call: RecoveryCall,
      visit: (window: RecoveryPredecessorWindow) => Promise<"continue" | "stop">,
    ): Promise<void> {
      const path: RecoveryPredecessorEdge[] = [];
      const seen = new Set<string>();
      let child = await resolvePredecessorPath(call, path);
      while (child.version === 2 && child.nativeRecoveryBinding !== undefined) {
        if (seen.has(child.sessionId)) {
          throw new Error("Recovery predecessor chain is cyclic.");
        }
        seen.add(child.sessionId);
        const binding = nativeRecoveryBindingSchema.parse(child.nativeRecoveryBinding);
        path.push({ childSessionId: child.sessionId, binding });
        const windowPath = [...path];
        // oxlint-disable-next-line eslint/no-await-in-loop -- Verify each lineage edge before visiting its parent.
        const parent = await resolvePredecessorPath(call, path);
        if (seen.has(parent.sessionId)) {
          throw new Error("Recovery predecessor chain is cyclic.");
        }
        const authorizeRead = async () => {
          const current = await resolvePredecessorPath(call, windowPath);
          if (
            current.sessionId !== parent.sessionId ||
            current.adapterSessionId !== parent.adapterSessionId
          ) {
            throw new Error("Recovery predecessor source changed.");
          }
        };
        // oxlint-disable-next-line eslint/no-await-in-loop -- Reauthorize this exact predecessor before its private read.
        await authorizeRead();
        // oxlint-disable-next-line eslint/no-await-in-loop -- Newer checkpoints must be exhausted before older predecessors.
        const result = await visit({
          ownerRunId: parent.adapterSessionId,
          logicalSessionId: call.descriptor.logicalSessionId,
          cutoff: binding.provenance,
          authorizeRead,
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- Reauthorize after the visitor before accepting its result.
        await authorizeRead();
        if (result === "stop") {
          return;
        }
        if (result !== "continue") {
          throw new Error("Recovery predecessor visitor returned an invalid result.");
        }
        child = parent;
      }
    },
    async authorizeSourceObservation(call: { auth: unknown; source: NativeSourceObservation }) {
      const sourceCoordinates = nativeSourceObservationSchema.parse(call.source);
      const { principal } = exactForwardedSessionAuthority({
        current: call.auth,
        initiator: call.auth,
      });
      requireHostedOperationScope(principal, "get");
      const source = await input.store.getSession(
        principal,
        sourceCoordinates.sourcePublicSessionId,
      );
      if (source === null || tenantKeyFor(source.principal) !== tenantKeyFor(principal)) {
        throw new Error("Native source observation unavailable.");
      }
      const durable = toDurableHostedSessionRecord(source);
      if (durable.sessionId !== sourceCoordinates.sourcePublicSessionId) {
        throw new Error("Native source observation session changed.");
      }
      if (
        durable.adapterSessionId !== sourceCoordinates.sourceAdapterSessionId ||
        durable.adapterGeneration !== sourceCoordinates.sourceAdapterGeneration ||
        (durable.cancellationRevision ?? 0) !== sourceCoordinates.cancellationRevision
      ) {
        throw new Error("Native source observation changed.");
      }
      const handoffId = sourceHandoffIdForSessionAuth({ current: call.auth, initiator: call.auth });
      if (handoffId !== durable.sourceHandoffId) {
        throw new Error("Native source observation handoff changed.");
      }
      await (input.assertOwner ?? assertHostedBuildDecisionOwner)(durable);
      return {
        ownerRunId: durable.adapterSessionId,
        logicalSessionId:
          durable.nativeRecoveryBinding?.logicalSessionId ?? durable.adapterSessionId,
      };
    },
    /** Positive immutable-winner proof, freshly re-read before each native closure effect. */
    async authorizeRecoveryHolderClosure(
      call: RecoveryHolderClosureCall,
    ): Promise<RecoveryHolderClosureAuthorization> {
      const { principal } = await authorizeUncommittedRecovery(call);
      const holder = nativeRecoveryDescriptorSchema.parse(call.holderDescriptor);
      if (
        holder.logicalSessionId !== call.descriptor.logicalSessionId ||
        holder.originalAuthoritySessionId !== call.descriptor.originalAuthoritySessionId ||
        call.holderOwnerRunId.length === 0 ||
        call.holderHookId.length === 0
      ) {
        throw new Error("Recovery holder closure lineage is unavailable.");
      }
      const operation = await input.store.getPrivateOperation?.(principal, holder.operationId);
      if (
        operation === null ||
        operation === undefined ||
        !samePrincipal(operation.principal, principal)
      ) {
        throw new Error("Recovery holder has no canonical succeeded operation.");
      }
      if (
        operation.kind !== "start" ||
        operation.state !== "succeeded" ||
        operation.nativeRecovery === undefined ||
        !sameNativeRecoveryDescriptor(operation.nativeRecovery, holder)
      ) {
        throw new Error("Recovery holder has no canonical succeeded operation.");
      }
      const receipt = nativeRecoveryBindingSchema.parse(operation.nativeRecoveryReceipt);
      assertNativeRecoveryReceipt(holder, receipt);
      if (receipt.ownerRunId === call.holderOwnerRunId) {
        throw new Error("A canonical recovery owner cannot be closed as a contender.");
      }
      const [source, child] = await Promise.all([
        input.store.getSession(principal, holder.sourcePublicSessionId),
        input.store.getSession(principal, operation.sessionId),
      ]);
      if (
        source === null ||
        child === null ||
        !samePrincipal(source.principal, principal) ||
        !samePrincipal(child.principal, principal)
      ) {
        throw new Error("Recovery holder winner lineage is unavailable.");
      }
      assertRecoveredBuildContinuationChild(
        holder.originalAuthoritySessionId,
        holder.logicalSessionId,
        source,
        child,
        operation,
      );
      assertUncancelledRecoveryWinner(child);
      await authorizeUncommittedRecovery(call);
      return { kind: "immutable-loser", winnerOwnerRunId: receipt.ownerRunId };
    },
    /** Retained native entry IDs select only same-principal reads, never recovery authority. */
    async observeRecoveryHolderBinding(call: RecoveryHolderCall): Promise<RecoveryHolderFacts> {
      const { principal } = await authorize(call);
      const holder = nativeRecoveryDescriptorSchema.parse(call.holderDescriptor);
      if (
        holder.logicalSessionId !== call.descriptor.logicalSessionId ||
        holder.originalAuthoritySessionId !== call.descriptor.originalAuthoritySessionId
      ) {
        throw new Error("Recovery holder lineage differs from current authority.");
      }
      const facts: RecoveryHolderFacts = {
        operationFound: false,
        descriptorMatches: null,
        sourceBound: null,
        operationSucceeded: null,
        operationReserved: null,
        operationSubmissionUnknown: null,
        operationRejected: null,
        sourceCancelled: null,
        sourceCancellationMatches: null,
        receiptPresent: null,
        receiptOwnerMatches: null,
        committedChildMatches: null,
      };
      const operation = await input.store.getPrivateOperation?.(principal, holder.operationId);
      if (
        operation === null ||
        operation === undefined ||
        !samePrincipal(operation.principal, principal)
      ) {
        return facts;
      }
      facts.operationFound = true;
      const retained = operation.nativeRecovery;
      facts.descriptorMatches =
        retained !== undefined && sameNativeRecoveryDescriptor(holder, retained);
      facts.operationSucceeded = operation.state === "succeeded";
      facts.operationReserved = operation.state === "reserved";
      facts.operationSubmissionUnknown = operation.state === "submission_unknown";
      facts.operationRejected = operation.state === "rejected";
      if (!facts.descriptorMatches) {
        return facts;
      }
      const source = await input.store.getSession(principal, holder.sourcePublicSessionId);
      facts.sourceBound = false;
      if (source !== null && samePrincipal(source.principal, principal)) {
        facts.sourceCancelled = source.status === "cancelled";
        facts.sourceCancellationMatches = holderCancellationMatches(source, holder);
        try {
          assertNativeRecoverySourceBinding(operation, source, holder);
          facts.sourceBound = true;
        } catch {
          // A stale holder source is a fact, not permission to cancel or reclaim it.
        }
      }
      const parsedReceipt = nativeRecoveryBindingSchema.safeParse(operation.nativeRecoveryReceipt);
      facts.receiptPresent = operation.nativeRecoveryReceipt !== undefined;
      if (parsedReceipt.success) {
        const { ownerRunId, provenance: _provenance, ...receiptDescriptor } = parsedReceipt.data;
        void _provenance;
        facts.receiptOwnerMatches =
          ownerRunId === call.holderOwnerRunId &&
          sameNativeRecoveryDescriptor(holder, receiptDescriptor);
      }
      if (operation.state === "succeeded" && facts.receiptOwnerMatches === true) {
        const child = await input.store.getSession(principal, operation.sessionId);
        facts.committedChildMatches = false;
        if (child !== null && samePrincipal(child.principal, principal)) {
          try {
            assertRecoveredBuildContinuationChild(
              holder.originalAuthoritySessionId,
              holder.logicalSessionId,
              source,
              child,
              operation,
            );
            facts.committedChildMatches = true;
          } catch {
            // A canonical receipt alone does not prove a current committed public child.
          }
        }
      }
      return facts;
    },
    async authorize(call: RecoveryCall): Promise<void> {
      await authorize(call);
    },
    async authorizeActivation(call: RecoveryCall): Promise<void> {
      let stage: NativeRecoveryActivationStage = "source_authorization";
      try {
        const { operation, principal, source } = await authorize(call);
        stage = "committed_operation";
        if (operation.state !== "succeeded" || operation.kind !== "start") {
          throw new Error("Recovery public child is not committed.");
        }
        stage = "child_lookup_principal";
        const child = await input.store.getSession(principal, operation.sessionId);
        if (child === null || !samePrincipal(child.principal, principal)) {
          throw new Error("Recovery public child is unavailable.");
        }
        stage = "child_receipt_authority";
        assertRecoveredBuildContinuationChild(
          call.descriptor.originalAuthoritySessionId,
          call.descriptor.logicalSessionId,
          source,
          child,
          operation,
        );
        stage = "child_cancellation";
        const durableChild = toDurableHostedSessionRecord(child);
        if (
          child.status === "cancelled" ||
          (durableChild.cancellationRevision ?? 0) !==
            (durableChild.resumedCancellationRevision ?? 0)
        ) {
          throw new Error("Recovery public child was cancelled.");
        }
        stage = "authorized";
      } finally {
        reportNativeRecoveryActivation(stage);
      }
    },
    async readReceipt(call: RecoveryCall): Promise<NativeRecoveryBinding | null> {
      const { operation } = await authorize(call);
      return operation.nativeRecoveryReceipt === undefined
        ? null
        : nativeRecoveryBindingSchema.parse(operation.nativeRecoveryReceipt);
    },
    async commitReceipt(
      call: RecoveryCall & { recoveryBinding: NativeRecoveryBinding },
    ): Promise<NativeRecoveryBinding> {
      const { principal } = await authorize(call);
      if (input.store.commitNativeRecoveryReceipt === undefined) {
        throw new Error("Native recovery receipt storage is unavailable.");
      }
      return await input.store.commitNativeRecoveryReceipt({
        descriptor: nativeRecoveryDescriptorSchema.parse(call.descriptor),
        nowEpochMs: (input.now ?? Date.now)(),
        principal,
        recoveryBinding: nativeRecoveryBindingSchema.parse(call.recoveryBinding),
      });
    },
  };
}

/** Build the same native review hook for hosted and controlled public-entrypoint tests. */
// eslint-disable-next-line eslint/func-style -- The named factory is a shared dependency-injection boundary.
export function createNativeDraftReviewedLineageRecovery(
  authorize: (call: RecoveryCall) => Promise<void>,
) {
  return {
    contextKey: draftReviewedLineageContextKey,
    field: "reviewedLineage",
    historicalContextKey: draftReviewedWorkflowContextKey,
    async recover(
      call: Parameters<typeof recoverDraftReviewedLineage>[0] &
        RecoveryCall & {
          visitHistoricalCheckpoints?: (
            visit: (checkpoint: HistoricalReviewCheckpoint) => Promise<"continue" | "stop">,
          ) => Promise<void>;
        },
    ) {
      await authorize(call);
      let lineage = recoverDraftReviewedLineage(call);
      if (
        lineage === undefined &&
        call.visitHistoricalCheckpoints !== undefined &&
        maySearchPreviousDraftReviews(call)
      ) {
        let found: HistoricalReviewCheckpoint | undefined;
        let conflicting = false;
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
        await call.visitHistoricalCheckpoints((checkpoint) => {
          const { value } = checkpoint;
          const phase = z.object({ phase: z.string() }).safeParse(value);
          if (!phase.success || !Object.hasOwn(workflowPhases, phase.data.phase)) {
            conflicting = true;
            return Promise.resolve("stop" as const);
          }
          if (phase.data.phase !== "reviewed") {
            return Promise.resolve("continue" as const);
          }
          if (found === undefined) {
            found = checkpoint;
            lineage = recoverPreviousDraftReview(call, value);
          } else if (
            found.runIndex !== checkpoint.runIndex ||
            found.origin.slot !== checkpoint.origin.slot ||
            !samePersistedDraftReview(found.value, value)
          ) {
            conflicting = true;
          }
          // A newer incompatible review supersedes every older review, even when invalid.
          return Promise.resolve("stop" as const);
        });
        if (conflicting) {
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- Preserve the existing explicit undefined value.
          lineage = undefined;
        }
      }
      await authorize(call);
      return lineage;
    },
  };
}

/** Channel construction opens no provider connection. The first trusted recovery request composes the store. */
// eslint-disable-next-line eslint/func-style -- Preserve a named factory for the hosted channel boundary.
export function createHostedNativeRecoveryBinding(
  environment: Readonly<Record<string, string | undefined>>,
) {
  let binding: ReturnType<typeof createNativeRecoveryBinding> | undefined;
  const get = (): ReturnType<typeof createNativeRecoveryBinding> => {
    binding ??= createNativeRecoveryBinding({
      store: createPostgresHostedEveStore(
        openHostedPostgresDatabase(environment.DATABASE_URL ?? ""),
      ),
    });
    return binding;
  };
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    authorizeSourceObservation: (call: { auth: unknown; source: NativeSourceObservation }) =>
      get().authorizeSourceObservation(call),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    authorizeRecoveryHolderClosure: (call: RecoveryHolderClosureCall) =>
      get().authorizeRecoveryHolderClosure(call),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    observeRecoveryHolderBinding: (call: RecoveryHolderCall) =>
      get().observeRecoveryHolderBinding(call),
    verifyCancelledWorkflowEffects: async (
      input: Parameters<typeof verifySettledGitHubDelivery>[0] & RecoveryCall,
    ) =>
      await Promise.resolve(
        verifySettledGitHubDelivery(input, {
          ...principalFor(input),
          sourceOwnerRunId: input.descriptor.sourceOwnerRunId,
          sourceAdapterGeneration: input.descriptor.sourceAdapterGeneration,
          parentCancellationRevision: input.descriptor.parentCancellationRevision,
        }),
      ),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    authorizeRepeatableRecoveryCalls: (
      input: Parameters<typeof authorizeRepeatablePrivateApplyCalls>[0] & RecoveryCall,
    ) =>
      Promise.resolve([
        ...authorizeRepeatablePrivateApplyCalls(input),
        ...authorizeRepeatableDraftReconciliationCalls({
          ...input,
          expectedPrincipalId: principalFor(input).ownerUserId,
        }),
      ]),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    applicationStateRecovery: createNativeDraftReviewedLineageRecovery((call) =>
      get().authorize(call),
    ),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    observeCandidateFacts: (input: Parameters<typeof observePrivateApplyRecoveryCandidate>[0]) =>
      Promise.resolve(observePrivateApplyRecoveryCandidate(input)),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    authorize: (call: RecoveryCall) => get().authorize(call),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    visitRecoveryPredecessors: (
      call: RecoveryCall,
      visit: (window: RecoveryPredecessorWindow) => Promise<"continue" | "stop">,
    ) => get().visitRecoveryPredecessors(call, visit),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    authorizeActivation: (call: RecoveryCall) => get().authorizeActivation(call),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    readReceipt: (call: RecoveryCall) => get().readReceipt(call),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    commitReceipt: (call: RecoveryCall & { recoveryBinding: NativeRecoveryBinding }) =>
      get().commitReceipt(call),
  };
}
