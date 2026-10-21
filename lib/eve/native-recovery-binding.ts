import { authorizeRepeatablePrivateApplyCalls } from "./native-recovery-repeatable-apply";
import { observePrivateApplyRecoveryCandidate } from "./native-recovery-apply-observation";
import { openHostedPostgresDatabase } from "../db/hosted-postgres";
import {
  exactForwardedSessionAuthority,
  sourceHandoffIdForSessionAuth,
} from "../hosted/session-authority";
import { assertHostedBuildDecisionOwner } from "./approved-build-owner";
import { requireHostedOperationScope } from "./hosted-auth";
import {
  nativeRecoveryBindingSchema,
  nativeRecoveryDescriptorSchema,
  sameNativeRecoveryDescriptor,
} from "./native-recovery-contract";
import type { NativeRecoveryBinding, NativeRecoveryDescriptor } from "./native-recovery-contract";
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

interface RecoveryHolderCall extends RecoveryCall {
  holderOwnerRunId: string;
  holderDescriptor: NativeRecoveryDescriptor;
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

  return {
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
    observeRecoveryHolderBinding: (call: RecoveryHolderCall) =>
      get().observeRecoveryHolderBinding(call),
    authorizeRepeatableRecoveryCalls: (
      input: Parameters<typeof authorizeRepeatablePrivateApplyCalls>[0],
    ) => Promise.resolve(authorizeRepeatablePrivateApplyCalls(input)),
    observeCandidateFacts: (input: Parameters<typeof observePrivateApplyRecoveryCandidate>[0]) =>
      Promise.resolve(observePrivateApplyRecoveryCandidate(input)),
    authorize: (call: RecoveryCall) => get().authorize(call),
    authorizeActivation: (call: RecoveryCall) => get().authorizeActivation(call),
    readReceipt: (call: RecoveryCall) => get().readReceipt(call),
    commitReceipt: (call: RecoveryCall & { recoveryBinding: NativeRecoveryBinding }) =>
      get().commitReceipt(call),
  };
}
