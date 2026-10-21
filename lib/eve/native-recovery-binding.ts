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
} from "./native-recovery-contract";
import type { NativeRecoveryBinding, NativeRecoveryDescriptor } from "./native-recovery-contract";
import { createPostgresHostedEveStore } from "./postgres-hosted-store";
import { assertNativeRecoverySourceBinding, toDurableHostedSessionRecord } from "./hosted-store";
import type { HostedEveStore, HostedOperationRecord } from "./hosted-store";
import type { HostedPrincipal } from "./hosted-auth";

interface RecoveryCall {
  auth: unknown;
  descriptor: NativeRecoveryDescriptor;
}

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
    return { operation, principal };
  };

  return {
    async authorize(call: RecoveryCall): Promise<void> {
      await authorize(call);
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
    authorize: (call: RecoveryCall) => get().authorize(call),
    readReceipt: (call: RecoveryCall) => get().readReceipt(call),
    commitReceipt: (call: RecoveryCall & { recoveryBinding: NativeRecoveryBinding }) =>
      get().commitReceipt(call),
  };
}
