import { createHash } from "node:crypto";
import { tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { assertNativeRecoverySourceBinding, toDurableHostedSessionRecord } from "./hosted-store";
import type { HostedEveStore, HostedOperationRecord } from "./hosted-store";
import type { HostedEveTransport } from "./hosted-service";
import type { assertHostedBuildDecisionOwner } from "./approved-build-owner";

// This bounds diagnostic memory only. Eviction never denies or changes a Builder operation.
const observations = new Map<string, { expiresAt: number; completion: Promise<void> }>();
const OBSERVATION_REUSE_MS = 60_000;
const OBSERVATION_CACHE_ENTRIES = 128;

/** Inspect an unknown recovery through its canonical reservation, without settling or activating it. */
export const observeNativeRecoveryOperation = async (input: {
  operation: HostedOperationRecord;
  principal: HostedPrincipal;
  store: Pick<HostedEveStore, "getSession">;
  transport: Pick<HostedEveTransport, "observeRecovery">;
  assertOwner: typeof assertHostedBuildDecisionOwner;
}): Promise<void> => {
  const { operation, principal } = input;
  const descriptor = operation.nativeRecovery;
  if (operation.kind !== "start" || operation.state !== "submission_unknown") {
    return;
  }
  if (
    descriptor === undefined ||
    input.transport.observeRecovery === undefined ||
    tenantKeyFor(operation.principal) !== tenantKeyFor(principal)
  ) {
    return;
  }
  const source = await input.store.getSession(principal, descriptor.sourcePublicSessionId);
  assertNativeRecoverySourceBinding(operation, source, descriptor);
  if (source === null) {
    return;
  }
  // Recheck current ownership and cancellation even when a completed diagnostic can be reused.
  await input.assertOwner(toDurableHostedSessionRecord(source));
  const expectedOwnerRunId =
    operation.nativeRecoveryReceipt?.ownerRunId ?? descriptor.sourceOwnerRunId;
  const key = createHash("sha256")
    .update(JSON.stringify([tenantKeyFor(principal), descriptor, operation.nativeRecoveryReceipt]))
    .digest("hex");
  const now = Date.now();
  const existing = observations.get(key);
  if (existing !== undefined && existing.expiresAt > now) {
    await existing.completion;
    return;
  }
  const entry = {
    expiresAt: Number.POSITIVE_INFINITY,
    completion: input.transport.observeRecovery({
      operationId: operation.operationId,
      principal,
      recovery: descriptor,
      expectedOwnerRunId,
      sourceHandoffId: source.version === 2 ? source.sourceHandoffId : undefined,
    }),
  };
  observations.set(key, entry);
  while (observations.size > OBSERVATION_CACHE_ENTRIES) {
    const oldest = observations.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    observations.delete(oldest);
  }
  try {
    await entry.completion;
    entry.expiresAt = Date.now() + OBSERVATION_REUSE_MS;
  } catch (error) {
    if (observations.get(key) === entry) {
      observations.delete(key);
    }
    throw error;
  }
};
