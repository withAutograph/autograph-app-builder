import { isDeepStrictEqual } from "node:util";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import { initialRepositoryProductionRecord } from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRecord,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type {
  RepositoryProductionSetupPorts,
  RepositoryProductionStore,
} from "./repository-production-setup";
import { sameRepositoryProductionSetupEffects } from "./repository-production-intent";

/** Approval retention is itself serialized with signup and People effects on the same app. */
export const retainRepositoryProductionApproval = async (input: {
  scope: RepositoryProductionScope;
  intent: RepositoryProductionIntent;
  ownerContext: OperatorOwnerContext;
  approval: NonNullable<RepositoryProductionRecord["approval"]>;
  store: RepositoryProductionStore;
  /** Authorizes the newly observed human approval while retaining the ordinary physical app lease. */
  withLease: RepositoryProductionSetupPorts["withLease"];
  assertNoPendingAccess: (
    scope: RepositoryProductionScope,
    assertFence: () => Promise<void>,
  ) => Promise<void>;
}) => {
  if (input.approval.planDigest !== repositoryProductionApprovalDigest(input.scope, input.intent)) {
    throw new Error("repository_production_approval_required");
  }
  await input.withLease(input.scope, async (assertCurrent) => {
    await assertCurrent();
    const row =
      (await input.store.read(input.scope)) ??
      (await input.store.reserve(initialRepositoryProductionRecord(input.scope, input.intent)));
    if (!isDeepStrictEqual(row.record.scope, input.scope)) {
      throw new Error("repository_production_scope_denied");
    }
    const changedEffects = !sameRepositoryProductionSetupEffects(row.record.intent, input.intent);
    if (changedEffects) {
      const pending =
        row.record.creatorRoleUpdate?.state === "pending" ||
        row.record.appAccessUpgrade?.state === "pending" ||
        Object.values(row.record.effects).some((effect) => effect.state === "pending");
      if (pending) {
        throw new Error("repository_production_reconciliation_required");
      }
    }
    if (changedEffects || row.record.approval?.planDigest !== input.approval.planDigest) {
      await input.assertNoPendingAccess(input.scope, assertCurrent);
    }
    await assertCurrent();
    const saved = await input.store.compareAndSet(row, {
      ...row.record,
      ownerContext: input.ownerContext,
      creatorOwnerContext: row.record.creatorOwnerContext ?? input.ownerContext,
      approval: input.approval,
    });
    if (!saved) {
      throw new Error("repository_production_conflict");
    }
    await assertCurrent();
  });
};
