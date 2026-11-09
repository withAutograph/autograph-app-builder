import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppAccessError } from "../app-access/errors";
import type { AppAccessEffectContext } from "../app-access/management";
import {
  repositoryProductionOperationRef,
  repositoryProductionScopeSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import {
  repositoryProductionSignupClaimSchema,
  repositoryProductionSignupOperationRef,
  repositoryProductionSignupRecordSchema,
} from "./repository-production-signup";
import type {
  RepositoryProductionSignupRow,
  RepositoryProductionSignupStore,
} from "./repository-production-signup";
import { repositoryProductionSignupPolicySchema } from "./repository-production-signup-policy";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";
import type { createRepositoryProductionWorkers } from "./repository-production-workers";

type Json = z.infer<ReturnType<typeof z.json>>;
type Workers = Pick<
  ReturnType<typeof createRepositoryProductionWorkers>,
  "invokeAuthManagement" | "mutateAppAccess" | "inspectAppAccess"
>;
interface CancellationPorts {
  journal: RepositoryProductionSignupStore;
  readSetup: (scope: RepositoryProductionScope) => Promise<RepositoryProductionRow | undefined>;
  workers: (scope: RepositoryProductionScope) => Workers;
  realm: (scope: RepositoryProductionScope) => Json;
  builderOrigin: string;
}
interface CancellationInput {
  scope: RepositoryProductionScope;
  actorId: string;
  effect: AppAccessEffectContext;
  mode: "execute" | "reconcile";
}
type CancellationResult = "applied" | "absent" | "unknown" | undefined;
const checkpointKind = "repository-production-signup-cancellation-v1";
const targetSchema = z.strictObject({
  kind: z.literal(checkpointKind),
  operationRef: z.uuid(),
  scope: repositoryProductionScopeSchema,
  policyId: z.uuid(),
  claimId: z.uuid(),
  actorId: z.string().min(1),
  scopeDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  roles: z.array(z.string()),
});
type Target = z.infer<typeof targetSchema>;
const denied = () => new AppAccessError("app_access_denied");
const operationId = (requestId: string, step: string) => {
  const hex = createHash("sha256").update(`${requestId}:signup-cancellation:${step}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const targetFor = (input: CancellationInput, row: RepositoryProductionSignupRow): Target => ({
  kind: checkpointKind,
  operationRef: input.effect.operationRef,
  scope: input.scope,
  policyId: row.record.claim.policyId,
  claimId: row.record.claim.id,
  actorId: row.record.claim.actorId,
  scopeDigest: row.record.claim.scopeDigest,
  roles: row.record.claim.appRoles,
});
const assertRow = (input: CancellationInput, row: RepositoryProductionSignupRow) => {
  const record = repositoryProductionSignupRecordSchema.parse(row.record);
  const { claim } = record;
  if (!isDeepStrictEqual(record.scope, input.scope)) {
    throw denied();
  }
  if (
    claim.workspaceId !== input.scope.authority.workspaceId ||
    claim.appId !== input.scope.appId ||
    claim.organizationId !== input.scope.organizationId
  ) {
    throw denied();
  }
  if (
    claim.actorId !== input.actorId ||
    claim.policyId !== repositoryProductionOperationRef(input.scope) ||
    row.operationRef !== repositoryProductionSignupOperationRef(claim.policyId, claim.id)
  ) {
    throw denied();
  }
  if (
    record.cancellation !== undefined &&
    !isDeepStrictEqual(record.cancellation, {
      operationRef: input.effect.operationRef,
      actorId: input.actorId,
      scopeDigest: claim.scopeDigest,
      roles: claim.appRoles,
    })
  ) {
    throw denied();
  }
};
const retainedTarget = (input: CancellationInput) => {
  let target: Target | undefined;
  for (const frame of input.effect.readCheckpoints()) {
    const kind = z.object({ kind: z.string() }).safeParse(frame);
    if (!kind.success || kind.data.kind !== checkpointKind) {
      continue;
    }
    const parsed = targetSchema.safeParse(frame);
    if (!parsed.success || (target !== undefined && !isDeepStrictEqual(target, parsed.data))) {
      throw denied();
    }
    target = parsed.data;
  }
  if (
    target !== undefined &&
    (target.operationRef !== input.effect.operationRef ||
      target.actorId !== input.actorId ||
      !isDeepStrictEqual(target.scope, input.scope))
  ) {
    throw denied();
  }
  return target;
};

/** An explicitly authorized People removal closes a retained signup without replaying its grant. */
export const createRepositoryProductionSignupCancellation = (ports: CancellationPorts) => ({
  async cancel(input: CancellationInput): Promise<CancellationResult> {
    repositoryProductionScopeSchema.parse(input.scope);
    z.uuid().parse(input.effect.operationRef);
    await input.effect.assertCurrent();
    const saved = retainedTarget(input);
    let row: RepositoryProductionSignupRow | undefined;
    if (saved === undefined) {
      const pending = await ports.journal.pending(input.scope);
      const matches = pending.filter(
        (candidate) => candidate.record.claim.actorId === input.actorId,
      );
      if (matches.length > 1) {
        throw denied();
      }
      [row] = matches;
      if (row === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Only no pending signup permits ordinary member removal to handle the actor.
        return undefined;
      }
    } else {
      row = await ports.journal.read(input.scope, saved.claimId);
      if (row === undefined) {
        throw denied();
      }
    }
    assertRow(input, row);
    const target = targetFor(input, row);
    if (saved !== undefined && !isDeepStrictEqual(saved, target)) {
      throw denied();
    }
    if (
      input.mode === "reconcile" &&
      (saved === undefined || row.record.cancellation === undefined)
    ) {
      return "absent";
    }
    const setup = await ports.readSetup(input.scope);
    if (!setup?.record.lease || !isDeepStrictEqual(setup.record.scope, input.scope)) {
      throw denied();
    }
    const policy = repositoryProductionSignupPolicySchema.parse(
      setup.record.effects["signup-policy"].receipt,
    );
    if (
      policy.policyId !== target.policyId ||
      policy.workspaceId !== input.scope.authority.workspaceId ||
      policy.resourceDigest !== row.record.claim.resourceDigest
    ) {
      throw denied();
    }
    if (
      policy.appId !== input.scope.appId ||
      policy.organizationId !== input.scope.organizationId ||
      policy.origin !== input.scope.publicOrigin
    ) {
      throw denied();
    }
    if (
      policy.storage !== setup.record.intent.storage.kind ||
      (policy.storage === "postgres" && setup.record.resource === undefined)
    ) {
      throw denied();
    }
    const { lease } = setup.record;
    let currentRow: RepositoryProductionSignupRow = row;
    const context = (step: string): RepositoryProductionEffectContext => {
      const id = operationId(input.effect.operationRef, step);
      return {
        row: {
          ...setup,
          operationRef: id,
          record: {
            ...setup.record,
            effects: {
              ...setup.record.effects,
              "creator-access": { state: "pending", attemptId: id },
            },
          },
        },
        effect: "creator-access",
        assertCurrent: input.effect.assertCurrent,
        checkpoint: input.effect.checkpoint,
      };
    };
    const auth = async (request: Json, readOnly: boolean, step: string) => {
      await input.effect.assertCurrent();
      const result = await ports.workers(input.scope).invokeAuthManagement(
        context(step),
        {
          version: 1,
          realm: ports.realm(input.scope),
          builderOrigin: ports.builderOrigin,
          scope: { appId: input.scope.appId, organizationId: input.scope.organizationId },
          request,
        },
        readOnly,
      );
      await input.effect.assertCurrent();
      return z.object({ result: z.json() }).parse(result).result;
    };
    const access = { actorId: target.actorId, roles: target.roles, active: false };
    const inspect = async (): Promise<"applied" | "absent" | "unknown"> => {
      let raw: Json;
      try {
        raw = await auth(
          { action: "read-signup", policyId: target.policyId, claimId: target.claimId },
          true,
          "read-claim",
        );
      } catch {
        return "unknown";
      }
      const observed = repositoryProductionSignupClaimSchema.parse(raw);
      if (
        !isDeepStrictEqual(
          repositoryProductionSignupRecordSchema.shape.claim.parse(observed),
          currentRow.record.claim,
        )
      ) {
        throw denied();
      }
      const fence = observed.accessRevocation?.fenceGeneration;
      if (
        observed.accessState === "changed" ||
        (fence !== undefined && fence > lease.fenceGeneration)
      ) {
        return "unknown";
      }
      if (policy.storage === "postgres") {
        await input.effect.assertCurrent();
        let result: Awaited<ReturnType<Workers["inspectAppAccess"]>>;
        try {
          result = await ports
            .workers(input.scope)
            .inspectAppAccess(context("generic-revoke"), access);
        } catch {
          return "unknown";
        }
        await input.effect.assertCurrent();
        if (result.state === "unknown") {
          return "unknown";
        }
        if (result.state === "not-applied") {
          return "absent";
        }
      }
      return observed.accessState === "revoked" && fence === lease.fenceGeneration
        ? "applied"
        : "absent";
    };
    const settle = async (): Promise<"applied" | "unknown"> => {
      await input.effect.assertCurrent();
      if (currentRow.record.stage !== "rejected") {
        const next = await ports.journal.compareAndSet(currentRow, {
          ...currentRow.record,
          stage: "rejected",
        });
        if (next === undefined) {
          return "unknown";
        }
        currentRow = next;
      }
      await input.effect.assertCurrent();
      return "applied";
    };
    if (input.mode === "execute") {
      if (saved === undefined) {
        await input.effect.checkpoint(target);
      }
      if (currentRow.record.cancellation === undefined) {
        await input.effect.assertCurrent();
        const next = await ports.journal.compareAndSet(currentRow, {
          ...currentRow.record,
          stage: "cancel-pending",
          cancellation: {
            operationRef: input.effect.operationRef,
            actorId: target.actorId,
            scopeDigest: target.scopeDigest,
            roles: target.roles,
          },
        });
        if (next === undefined) {
          return "unknown";
        }
        currentRow = next;
      }
    }
    const before = await inspect();
    if (before === "applied") {
      return await settle();
    }
    if (input.mode === "reconcile" || before === "unknown") {
      return before;
    }
    // Generic cleanup closes admission and role bindings together. Frontend apps use Auth alone.
    try {
      if (policy.storage === "postgres") {
        await input.effect.assertCurrent();
        await ports.workers(input.scope).mutateAppAccess(context("generic-revoke"), access);
      } else {
        await auth({ action: "set-access", ...access }, false, "auth-revoke");
      }
    } catch {
      return "unknown";
    }
    return (await inspect()) === "applied" ? await settle() : "unknown";
  },
});
